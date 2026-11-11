import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { relative } from "node:path";
import { locate } from "@selfhost/agents";
import type { EnforcementReport } from "@selfhost/credentials";
import { guardrailChecks } from "@selfhost/policy";
import {
  formatConfigError,
  parseConfig,
  type ResolvedSelfhostConfig,
  validateConfig,
} from "@selfhost/schema";
import { type ConfigLocation, findConfig, policyText, type TeamPolicyFile } from "./find-config.js";
import { hookCommandPaths, userWritable } from "./hooks/hook-binary.js";
import { type ManagedHooks, managedHooks, userHookIn } from "./hooks/managed-hooks.js";
import { exceptionTrust } from "./hooks/trust.js";
import { defaultTargets, enforcementReports, reportLines } from "./runtime-check.js";

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
  /** Default: process.platform. */
  platform?: string;
  /** Read system paths (managed settings) under this folder instead; for images and tests. */
  systemRoot?: string;
  /** The home folder whose agent configs are checked. Default: the user's. */
  home?: string;
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
    /** Settings that still work but should change: a deprecated [integrations.runtime]. */
    warnings: string[];
  } | null;
  /**
   * The built-in guardrails the hooks apply here, from the policy in use (in a team, the team's
   * policy with this file on top) or the defaults: they block whatever the rules' modes are.
   */
  guardrails: { mode: string; enforced: string[]; observed: string[] };
  /** Whether `selfhost` is on PATH, as the hooks call it; null when it was not looked up. */
  on_path: boolean | null;
  /**
   * What the configured runtime and each local sandbox make of [egress] and [secrets], with the
   * rules each cannot hold. Empty without those sections.
   */
  enforcement: EnforcementReport[];
  /**
   * Fields of the repository's selfhost.toml that would relax the team policy: the hooks use
   * the team's value for each. Empty outside a team.
   */
  team_floor: { field: string; message: string }[];
  /**
   * Agents whose managed settings run selfhost's hooks, and whether the user's own config runs
   * them too (twice per event; the import counts each event once).
   */
  managed_hooks: (ManagedHooks & {
    user_config: string | null;
    /** The absolute files the managed hook command runs; empty when it goes through PATH. */
    binaries: string[];
    /** The first of those files (or a folder above one) you can write, which lets you swap it. */
    writable: string | null;
  })[];
  /**
   * How one-time exception grants are checked on this laptop: solo (the local key signs them),
   * or team with the server's keys pinned in the root-owned managed settings or in config.json.
   */
  exceptions: {
    mode: "solo" | "team";
    pinned: "managed" | "config" | "none";
    path: string | null;
    keys: number;
    warnings: string[];
  };
}

const AGENT_LABELS: Record<ManagedHooks["agent"], string> = {
  claude_code: "Claude Code",
  codex: "Codex",
};

/** Managed hooks on this machine, with the user config that also runs them, if any. */
function hookSources(options: DoctorOptions): DoctorReport["managed_hooks"] {
  const platform = options.platform ?? process.platform;
  const found = managedHooks(platform, options.systemRoot);
  if (found.length === 0) return [];
  const home = options.home ?? homedir();
  const where = locate({ home, env: options.env, platform: platform as NodeJS.Platform });
  const userConfigs: Record<ManagedHooks["agent"], string[]> = {
    claude_code: [where.claude_code.settings],
    codex: [where.codex.hooks, where.codex.config],
  };
  return found.map((entry) => {
    const binaries = managedBinaries(entry.path);
    const writable = binaries.map((path) => userWritable(path)).find((path) => path !== undefined);
    return {
      ...entry,
      user_config: userConfigs[entry.agent].find((path) => userHookIn(path, entry.agent)) ?? null,
      binaries,
      writable: isRoot() ? null : (writable ?? null),
    };
  });
}

const isRoot = () => process.getuid?.() === 0;

/**
 * The absolute files a managed settings file runs for selfhost's hook: from Claude Code's
 * "command" and Codex's command_windows, which hold the hook command as written at install.
 */
