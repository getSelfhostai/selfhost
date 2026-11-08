import { existsSync } from "node:fs";
import {
  AGENT_IDS,
  AGENT_NAMES,
  type AgentConfigPlan,
  type AgentId,
  type PlanItem,
  planAgentConfig,
  removeAgentConfig,
} from "@selfhost/agents";
import { guardrailChecks } from "@selfhost/policy";
import type { RuleMode } from "@selfhost/schema";
import type { Command } from "commander";
import {
  AGENT_ALIASES,
  type AgentsIo,
  agentScope,
  agentsReport,
  applyConfigure,
  type Scope,
  tilde,
} from "../agents.js";
import { table } from "../format.js";
import { loadPolicy } from "../hooks/pretool.js";
import { spoolDir } from "../hooks/receive.js";
import { hookCommand } from "../init/commands.js";
import { opencodePlugin } from "./opencode-plugin.js";

/**
 * `selfhost guard install | status | uninstall`: the guardrails pack on its own. It adds
 * `selfhost hook <agent>` to the pre-tool hook of each agent found, through packages/agents
 * under its own profile, so it is added and removed apart from `selfhost init` and `agents
 * configure`. No account or server: decisions wait in ~/.selfhost/spool and go into the local
 * ledger on the next `selfhost import`.
 */

/** The profile the pack's settings are recorded under (~/.selfhost/agents/<agent>.guard.json). */
export const GUARD_PROFILE = "guard";

/** What each agent's pre-tool hook can do with a verdict. */
export const COVERAGE: Record<AgentId, { covered: boolean; text: string }> = {
  claude_code: { covered: true, text: "blocks and asks" },
  codex: { covered: true, text: "blocks; an ask is answered as a block (Codex hooks cannot ask)" },
  cursor: { covered: true, text: "blocks; asks on shell and MCP calls only" },
  opencode: { covered: true, text: "blocks through a plugin; an ask is answered as a block" },
  goose: { covered: false, text: "not covered: Goose has no hooks" },
};

export interface GuardIo extends AgentsIo {
  setExitCode: (code: number) => void;
  /** ~/.selfhost/config.json, for the team policy fallback. */
  configPath?: string;
}

export interface GuardOptions {
  agent?: string[];
  dryRun?: boolean;
  json?: boolean;
  /** Treat this folder as the home directory; for fixtures and tests. */
  home?: string;
}

type HookState = PlanItem["status"] | "installed" | "missing" | "not found";

export interface GuardAgentLine {
  id: AgentId;
  name: string;
  found: boolean;
  /** What happened, or for status whether the pre-tool hook is in place. */
  hooks: HookState;
  covered: boolean;
  coverage: string;
  path: string | null;
  /** Copy of the file before this run changed it. */
  backup?: string;
  message: string | null;
}

/** `selfhost guard install|status|uninstall --json`. */
export interface GuardReport {
  schema: "selfhost.guard/v1";
  action: "install" | "status" | "uninstall";
  dry_run: boolean;
  home: string;
  hook_command: string;
  agents: GuardAgentLine[];
  policy: {
    path: string | null;
    error: string | null;
    mode: RuleMode;
    checks: { rule_id: string; mode: RuleMode }[];
  };
  spool: string | null;
  warnings: string[];
}

/** The hook command for each agent, and argv for the OpenCode plugin, which runs it directly. */
function hookCommands(io: GuardIo): { command: string; argv: string[]; warning?: string } {
  const { command, warning } = hookCommand(io.probes.which);
  if (io.probes.which?.("selfhost")) {
    return { command, argv: ["selfhost", "hook", "opencode"], warning };
  }
  const script = process.argv[1];
  const self =
    script && /\.[cm]?js$/.test(script) && existsSync(script)
      ? [process.execPath, script]
      : [process.execPath];
  return { command, argv: [...self, "hook", "opencode"], warning };
}

