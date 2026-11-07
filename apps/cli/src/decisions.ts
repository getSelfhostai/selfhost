import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  DecisionInputError,
  type DecisionPage,
  type Ledger,
  normalizeDecisionPath,
  openLedger,
  type RecordedDecision,
  recordDecision,
  renderDecision,
  renderDecisions,
} from "@selfhost/ledger";
import {
  type CreateDecisionRequest,
  type CreateDecisionResponse,
  type DecisionsPage,
  PERSON_VERDICTS,
  type PersonVerdict,
} from "@selfhost/schema";
import type { Command } from "commander";
import { defaultPerson } from "./import.js";
import { repoDir } from "./scan/index.js";
import { readMembership } from "./team/config.js";

export interface DecisionsIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  now?: Date;
  /** Where the team membership is kept; a joined person decides under that id. */
  configPath?: string;
}

interface LedgerOptions {
  database?: string;
  dataDir?: string;
}

export interface DecideOptions extends LedgerOptions {
  reason?: string;
  question?: string;
  path?: string[];
  rule?: string;
  pr?: string;
  replaces?: string;
  person?: string;
  json?: boolean;
}

/** `selfhost decide --json`: the POST /v1/decisions response body with a schema tag. */
export interface DecideReport extends CreateDecisionResponse {
  schema: "selfhost.decide/v1";
}

/** `selfhost decisions --json`: the GET /v1/decisions page with a schema tag. */
export interface DecisionsReport extends DecisionsPage {
  schema: "selfhost.decisions/v1";
}

export interface DecisionsOptions extends LedgerOptions {
  path?: string;
  topic?: string;
  rule?: string;
  person?: string;
  limit?: string;
  cursor?: string;
  json?: boolean;
}

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** CLI flags for the fields a decision error names. */
const FLAGS: Record<string, string> = {
  by: "--person",
  reason: "--reason",
  question: "--question",
  paths: "--path",
  rule_id: "--rule",
  pr_url: "--pr",
  replaces_event_id: "--replaces",
};

/**
 * Who is deciding: --person, then the person this laptop joined a team as, then
 * SELFHOST_PERSON, then the git email of the repository in `dir`, then the OS user name.
 */
export function decider(person: string | undefined, io: DecisionsIo, dir: string): string {
  const membership = io.configPath ? readMembership(io.configPath) : undefined;
  return person ?? membership?.person ?? defaultPerson(io.env, dir);
}

/** A path as decisions store it: relative to the repository root when it is inside one. */
export function repoPath(path: string, cwd: string): string {
  const root = repoDir(undefined, cwd);
  if (root) {
    const rel = relative(root, resolve(cwd, path));
    if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return rel.split(sep).join("/");
    }
  }
  return normalizeDecisionPath(path);
}

function parseVerdict(value: string): PersonVerdict {
  const verdict = value.trim().toLowerCase();
  if (!(PERSON_VERDICTS as readonly string[]).includes(verdict)) {
    throw new Error(`Expected a verdict of approve, deny, answer or override, got "${value}"`);
  }
  return verdict as PersonVerdict;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim())) throw new Error(`--limit: expected a number, got "${value}"`);
  return Number(value);
}

/** Records through recordDecision, naming the CLI flag when the decision is invalid. */
export async function recordFromCli(
  ledger: Ledger,
  input: CreateDecisionRequest,
  now: Date | undefined,
): Promise<RecordedDecision> {
  try {
    return await recordDecision(ledger, input, { source: "cli", now });
  } catch (error) {
    if (!(error instanceof DecisionInputError)) throw error;
    const [first] = error.errors;
    const field = first?.field.replace(/\[\d+\]$/, "") ?? "";
    throw new Error(`${FLAGS[field] ?? field}: ${first?.message ?? "Invalid decision"}`);
  }
}

async function withLedger<T>(
  options: LedgerOptions,
  io: DecisionsIo,
  ledger: Ledger | undefined,
  fn: (ledger: Ledger) => Promise<T>,
): Promise<T> {
  const target =
    ledger ??
    (await openLedger({ url: options.database ?? io.env.DATABASE_URL, dataDir: options.dataDir }));
  try {
    return await fn(target);
  } finally {
    if (!ledger) await target.close();
  }
}

