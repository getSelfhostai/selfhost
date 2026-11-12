import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEvent } from "@selfhost/schema";
import { gitBranchAt } from "./branch.js";
import {
  DROPPED_FIELDS,
  failOpenText,
  HOOK_AGENTS,
  type HookAgent,
  isPreToolEvent,
  otherEventText,
} from "./vendors.js";

/**
 * `selfhost hook <agent>`: runs inside the agent on every hook event, so it does little. It
 * appends the payload to a spool file with a single write and exits 0, whatever happens.
 * `selfhost import` maps the spool into the ledger later. The ledger is never opened here:
 * the embedded database allows one process at a time, and agents run hooks concurrently.
 *
 * Pre-tool events also get an answer: pretool.ts checks the call against selfhost.toml and the
 * built-in guardrails and prints allow, deny or ask in the agent's format. Only those events
 * load it, so every other event starts as fast as before.
 *
 * Keep this module free of workspace imports: main.ts loads it alone, for a quick start.
 */

export { HOOK_AGENTS, type HookAgent } from "./vendors.js";

/** One hit as the spool keeps it. */
export interface GuardHit {
  rule_id: string;
  mode: "observe" | "enforce";
  verdict: "block" | "ask";
  message: string;
  /** What the agent was told to do instead. */
  alternative?: string;
  irreversible: boolean;
  /** For egress.allow: the hosts outside the list. */
  hosts?: string[];
}

/**
 * The one-time exception on a blocked call: the review item the agent and the person were told
 * to approve, or, with `used`, the approved exception that let this call through.
 */
export interface GuardException {
  /** Review item id: a request's, or the approved one's. */
  id: string;
  /** Keyed hash of the call; see hooks/exceptions.ts. Set on a request. */
  fingerprint?: string;
  /** Rule ids the exception covers. */
  rules: string[];
  used?: boolean;
  /** Who approved it and the decision.recorded event, when used. */
  approved_by?: string;
  decision_event_id?: string;
}

/** What the pre-tool check decided, kept on the event's spool line for the ledger. */
export interface GuardRecord {
  /** What the agent was told. An ask the agent cannot put to a person is answered deny. */
  answer: "allow" | "deny" | "ask";
  /** The hit behind the answer; for allow, the first observe hit, if any. */
  hit?: GuardHit;
  /** Every rule, guardrail and checker that fired, in order. */
  hits: Pick<GuardHit, "rule_id" | "mode" | "verdict">[];
  /** The selfhost.toml used, if any: absolute path and SHA-256 of its bytes. */
  policy?: { path: string; hash: string };
  /** Why the check fell back: an invalid policy file, a checker that failed or timed out. */
  failures?: string[];
  /** The check itself failed, so the call was allowed. */
  fail_open?: boolean;
  /** A blocked call's exception request, or the approved exception that allowed it. */
  exception?: GuardException;
  /** Time the check took, in milliseconds. */
  ms: number;
  /** Where the agent ran: laptop, local:<sandbox> or runtime:<kind> (see executionLocation). */
  location?: string;
}

/** One line of a spool file. */
export interface SpoolLine {
  agent: HookAgent;
  received_at: string;
  payload: unknown;
  /** Set on pre-tool events. */
  guard?: GuardRecord;
  /**
   * The pull request a shell call opened or pushed to, read from its output before the output
   * is dropped: the run's link to it (see pullRequestUrl).
   */
  pr_url?: string;
  /** The git branch at the payload's cwd when the hook ran, for presence (selfhost who). */
  branch?: string;
  /** The [agents.<name>] the hook ran for, from SELFHOST_AGENT_NAME: the events' actor. */
  named_agent?: string;
}

