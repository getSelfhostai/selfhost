import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { guardrailChecks } from "@selfhost/policy";
import {
  formatConfigError,
  parseConfig,
  type ResolvedSelfhostConfig,
  validateConfig,
} from "@selfhost/schema";
import { type ConfigLocation, findConfig, type TeamPolicyFile } from "./find-config.js";

export interface DoctorOptions {
  cwd: string;
  config?: string;
  env: NodeJS.ProcessEnv;
  version: string;
  write: (line: string) => void;
  json?: boolean;
  /** ~/.selfhost/config.json; in a team, its pulled policy is used when the repo has none. */
  configPath?: string;
  /** Finds a program on PATH, to check the hooks' `selfhost` is there. */
  which?: (name: string) => string | undefined;
}

/** `selfhost doctor --json`. */
export interface DoctorReport {
  schema: "selfhost.doctor/v1";
  version: string;
  runtime: { node: string; bun: string | null; platform: string; arch: string };
  /** null when no selfhost.toml was found. */
  config: {
    path: string;
    /** team: no selfhost.toml was found, so the policy pulled from the team server is used. */
    from: ConfigLocation["from"];
    /** The pulled team policy on this machine, also when another file is used instead. */
    team_policy: TeamPolicyFile | null;
    exists: boolean;
    /** null when the file does not exist. */
    valid: boolean | null;
    rules: number;
    enforced: number;
    errors: { field: string; line: number | null; message: string }[];
  } | null;
  /**
   * The built-in guardrails the hooks apply here, from selfhost.toml or the defaults: they
   * block whatever the rules' modes are.
   */
  guardrails: { mode: string; enforced: string[]; observed: string[] };
  /** Whether `selfhost` is on PATH, as the hooks call it; null when it was not looked up. */
  on_path: boolean | null;
}

/** Which guardrails enforce and which only record, under a config. */
function guardrailModes(config: ResolvedSelfhostConfig): DoctorReport["guardrails"] {
  const checks = guardrailChecks(config);
  return {
    mode: config.guardrails.mode,
    enforced: checks.filter((check) => check.mode === "enforce").map((check) => check.id),
    observed: checks.filter((check) => check.mode === "observe").map((check) => check.id),
  };
}

function defaultGuardrails(): DoctorReport["guardrails"] {
  const result = validateConfig({ version: 1 });
  if (!result.ok) throw new Error("the built-in default policy does not validate");
  return guardrailModes(result.config);
}

export function doctorReport({
  cwd,
  config,
  env,
  version,
  configPath,
  which,
}: DoctorOptions): DoctorReport {
  const report: DoctorReport = {
    schema: "selfhost.doctor/v1",
    version,
    runtime: {
      node: process.version,
      bun: process.versions.bun ?? null,
      platform: process.platform,
      arch: process.arch,
    },
    config: null,
    guardrails: defaultGuardrails(),
    on_path: which ? which("selfhost") !== undefined : null,
  };
  const location = findConfig(cwd, config, env, configPath);
  if (!location) return report;
  const base = {
    path: location.path,
    from: location.from,
    team_policy: location.teamPolicy ?? null,
  };
  if (!existsSync(location.path)) {
    report.config = { ...base, exists: false, valid: null, rules: 0, enforced: 0, errors: [] };
    return report;
  }
  const result = parseConfig(readFileSync(location.path, "utf8"));
  if (result.ok) {
    const { rules } = result.config;
    const enforced = rules.filter((rule) => rule.mode === "enforce").length;
    report.guardrails = guardrailModes(result.config);
    report.config = {
      ...base,
      exists: true,
      valid: true,
      rules: rules.length,
      enforced,
      errors: [],
    };
  } else {
    const errors = result.errors.map(({ field, line, message }) => ({
      field,
      line: line ?? null,
      message,
    }));
    report.config = { ...base, exists: true, valid: false, rules: 0, enforced: 0, errors };
  }
  return report;
}

/** Prints the local setup and returns the process exit code. */
export function doctor(options: DoctorOptions): number {
  const report = doctorReport(options);
  const failed = report.config !== null && report.config.valid !== true;
  if (options.json) {
    options.write(JSON.stringify(report, null, 2));
    return failed ? 1 : 0;
  }
  const { write, cwd } = options;
  const row = (label: string, value: string) => write(`${label.padEnd(9)}${value}`);
  const { runtime, config } = report;
  write(`selfhost ${report.version}`);
  const bun = runtime.bun ? `, bun ${runtime.bun}` : "";
  row("runtime", `node ${runtime.node} (${runtime.platform} ${runtime.arch}${bun})`);
  if (report.on_path === false) {
    row(
      "path",
      "selfhost is not on PATH: hooks written by selfhost init look for it each time they run, and compiled hooks need it. Install it with npm install -g selfhostai.",
    );
  }
  const guards = report.guardrails;
  const guardsRow = () =>
    row(
      "guards",
      guards.enforced.length > 0
        ? `${guards.enforced.length} guardrails block in every hook: ${guards.enforced.join(", ")}${guards.observed.length > 0 ? `; ${guards.observed.length} only record` : ""}`
        : guards.observed.length > 0
          ? `${guards.observed.length} guardrails only record ([guardrails] mode = "observe"); none block`
          : "the guardrails are off",
    );
  if (!config) {
    row("config", "no selfhost.toml found (searched from this directory up to the repo root)");
    guardsRow();
    return 0;
  }
  if (!config.exists) {
    const source = config.from === "flag" ? "--config" : "SELFHOST_CONFIG";
    row("config", `${config.path} (from ${source}) does not exist`);
    return 1;
  }
  const team = config.team_policy;
  if (team && config.from === "team") {
    row("config", `${config.path} (team ${team.team} from ${team.server}, no selfhost.toml here)`);
  } else {
    row("config", config.path);
    if (team) row("team", `${team.path} from ${team.server} is not used while this file exists`);
  }
  if (config.valid) {
    row(
      "status",
      `valid, ${config.rules} rules (${config.enforced} enforced, ${config.rules - config.enforced} observe or off)`,
    );
    guardsRow();
    return 0;
  }
  row("status", `invalid, ${config.errors.length} error(s)`);
  const file = relative(cwd, config.path) || config.path;
  for (const error of config.errors) {
    write(`  ${formatConfigError({ ...error, line: error.line ?? undefined }, file)}`);
  }
  return 1;
}