function chooseAgents(options: GuardOptions, found: Set<AgentId>): AgentId[] {
  if (!options.agent?.length) return AGENT_IDS.filter((id) => found.has(id));
  return options.agent.map((name) => {
    const id = AGENT_ALIASES[name.trim().toLowerCase()];
    if (!id) {
      throw new Error(
        `--agent: expected one of claude, codex, cursor, opencode, goose, got "${name}"`,
      );
    }
    return id;
  });
}

function planGuard(
  agents: AgentId[],
  scope: Scope,
  io: GuardIo,
  command: string,
  argv: string[],
  remove: boolean,
): AgentConfigPlan[] {
  const base = {
    home: scope.home,
    processEnv: scope.env,
    platform: io.platform,
    profile: GUARD_PROFILE,
  };
  return agents.map((agent) =>
    remove
      ? removeAgentConfig(agent, base)
      : planAgentConfig(agent, {
          ...base,
          hooks: {
            command,
            events: "pre_tool",
            ...(agent === "opencode" ? { opencodePlugin: opencodePlugin(argv) } : {}),
          },
        }),
  );
}

function policyOf(io: GuardIo, configPath: string | undefined): GuardReport["policy"] {
  const loaded = loadPolicy(io.cwd, io.env, configPath);
  const { mode } = loaded.config.guardrails;
  return {
    path: loaded.source?.path ?? null,
    error: loaded.failure ?? null,
    mode,
    checks: guardrailChecks(loaded.config).map((check) => ({
      rule_id: check.id,
      mode: check.mode,
    })),
  };
}

function hooksItem(plan: AgentConfigPlan | undefined): PlanItem | undefined {
  return plan?.items.find((item) => item.item === "hooks");
}

function line(
  id: AgentId,
  found: boolean,
  hooks: HookState,
  item: PlanItem | undefined,
): GuardAgentLine {
  return {
    id,
    name: AGENT_NAMES[id],
    found,
    hooks,
    covered: COVERAGE[id].covered,
    coverage: COVERAGE[id].text,
    path: item?.path ?? null,
    message: item?.message ?? null,
  };
}

const WORDS: Record<HookState, string> = {
  create: "added",
  update: "updated",
  unchanged: "already set",
  remove: "removed",
  conflict: "conflict",
  unsupported: "unsupported",
  error: "error",
  installed: "installed",
  missing: "not installed",
  "not found": "not found",
};

function print(report: GuardReport, write: (line: string) => void, cwd: string): void {
  const { home } = report;
  if (report.dry_run) write("Dry run: nothing is written.");
  write(`Pre-tool hook: ${report.hook_command.replace("{agent}", "<agent>")}`);
  table(
    report.agents.map((agent) => [
      `  ${agent.name}`,
      report.dry_run && agent.hooks !== "unchanged"
        ? `would be ${WORDS[agent.hooks]}`
        : WORDS[agent.hooks],
      agent.coverage,
      [
        agent.path ? tilde(agent.path, home) : "",
        agent.backup ? `backup ${tilde(agent.backup, home)}` : "",
        agent.message ?? "",
      ]
        .filter(Boolean)
        .join("  "),
    ]),
    write,
  );
  write("");
  const { policy } = report;
  const where = policy.path
    ? tilde(policy.path, home)
    : `no selfhost.toml above ${tilde(cwd, home)}`;
  write(`Guardrails (${where}): mode ${policy.mode}`);
  if (policy.error) write(`  ${policy.error}`);
  table(
    policy.checks.map((check) => [`  ${check.rule_id}`, check.mode]),
    write,
  );
  write("");
  for (const warning of report.warnings) write(`Note: ${warning}`);
  if (report.action !== "uninstall") {
    write(
      "No account or server: decisions wait in " +
        `${report.spool ? tilde(report.spool, home) : "~/.selfhost/spool"} and go into the local ledger ` +
        "on the next selfhost import (keep selfhost import --watch running to see them live).",
    );
  }
}