/**
 * `selfhost decide <item-or-run> <verdict>`: one decision from the command line, the CLI inbox's
 * write. A UUIDv7 is a review item id, anything else a run id. Pass a ledger to reuse an open one.
 */
export async function runDecide(
  target: string,
  verdict: string,
  options: DecideOptions,
  io: DecisionsIo,
  ledger?: Ledger,
): Promise<RecordedDecision> {
  const subject = target.trim();
  if (subject === "") throw new Error("Expected a review item id or a run id");
  const input: CreateDecisionRequest = {
    verdict: parseVerdict(verdict),
    by: decider(options.person, io, io.cwd),
    ...(UUIDV7.test(subject) ? { item_id: subject.toLowerCase() } : { run_id: subject }),
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    ...(options.question !== undefined ? { question: options.question } : {}),
    ...(options.rule !== undefined ? { rule_id: options.rule } : {}),
    ...(options.pr !== undefined ? { pr_url: options.pr } : {}),
    ...(options.replaces !== undefined ? { replaces_event_id: options.replaces } : {}),
    ...(options.path?.length ? { paths: options.path.map((p) => repoPath(p, io.cwd)) } : {}),
    surface: "cli",
  };
  return withLedger(options, io, ledger, async (open) => {
    const recorded = await recordFromCli(open, input, io.now);
    if (options.json) {
      const report: DecideReport = {
        schema: "selfhost.decide/v1",
        decision_event: recorded.event,
        duplicate: recorded.duplicate,
      };
      io.write(JSON.stringify(report, null, 2));
    } else {
      io.write(`Recorded decision ${recorded.event.id}.`);
      io.write("");
      io.write(renderDecision(recorded.event));
    }
    return recorded;
  });
}

/** `selfhost decisions`: past decisions and rule verdicts, newest first. */
export async function runDecisions(
  options: DecisionsOptions,
  io: DecisionsIo,
  ledger?: Ledger,
): Promise<DecisionPage> {
  const query = {
    ...(options.path !== undefined ? { path: repoPath(options.path, io.cwd) } : {}),
    ...(options.topic !== undefined ? { topic: options.topic } : {}),
    ...(options.rule !== undefined ? { rule_id: options.rule } : {}),
    ...(options.person !== undefined ? { person: options.person } : {}),
    ...(options.limit !== undefined ? { limit: parseLimit(options.limit) } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
  };
  return withLedger(options, io, ledger, async (open) => {
    const page = await open.decisions.search(query);
    if (options.json) {
      const report: DecisionsReport = {
        schema: "selfhost.decisions/v1",
        decisions: page.events,
        next_cursor: page.nextCursor ?? null,
      };
      io.write(JSON.stringify(report, null, 2));
    } else {
      io.write(renderDecisions(page));
    }
    return page;
  });
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

export function registerDecisions(
  program: Command,
  io: () => DecisionsIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  program
    .command("decisions")
    .description("search past human decisions and rule verdicts by file path or topic")
    .option("--path <path>", "a file or folder; matches decisions on it, inside it or around it")
    .option("--topic <words>", "words that must all appear in the question or reason")
    .option("--rule <id>", "only decisions about this rule")
    .option("--person <id>", "only decisions by this person")
    .option("--limit <n>", "at most this many, newest first (default 100)")
    .option("--cursor <cursor>", "next_cursor from the previous page")
    .option("--json", "print the page as JSON")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .action(async (options: DecisionsOptions) => {
      try {
        await runDecisions(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });

  program
    .command("decide")
    .description("record your decision on a review item or run: approve, deny, answer or override")
    .argument("<item-or-run>", "review item id, or run id")
    .argument("<verdict>", "approve, deny, answer or override")
    .option("--reason <text>", "why, in your own words; for a question, the answer")
    .option("--question <text>", "what was asked, in one line")
    .option("--path <file>", "a file the decision is about, repeatable", collect)
    .option("--rule <id>", "rule from selfhost.toml it is about")
    .option("--pr <url>", "pull request it is about")
    .option("--replaces <decision-id>", "decision this one corrects or overturns")
    .option("--person <id>", "who decides (default: team person, else git email)")
    .option("--json", "print the recorded event as JSON")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .action(async (target: string, verdict: string, options: DecideOptions) => {
      try {
        await runDecide(target, verdict, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
