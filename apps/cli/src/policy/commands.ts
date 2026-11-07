import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  evaluate,
  mcpServerOf,
  normalizePath,
  type ObservedRule,
  observeLedger,
  type PolicyHit,
  policyChecks,
  policySource,
  type ToolCall,
} from "@selfhost/policy";
import {
  AGENT_VENDORS,
  type AgentVendor,
  type ConfigResult,
  formatConfigError,
  parseConfig,
  type ResolvedSelfhostConfig,
  type RuleAction,
  type RuleMode,
} from "@selfhost/schema";
import type { Command } from "commander";
import {
  type ConfigLocation,
  describeConfigSource,
  findConfig,
  type TeamPolicyFile,
} from "../find-config.js";
import { plural, table } from "../format.js";
import { describeTarget, parseSince } from "../import.js";
import { repoDir } from "../scan/index.js";

export interface PolicyIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  setExitCode: (code: number) => void;
  now?: Date;
  /** ~/.selfhost/config.json; in a team, its pulled policy is used when the repo has none. */
  configPath?: string;
}

interface JsonOption {
  json?: boolean;
}

interface ConfigOption {
  /** Path to selfhost.toml. Default: SELFHOST_CONFIG, then the nearest file up to the repo root. */
  config?: string;
}

/** One rule or allow-list check in a report. */
export interface PolicyCheckLine {
  rule_id: string;
  mode: RuleMode;
  action: RuleAction;
}

/** `selfhost policy check --json`. */
export interface PolicyCheckReport {
  schema: "selfhost.policy_check/v1";
  path: string;
  /** team: no selfhost.toml was found, so the policy pulled from the team server is checked. */
  from: ConfigLocation["from"];
  /** The pulled team policy on this machine, also when another file is checked instead. */
  team_policy: TeamPolicyFile | null;
  valid: boolean;
  errors: { field: string; line: number | null; message: string }[];
  /** Every rule and allow-list check in evaluation order; empty when the file is invalid. */
  checks: PolicyCheckLine[];
}

/** `selfhost policy test --json`. */
export interface PolicyTestReport {
  schema: "selfhost.policy_test/v1";
  config: string;
  team: string | null;
  call: ToolCall;
  hits: PolicyHit[];
}

/** `selfhost policy observe --json`. */
export interface PolicyObserveReport {
  schema: "selfhost.policy_observe/v1";
  config: string;
  repo: string;
  /** Start of the window, or null for the whole ledger. */
  since: string | null;
  team: string | null;
  policy: { commit: string | null; hash: string; dirty: boolean };
  /** Where the events went: "Postgres (DATABASE_URL)" or the embedded ledger folder. */
  ledger: string;
  tool_calls: number;
  evaluated: number;
  recorded: number;
  duplicates: number;
  rules: ObservedRule[];
}

const AGENT_ALIASES: Record<string, AgentVendor> = {
  claude: "claude_code",
  "claude-code": "claude_code",
};

export function parseAgent(value: string | undefined): AgentVendor | undefined {
  if (value === undefined) return undefined;
  const name = value.trim().toLowerCase();
  const vendor =
    AGENT_ALIASES[name] ?? AGENT_VENDORS.find((candidate) => candidate === name.replace("-", "_"));
  if (!vendor) {
    throw new Error(
      `--agent: expected claude or one of ${AGENT_VENDORS.join(", ")}, got "${value}"`,
    );
  }
  return vendor;
}

const shown = (cwd: string, path: string) => relative(cwd, path) || path;

/** Finds selfhost.toml the way `selfhost doctor` does and parses it. */
function readPolicy(
  cwd: string,
  flag: string | undefined,
  io: Pick<PolicyIo, "env" | "configPath">,
): { location: ConfigLocation; result: ConfigResult } {
  const location = findConfig(cwd, flag, io.env, io.configPath);
  if (!location) {
    throw new Error(
      "No selfhost.toml found (searched from this directory up to the repository root). Pass --config.",
    );
  }
  if (!existsSync(location.path)) throw new Error(`${location.path} does not exist`);
  return { location, result: parseConfig(readFileSync(location.path, "utf8")) };
}

