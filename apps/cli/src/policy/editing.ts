import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { promisify } from "node:util";
import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  formatConfigError,
  type LedgerEvent,
  parseConfig,
  type ReviewItem,
  RULE_MODES,
  type Rule,
  type RuleMode,
} from "@selfhost/schema";
import type { Command } from "commander";
import { type ConfigLocation, findConfig } from "../find-config.js";
import { parseSince } from "../import.js";
import { promoteRule } from "./promote.js";
import { buildPolicyReport, reportWindow } from "./report.js";

const run = promisify(execFile);
const PAGE = 1000;

export interface PolicyIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  now?: Date;
  /** ~/.selfhost/config.json; in a team, its pulled policy is used when the repo has none. */
  configPath?: string;
}

export interface PromoteCommandOptions {
  team?: string;
  to?: string;
  config?: string;
  json?: boolean;
}

/** `selfhost policy promote --json`. */
export interface PromoteReport {
  schema: "selfhost.policy_promote/v1";
  config: string;
  rule: string;
  team: string | null;
  from: RuleMode;
  to: RuleMode;
  changed: boolean;
  /** `git diff` of the file after the change; null when nothing changed or there is no git. */
  diff: string | null;
}

export interface PolicyReportCommandOptions {
  since?: string;
  config?: string;
  json?: boolean;
  database?: string;
  dataDir?: string;
}

export function parseMode(value: string | undefined): RuleMode {
  const mode = (value ?? "enforce").trim().toLowerCase();
  if (!(RULE_MODES as readonly string[]).includes(mode)) {
    throw new Error(`--to: expected enforce, observe or off, got "${value}"`);
  }
  return mode as RuleMode;
}

function locateConfig(io: PolicyIo, flag: string | undefined): ConfigLocation {
  const location = findConfig(io.cwd, flag, io.env, io.configPath);
  if (!location) {
    throw new Error(
      "No selfhost.toml found from this directory up to the repository root. Pass --config <path>.",
    );
  }
  if (!existsSync(location.path)) throw new Error(`${location.path} does not exist`);
  return location;
}

/** The pulled team policy is a copy: the next sync replaces it, so it is never edited here. */
function refuseTeamPolicy(location: ConfigLocation): void {
  const team = location.teamPolicy;
  if (location.from !== "team" || !team) return;
  throw new Error(
    `${location.path} is the policy of team ${team.team}, pulled from ${team.server}, and the next sync replaces it. ` +
      "Change the team policy where it is kept: in the team's repository, or on the server (PUT /v1/policy, by a team owner or admin). " +
      "To change rules for this repository only, add a selfhost.toml here.",
  );
}

/** The working-copy diff of one file, or undefined outside a git repository. */
async function gitDiff(file: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(
      "git",
      ["--no-pager", "diff", "--no-color", "--no-ext-diff", "--", basename(file)],
      { cwd: dirname(file) },
    );
    return stdout;
  } catch {
    return undefined;
  }
}

/**
 * Writes the new mode into selfhost.toml and prints the file's git diff. Nothing is staged or
 * committed: the change goes through review like any other edit.
 */
export async function runPromote(
  ruleId: string,
  options: PromoteCommandOptions,
  io: PolicyIo,
): Promise<PromoteReport> {
  const to = parseMode(options.to);
  const location = locateConfig(io, options.config);
  refuseTeamPolicy(location);
  const { path } = location;
  const result = promoteRule(readFileSync(path, "utf8"), ruleId, { team: options.team, to });
  const file = relative(io.cwd, path) || path;
  const who = options.team ? `Rule ${ruleId} for team ${options.team}` : `Rule ${ruleId}`;
  const report: PromoteReport = {
    schema: "selfhost.policy_promote/v1",
    config: path,
    rule: ruleId,
    team: options.team ?? null,
    from: result.from,
    to,
    changed: result.changed,
    diff: null,
  };
  if (!result.changed) {
    if (options.json) io.write(JSON.stringify(report, null, 2));
    else io.write(`${who} is already in ${to} mode in ${file}. Nothing changed.`);
    return report;
  }
  writeFileSync(path, result.text);
  const diff = await gitDiff(path);
  report.diff = diff ?? null;
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return report;
  }
  io.write(`${who}: ${result.from} to ${to} in ${file}, line ${result.line}.`);
  if (diff === undefined) {
    io.write("Not in a git repository, so there is no diff to show.");
  } else if (diff === "") {
    io.write(`${file} is not tracked by git yet, so there is no diff to show.`);
  } else {
    io.write("");
    io.write(diff.trimEnd());
    io.write("");
    io.write("Review the change and commit it through a pull request.");
  }
  return report;
}