/** Runs install, status or uninstall and returns the exit code. */
export function runGuard(
  action: GuardReport["action"],
  options: GuardOptions,
  io: GuardIo,
): number {
  const scope = agentScope(options.home, io);
  const { command, argv, warning } = hookCommands(io);
  const detected = agentsReport({ home: options.home }, io).agents;
  const found = new Set(
    detected.filter((agent) => agent.installed || agent.configExists).map((agent) => agent.id),
  );
  const chosen =
    action === "status" || (action === "uninstall" && !options.agent?.length)
      ? [...AGENT_IDS]
      : chooseAgents(options, found);
  const plans = planGuard(chosen, scope, io, command, argv, action === "uninstall");
  const warnings =
    warning && action === "install"
      ? [warning.replace("selfhost init again", "selfhost guard install again")]
      : [];

  let failed = false;
  const backups = new Map<string, string>();
  if (action !== "status") {
    const configured = applyConfigure(scope.home, plans, { dryRun: options.dryRun }, io);
    for (const entry of configured.agents) {
      for (const file of entry.files) if (file.backup) backups.set(file.path, file.backup);
    }
    failed = plans.some((plan) => plan.items.some((item) => item.status === "error"));
  }

  const agents = AGENT_IDS.map((id): GuardAgentLine => {
    const plan = plans.find((entry) => entry.agent === id);
    const item = hooksItem(plan);
    if (action === "status") {
      if (!COVERAGE[id].covered) return line(id, found.has(id), "unsupported", item);
      // Planning the install changes nothing when the hook is already there, from any setup.
      const state: HookState =
        item?.status === "unchanged" ? "installed" : found.has(id) ? "missing" : "not found";
      return line(id, found.has(id), state, item);
    }
    if (!plan) return line(id, found.has(id), "not found", item);
    if (action === "uninstall" && !item) return line(id, found.has(id), "missing", item);
    return line(id, found.has(id), item?.status ?? "unchanged", item);
  });
  for (const agent of agents) {
    const backup = agent.path ? backups.get(agent.path) : undefined;
    if (backup) agent.backup = backup;
  }
  if (action === "install" && plans.some((plan) => plan.agent === "codex")) {
    warnings.push("Codex asks you to review new hooks with /hooks before they run.");
  }
  if (action === "uninstall") {
    warnings.push(
      "Hooks added by selfhost init or agents configure stay; they run the same check. Remove them with selfhost init --undo or agents configure --remove.",
    );
  }
  const configPath = io.configPath;
  const report: GuardReport = {
    schema: "selfhost.guard/v1",
    action,
    dry_run: options.dryRun ?? false,
    home: scope.home,
    hook_command: command,
    agents,
    policy: policyOf(io, configPath),
    spool: options.home ? null : (spoolDir(io.env) ?? null),
    warnings,
  };
  if (options.json) io.write(JSON.stringify(report, null, 2));
  else print(report, io.write, io.cwd);
  return failed ? 1 : 0;
}

export function registerGuard(
  program: Command,
  io: () => GuardIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const guard = program
    .command("guard")
    .description(
      "the guardrails pack: block force pushes, reset --hard, rm -rf outside the workspace, secret reads and prod database drops in every agent",
    );
  const actions = [
    ["install", "add the pre-tool hook to each agent found; no account or server needed"],
    ["status", "show which agents have the pre-tool hook and which guardrails are on"],
    ["uninstall", "take out the hooks guard install added"],
  ] as const;
  for (const [action, description] of actions) {
    const sub = guard.command(action).description(description);
    if (action !== "status") {
      sub
        .option(
          "--agent <name...>",
          "claude, codex, cursor, opencode or goose (default: the ones found)",
        )
        .option("--dry-run", "print what would change and write nothing");
    }
    sub
      .option("--json", "print one selfhost.guard/v1 object")
      .option("--home <dir>", "use this folder as the home directory (for testing)")
      .action((options: GuardOptions) => {
        const deps = io();
        try {
          deps.setExitCode(runGuard(action, options, deps));
        } catch (error) {
          fail(error, options.json);
        }
      });
  }
}