/** The resolved policy, or an error listing every problem as file:line: field: message. */
function loadPolicy(
  cwd: string,
  flag: string | undefined,
  io: PolicyIo,
): { location: ConfigLocation; config: ResolvedSelfhostConfig } {
  const { location, result } = readPolicy(cwd, flag, io);
  if (!result.ok) {
    const file = shown(io.cwd, location.path);
    const lines = result.errors.map((error) => `  ${formatConfigError(error, file)}`);
    throw new Error([`${file} is invalid. Run selfhost policy check.`, ...lines].join("\n"));
  }
  return { location, config: result.config };
}

function checkTeam(config: ResolvedSelfhostConfig, team: string | undefined): void {
  if (team === undefined || Object.hasOwn(config.teams, team)) return;
  const known = Object.keys(config.teams);
  throw new Error(
    `--team: "${team}" has no [teams.${team}] table in selfhost.toml` +
      (known.length > 0 ? ` (teams: ${known.join(", ")})` : ""),
  );
}

const checkLines = (config: ResolvedSelfhostConfig): PolicyCheckLine[] =>
  policyChecks(config).map((check) => ({
    rule_id: check.id,
    mode: check.mode,
    action: check.action,
  }));

/** Validates selfhost.toml and returns the exit code: 1 when it is invalid. */
export function policyCheck(options: ConfigOption & JsonOption, io: PolicyIo): number {
  const { location, result } = readPolicy(io.cwd, options.config, io);
  const report: PolicyCheckReport = {
    schema: "selfhost.policy_check/v1",
    path: location.path,
    from: location.from,
    team_policy: location.teamPolicy ?? null,
    valid: result.ok,
    errors: result.ok
      ? []
      : result.errors.map(({ field, line, message }) => ({
          field,
          line: line ?? null,
          message,
        })),
    checks: result.ok ? checkLines(result.config) : [],
  };
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return report.valid ? 0 : 1;
  }
  const file = shown(io.cwd, location.path);
  const source = describeConfigSource(location, file);
  if (source) io.write(source);
  if (!result.ok) {
    io.write(`${file}: invalid, ${plural(result.errors.length, "error")}`);
    for (const error of result.errors) io.write(formatConfigError(error, file));
    return 1;
  }
  const count = (mode: RuleMode) => report.checks.filter((check) => check.mode === mode).length;
  io.write(
    `${file}: valid, ${plural(report.checks.length, "check")} ` +
      `(${count("enforce")} enforce, ${count("observe")} observe, ${count("off")} off)`,
  );
  if (report.checks.length > 0) {
    table(
      report.checks.map((check) => [`  ${check.rule_id}`, check.mode, check.action]),
      io.write,
    );
  }
  return 0;
}

export interface PolicyTestOptions extends ConfigOption, JsonOption {
  tool: string;
  command?: string;
  path?: string;
  url?: string;
  model?: string;
  agent?: string;
  team?: string;
}

/** Evaluates one hypothetical tool call and prints the rules that fire. */
export function policyTest(options: PolicyTestOptions, io: PolicyIo): PolicyTestReport {
  const { location, config } = loadPolicy(io.cwd, options.config, io);
  checkTeam(config, options.team);
  const agent = parseAgent(options.agent);
  const mcpServer = mcpServerOf(options.tool);
  const call: ToolCall = {
    ...(agent ? { agent } : {}),
    tool: options.tool,
    ...(options.command !== undefined ? { command: options.command } : {}),
    ...(options.path !== undefined ? { path: normalizePath(options.path) } : {}),
    ...(options.url !== undefined ? { url: options.url } : {}),
    ...(mcpServer !== undefined ? { mcpServer } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
  };
  const hits = evaluate(config, call, { team: options.team });
  const report: PolicyTestReport = {
    schema: "selfhost.policy_test/v1",
    config: location.path,
    team: options.team ?? null,
    call,
    hits,
  };
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
  } else if (hits.length === 0) {
    io.write("No rule fires.");
  } else {
    io.write(`${plural(hits.length, "rule")} fire${hits.length === 1 ? "s" : ""}:`);
    table(
      hits.map((hit) => [`  ${hit.rule_id}`, hit.mode, hit.verdict, hit.message]),
      io.write,
    );
  }
  return report;
}

export interface PolicyObserveOptions extends ConfigOption, JsonOption {
  since?: string;
  repo?: string;
  team?: string;
  database?: string;
  dataDir?: string;
}