/** The rules in selfhost.toml, when one is found. An invalid file is an error. */
function readRules(io: PolicyIo, flag: string | undefined): { rules: Rule[]; path: string } | null {
  const location = findConfig(io.cwd, flag, io.env, io.configPath);
  if (!location) return null;
  if (!existsSync(location.path)) {
    if (location.from === "search") return null;
    throw new Error(`${location.path} does not exist`);
  }
  const file =
    location.from === "team" ? location.path : relative(io.cwd, location.path) || location.path;
  const result = parseConfig(readFileSync(location.path, "utf8"));
  if (!result.ok) {
    const errors = result.errors.map((error) => `  ${formatConfigError(error, file)}`);
    throw new Error([`${file} is not valid:`, ...errors].join("\n"));
  }
  return { rules: result.config.rules, path: file };
}

async function evaluatedEvents(ledger: Ledger, since: Date, until: Date): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await ledger.query({
      kind: "policy.evaluated",
      from: since.toISOString(),
      to: until.toISOString(),
      limit: PAGE,
      cursor,
    });
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return events;
}

/**
 * Reads the observe-mode policy.evaluated events for whole UTC days from --since through today
 * and builds the policy_report review item. Pass a ledger to reuse an open one.
 */
export async function runPolicyReport(
  options: PolicyReportCommandOptions,
  io: PolicyIo,
  ledger?: Ledger,
): Promise<ReviewItem> {
  const now = io.now ?? new Date();
  const window = reportWindow(parseSince(options.since ?? "7d", now) ?? now, now);
  const policy = readRules(io, options.config);
  const target =
    ledger ??
    (await openLedger({ url: options.database ?? io.env.DATABASE_URL, dataDir: options.dataDir }));
  try {
    const events = await evaluatedEvents(target, window.since, window.until);
    const item = buildPolicyReport(events, {
      ...window,
      now,
      rules: policy?.rules,
      policyPath: policy?.path,
    });
    if (options.json) {
      io.write(JSON.stringify(item, null, 2));
    } else {
      io.write(item.title);
      io.write("");
      for (const line of (item.brief ?? "").split("\n")) io.write(line);
    }
    return item;
  } finally {
    if (!ledger) await target.close();
  }
}

/** Adds `policy promote` and `policy report`, creating the `policy` group if it is not there. */
export function registerPolicyEditing(
  program: Command,
  io: () => PolicyIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const policy =
    program.commands.find((c) => c.name() === "policy") ??
    program.command("policy").description("check and observe the rules in selfhost.toml");

  policy
    .command("promote")
    .description("change a rule's mode in selfhost.toml (default: enforce) and show the git diff")
    .argument("<rule>", "rule id from selfhost.toml")
    .option("--team <name>", "set the mode only for this team, in [teams.<name>.rules.<rule>]")
    .option("--to <mode>", "enforce, observe or off", "enforce")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--json", "print JSON")
    .action(async (rule: string, options: PromoteCommandOptions) => {
      try {
        await runPromote(rule, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });

  policy
    .command("report")
    .description(
      "what each rule in observe mode would have blocked, with likely false positives marked",
    )
    .option("--since <when>", "how far back to read, like 7d or a date (whole UTC days)", "7d")
    .option("-c, --config <path>", "path to selfhost.toml, for the false positive checks")
    .option("--json", "print the selfhost.review_item/v1 policy_report as JSON")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .action(async (options: PolicyReportCommandOptions) => {
      try {
        await runPolicyReport(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