function managedBinaries(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const commands = [...text.matchAll(/"?command(?:_windows)?"?\s*[:=]\s*("(?:[^"\\]|\\.)*")/g)]
    .map((match) => {
      try {
        return JSON.parse(match[1] ?? "") as string;
      } catch {
        return "";
      }
    })
    .filter((command) => / hook /.test(` ${command} `));
  return [...new Set(commands.flatMap((command) => hookCommandPaths(command)))];
}

/** How exception grants are checked here, and what weakens it. */
function exceptionsReport(options: DoctorOptions): DoctorReport["exceptions"] {
  const platform = options.platform ?? process.platform;
  const trust = exceptionTrust(options.configPath, platform, options.systemRoot);
  const warnings: string[] = [];
  if (trust.mode === "team" && trust.source === "config") {
    warnings.push(
      `Exception grants are checked against the team server's key pinned in ${trust.path}. A coding agent running as you can write that file and pin a key of its own; install the managed settings (the admin command selfhost join or sync printed, or selfhost policy compile --managed) to pin it in a root-owned file.`,
    );
  } else if (trust.mode === "team" && trust.source === "none") {
    warnings.push(
      "No team server key is pinned yet, so no exception grant is accepted here. The next selfhost import pins it.",
    );
  }
  if (trust.source === "managed" && trust.path && !isRoot()) {
    const writable = userWritable(trust.path);
    if (writable) {
      warnings.push(
        `${trust.path} pins the team server's key, but you can write ${writable}, and so can a coding agent running as you. Install it as root with mode 0644.`,
      );
    }
  }
  return {
    mode: trust.mode,
    pinned: trust.source,
    path: trust.path ?? null,
    keys: trust.keys.length,
    warnings,
  };
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

export function doctorReport(options: DoctorOptions): DoctorReport {
  const { cwd, config, env, version, configPath, which } = options;
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
    enforcement: [],
    team_floor: [],
    managed_hooks: hookSources(options),
    exceptions: exceptionsReport(options),
  };
  const location = findConfig(cwd, config, env, configPath);
  if (!location) return report;
  const base = {
    path: location.path,
    from: location.from,
    team_policy: location.teamPolicy ?? null,
  };
  if (!existsSync(location.path)) {
    report.config = {
      ...base,
      exists: false,
      valid: null,
      rules: 0,
      enforced: 0,
      errors: [],
      warnings: [],
    };
    return report;
  }
  const result = parseConfig(readFileSync(location.path, "utf8"));
  if (result.ok) {
    // On a machine in a team, the rules in use are the team's with this file's added, and a
    // field that would relax the team's is held at the team's value, as in the hooks.
    const layered = policyText(location);
    const used = parseConfig(layered.text);
    const inUse = used.ok ? used.config : result.config;
    const { rules } = inUse;
    report.enforcement = enforcementReports(inUse, defaultTargets(inUse));
    const enforced = rules.filter((rule) => rule.mode === "enforce").length;
    report.guardrails = guardrailModes(inUse);
    report.team_floor = layered.conflicts.map(({ field, message }) => ({ field, message }));
    report.config = {
      ...base,
      exists: true,
      valid: true,
      rules: rules.length,
      enforced,
      errors: [],
      warnings: [
        ...new Set([...(result.warnings ?? []), ...(used.ok ? (used.warnings ?? []) : [])]),
      ],
    };
  } else {
    const errors = result.errors.map(({ field, line, message }) => ({
      field,
      line: line ?? null,
      message,
    }));
    report.config = {
      ...base,
      exists: true,
      valid: false,
      rules: 0,
      enforced: 0,
      errors,
      warnings: [],
    };
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
  for (const hooks of report.managed_hooks) {
    const name = AGENT_LABELS[hooks.agent];
    row(
      "hooks",
      hooks.user_config
        ? `${name} runs selfhost's hooks twice: from the managed settings at ${hooks.path} and from ${hooks.user_config}. The import counts each event once; remove the selfhost hook from ${hooks.user_config} (selfhost init --undo puts back what init changed).`
        : `${name}'s hooks come from the managed settings at ${hooks.path}; selfhost init adds no user hook for it.`,
    );
    if (hooks.binaries.length === 0) {
      row(
        "warning",
        `${hooks.path} runs selfhost through PATH, which you (and a coding agent running as you) can change. Install the managed settings again with selfhost on PATH, so they name its absolute path.`,
      );
    } else if (hooks.writable) {
      row(
        "warning",
        `${name}'s managed hook runs ${hooks.binaries.join(" ")}, and you can write ${hooks.writable}, so a coding agent running as you could replace what the hook runs. Install selfhost where only root writes (such as a root-owned /usr/local), then install the managed settings again.`,
      );
    }
  }
  const { exceptions } = report;
  row(
    "grants",
    exceptions.mode === "solo"
      ? "solo mode: one-time exceptions are signed with the local key, which holds against agents that follow the rules, not against one set on forging a grant. Team mode with managed settings is the boundary."
      : `team mode: only grants the team server signed count, checked with ${exceptions.keys} pinned key${exceptions.keys === 1 ? "" : "s"}${exceptions.pinned === "managed" ? ` from ${exceptions.path} (root-owned managed settings)` : exceptions.pinned === "config" ? ` from ${exceptions.path}` : ""}`,
  );
  for (const warning of exceptions.warnings) row("warning", warning);
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
    if (team && config.from === "search") {
      row("team", `adds to ${team.path} from ${team.server}; the team's rules are the floor`);
    } else if (team) {
      row("team", `${team.path} from ${team.server} is not used with a file given by name`);
    }
  }
  if (config.valid) {
    row(
      "status",
      `valid, ${config.rules} rules (${config.enforced} enforced, ${config.rules - config.enforced} observe or off)`,
    );
    for (const warning of config.warnings) row("warning", warning);
    guardsRow();
    if (report.team_floor.length > 0) {
      const fields = [...new Set(report.team_floor.map((conflict) => conflict.field))];
      row(
        "floor",
        `the team policy holds ${fields.join(", ")}: this file would relax it, so the hooks use the team's value`,
      );
    }
    const [first, ...rest] = reportLines(report.enforcement);
    if (first !== undefined) {
      row("sandbox", first);
      for (const line of rest) write(`${" ".repeat(9)}${line}`);
    }
    return 0;
  }
  row("status", `invalid, ${config.errors.length} error(s)`);
  const file = relative(cwd, config.path) || config.path;
  for (const error of config.errors) {
    write(`  ${formatConfigError({ ...error, line: error.line ?? undefined }, file)}`);
  }
  return 1;
}