function printObserve(report: PolicyObserveReport, io: PolicyIo): void {
  const commit = report.policy.commit
    ? `commit ${report.policy.commit.slice(0, 12)}${report.policy.dirty ? " with uncommitted changes" : ""}`
    : "not committed";
  const since = report.since ? ` since ${report.since.slice(0, 10)}` : "";
  io.write(
    `Evaluated ${plural(report.evaluated, "tool call")} from ${report.repo} ` +
      `(${report.tool_calls} in the ledger${since}) against ${shown(io.cwd, report.config)} (${commit}).`,
  );
  if (report.rules.length > 0) {
    table(
      [
        ["rule", "mode", "action", "new", "already recorded"],
        ...report.rules.map((rule) => [
          rule.rule_id,
          rule.mode,
          rule.action,
          String(rule.recorded),
          String(rule.duplicates),
        ]),
      ],
      io.write,
      2,
    );
  }
  io.write(
    `Recorded ${report.recorded} new policy.evaluated events (${report.duplicates} already in the ledger).`,
  );
  io.write("Nothing was stopped: observe only records what each rule would have done.");
  io.write(`Ledger: ${report.ledger}`);
}

/**
 * Evaluates the tool calls already in the ledger against selfhost.toml and records one
 * policy.evaluated event per hit. Pass a ledger to reuse an open one.
 */
export async function policyObserve(
  options: PolicyObserveOptions,
  io: PolicyIo,
  ledger?: Ledger,
): Promise<PolicyObserveReport> {
  const now = io.now ?? new Date();
  const since = parseSince(options.since ?? "30d", now);
  const repo = options.repo === undefined ? undefined : repoDir(options.repo, io.cwd);
  const flag = options.config === undefined ? undefined : resolve(io.cwd, options.config);
  const { location, config } = loadPolicy(repo ?? io.cwd, flag, io);
  checkTeam(config, options.team);
  const repoRoot = repo ?? repoDir(undefined, io.cwd) ?? dirname(location.path);
  const source = await policySource(location.path);
  const target =
    ledger ??
    (await openLedger({ url: options.database ?? io.env.DATABASE_URL, dataDir: options.dataDir }));
  try {
    const result = await observeLedger(target, config, source, {
      since,
      repoRoot,
      team: options.team,
      now,
    });
    const report: PolicyObserveReport = {
      schema: "selfhost.policy_observe/v1",
      config: location.path,
      repo: repoRoot,
      since: since?.toISOString() ?? null,
      team: options.team ?? null,
      policy: { commit: source.commit ?? null, hash: source.hash, dirty: source.dirty },
      ledger: describeTarget({ database: options.database, dataDir: options.dataDir }, io),
      ...result,
    };
    if (options.json) io.write(JSON.stringify(report, null, 2));
    else printObserve(report, io);
    return report;
  } finally {
    if (!ledger) await target.close();
  }
}

export function registerPolicy(
  program: Command,
  io: () => PolicyIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const policy =
    program.commands.find((command) => command.name() === "policy") ??
    program.command("policy").description("check and observe the rules in selfhost.toml");

  policy
    .command("check")
    .description("validate selfhost.toml; exits 1 and names file:line: field for each error")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--json", "print JSON")
    .action((options: ConfigOption & JsonOption) => {
      const deps = io();
      try {
        deps.setExitCode(policyCheck(options, deps));
      } catch (error) {
        fail(error, options.json);
      }
    });

  policy
    .command("test")
    .description("evaluate one tool call against selfhost.toml and print the rules that fire")
    .requiredOption("--tool <name>", "tool name, like Bash, exec_command or mcp__github__get_issue")
    .option("--command <command>", "shell command")
    .option("--path <path>", "file path relative to the repository root")
    .option("--url <url>", "URL the agent requests")
    .option("--model <id>", "model id")
    .option("--agent <name>", "claude, codex, opencode, goose, cursor, copilot or other")
    .option("--team <name>", "apply this team's overrides")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--json", "print JSON")
    .action((options: PolicyTestOptions) => {
      try {
        policyTest(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });

  policy
    .command("observe")
    .description(
      "evaluate the tool calls in the ledger and record what each rule would have blocked",
    )
    .option("--since <when>", "how far back to read, like 30d, 12h or a date", "30d")
    .option("--repo <dir>", "repository the tool calls must belong to (default: the one here)")
    .option("--team <name>", "apply this team's overrides")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option("--json", "print JSON")
    .action(async (options: PolicyObserveOptions) => {
      try {
        await policyObserve(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