/** NAMED_AGENT_ENV in @selfhost/schema, spelled out: this module has no workspace imports. */
const NAMED_AGENT_ENV = "SELFHOST_AGENT_NAME";
const NAMED_AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** What the hook adds to a spool line from its environment: the branch and the named agent. */
export function spoolContext(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Pick<SpoolLine, "branch" | "named_agent"> {
  const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : undefined;
  const branch = cwd ? gitBranchAt(cwd) : undefined;
  const named = env[NAMED_AGENT_ENV]?.trim();
  return {
    ...(branch ? { branch } : {}),
    ...(named && NAMED_AGENT_NAME.test(named) ? { named_agent: named } : {}),
  };
}

/**
 * A line `selfhost mcp` writes while `selfhost import --watch` holds the embedded ledger: the
 * approval.requested event of an agent's question or exception request, which the watcher
 * imports with the hook lines, so the item reaches the review list and its push goes out.
 */
export interface McpSpoolLine {
  source: "mcp";
  received_at: string;
  event: LedgerEvent;
}

/** How long to wait for the payload on stdin before giving up. */
const STDIN_TIMEOUT_MS = 3000;

/**
 * `~/.selfhost/spool`, from HOME (USERPROFILE on Windows). Undefined when neither is set, so a
 * caller with an empty environment never touches a real home folder.
 */
export function spoolDir(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME || env.USERPROFILE;
  return home ? join(home, ".selfhost", "spool") : undefined;
}

/** One file per UTC day, so finished days can be removed once they are imported. */
export function spoolFile(dir: string, receivedAt: string): string {
  return join(dir, `hooks-${receivedAt.slice(0, 10)}.jsonl`);
}

export const SPOOL_FILE_PATTERN = /^hooks-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function parsePayload(text: string): Record<string, unknown> {
  const payload: unknown = JSON.parse(text);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("expected a JSON object");
  }
  return payload as Record<string, unknown>;
}

/** A pull request on github.com, as `gh pr create` prints it; not a /pull/new/ link. */
export const PULL_REQUEST_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/** Shell commands whose output names the pull request they opened or pushed to. */
const PULL_COMMAND = /\bgh\s+pr\s+create\b|\bgit\s+push\b/;

const textOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.filter((part) => typeof part === "string").join(" ")
      : "";

/**
 * The pull request a finished shell call opened, from its output: `gh pr create` prints the new
 * pull request's URL, and `git push` to a branch with one open shows it in GitHub's remote
 * message. Undefined for anything else.
 */
export function pullRequestUrl(payload: Record<string, unknown>): string | undefined {
  if (payload.hook_event_name !== "PostToolUse") return undefined;
  const input = payload.tool_input;
  const command =
    typeof input === "string"
      ? input
      : typeof input === "object" && input !== null
        ? textOf((input as Record<string, unknown>).command) ||
          textOf((input as Record<string, unknown>).cmd)
        : "";
  if (!PULL_COMMAND.test(command)) return undefined;
  const response = payload.tool_response;
  const output =
    typeof response === "object" && response !== null
      ? ["stdout", "stderr", "output"]
          .map((key) => textOf((response as Record<string, unknown>)[key]))
          .join("\n")
      : textOf(response);
  return PULL_REQUEST_URL.exec(output)?.[0];
}

/**
 * Appends one payload to the spool. Tool output and file contents (tool_response, and Cursor's
 * output and content) are replaced with null: the ledger never reads them, and they can be large
 * or hold secrets. Only the pull request URL a shell call printed is kept, as pr_url.
 */
export function appendToSpool(
  dir: string,
  agent: HookAgent,
  text: string | Record<string, unknown>,
  now = new Date(),
  guard?: GuardRecord,
  context: Pick<SpoolLine, "branch" | "named_agent"> = {},
) {
  const payload = typeof text === "string" ? parsePayload(text) : { ...text };
  const prUrl = pullRequestUrl(payload);
  for (const field of DROPPED_FIELDS) if (field in payload) payload[field] = null;
  const line: SpoolLine = {
    agent,
    received_at: now.toISOString(),
    payload,
    ...(guard ? { guard } : {}),
    ...(prUrl ? { pr_url: prUrl } : {}),
    ...context,
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(spoolFile(dir, line.received_at), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/** Appends one `selfhost mcp` event to the spool (see McpSpoolLine). */
export function appendEventToSpool(dir: string, event: LedgerEvent, now = new Date()) {
  const line: McpSpoolLine = { source: "mcp", received_at: now.toISOString(), event };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(spoolFile(dir, line.received_at), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

export interface HookIo {
  env: NodeJS.ProcessEnv;
  /** The payload agents pipe in. */
  readStdin: () => Promise<string>;
  /** The answer agents read on stdout. Default: nothing is printed. */
  writeOutput?: (text: string) => void;
  writeError: (line: string) => void;
  now?: Date;
  /** Runs the pre-tool check; tests pass one with extra checkers or a fixed clock. */
  checkPreTool?: CheckPreTool;
}

export type CheckPreTool = (
  agent: HookAgent,
  payload: Record<string, unknown>,
  io: { env: NodeJS.ProcessEnv; writeError: (line: string) => void; now?: Date },
) => Promise<{ output: string; guard?: GuardRecord }>;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Receives one hook event. Claude Code, Codex, Cursor and the OpenCode plugin pipe the payload
 * on stdin; Codex notify passes it as the last argument. Always returns 0: a failure here must
 * not stop the agent, so it is reported on stderr. A pre-tool event that cannot be checked is
 * answered allow (fail open); see pretool.ts for the cases that answer otherwise.
 */
export async function runHook(args: string[], io: HookIo): Promise<number> {
  const writeOutput = io.writeOutput ?? (() => {});
  let agent: HookAgent | undefined;
  let payload: Record<string, unknown> | undefined;
  let answered = false;
  try {
    const name = args[0] ?? "";
    agent = HOOK_AGENTS[name as keyof typeof HOOK_AGENTS];
    if (!agent) {
      throw new Error(`expected claude, codex, codex-notify, cursor or opencode, got "${name}"`);
    }
    const argument = agent === "codex-notify" && args.length > 1 ? args.at(-1) : undefined;
    const text = argument ?? (await io.readStdin());
    if (text.trim() === "") throw new Error("no payload");
    payload = parsePayload(text);
    let guard: GuardRecord | undefined;
    if (isPreToolEvent(agent, payload)) {
      const check = io.checkPreTool ?? (await import("./pretool.js")).checkPreTool;
      const result = await check(agent, payload, {
        env: io.env,
        writeError: io.writeError,
        now: io.now,
      });
      writeOutput(result.output);
      answered = true;
      guard = result.guard;
    } else {
      writeOutput(otherEventText(agent, payload));
      answered = true;
    }
    const dir = spoolDir(io.env);
    if (!dir) throw new Error("HOME is not set, so there is no ~/.selfhost/spool");
    appendToSpool(dir, agent, payload, io.now, guard, spoolContext(payload, io.env));
  } catch (error) {
    io.writeError(`selfhost hook: ${errorText(error)}`);
    if (!answered && agent && payload && isPreToolEvent(agent, payload)) {
      io.writeError("selfhost hook: the call was allowed without a check (fail open)");
      writeOutput(failOpenText(agent, payload));
      const guard: GuardRecord = {
        answer: "allow",
        hits: [],
        failures: [`internal: ${errorText(error)}`],
        fail_open: true,
        ms: 0,
      };
      try {
        const dir = spoolDir(io.env);
        if (dir) appendToSpool(dir, agent, payload, io.now, guard, spoolContext(payload, io.env));
      } catch {
        // Already reported above; the answer matters more than the record.
      }
    }
  }
  return 0;
}

/** Reads stdin to the end; "" from a terminal, and an error when nothing ends in time. */
export function readStdin(timeoutMs = STDIN_TIMEOUT_MS): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      stdin.destroy();
      reject(new Error(`stdin did not close within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    stdin.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    stdin.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Entry point for main.ts, which skips loading the rest of the command line. */
export function hookMain(args: string[]): Promise<number> {
  return runHook(args, {
    env: process.env,
    readStdin,
    writeOutput: (text) => {
      if (text !== "") process.stdout.write(`${text}\n`);
    },
    writeError: (line) => process.stderr.write(`${line}\n`),
  });
}
