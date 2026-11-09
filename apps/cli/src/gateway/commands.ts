import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  AGENT_NAMES,
  type AgentConfigPlan,
  type AgentId,
  type AppliedChange,
  applyAgentConfig,
  GATEWAY_PROFILE,
  type GatewaySpec,
  manifestPath,
  type PlanItem,
  type Probes,
  planAgentConfig,
  subscriptionLogin,
} from "@selfhost/agents";
import type {
  GatewayBudget,
  GatewayKey,
  GatewayKeysResponse,
  GatewayStatus,
  IssueGatewayKeyResponse,
} from "@selfhost/schema";
import type { Command } from "commander";
import { tilde } from "../agents.js";
import { table, usd } from "../format.js";
import {
  GATEWAY_RECORD_SCHEMA,
  recordApplied,
  type UndoFile,
  undoRecorded,
} from "../init/record.js";
import { type Fetch, TeamClient } from "../team/client.js";
import { readMembership } from "../team/config.js";
import {
  AGENT_ID,
  type ConnectAgent,
  claudeManagedKit,
  connectKit,
  connectTarget,
  gatewaySpec,
} from "./connect.js";

export interface GatewayIo {
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  configPath: string;
  fetch: Fetch;
  /** Home folder, where the agents' config files are. Default: HOME. */
  home?: string;
  platform?: NodeJS.Platform;
  /** The keychain probe finds a subscription login kept there. */
  probes?: Probes;
  now?: Date;
}

interface TeamOption {
  team?: string;
  json?: boolean;
}

export interface ConnectOptions {
  rotate?: boolean;
  run?: string;
  /** Print the settings to paste instead of writing them. */
  print?: boolean;
  /** claude-code: print a managed settings drop-in instead. */
  managed?: boolean;
  /** Connect even when the agent is signed in with a subscription. */
  apiBilling?: boolean;
  undo?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

/** `selfhost gateway connect --json`. The value is here once, for the person who asked. */
export interface ConnectReport {
  schema: "selfhost.gateway_connect/v1";
  /** The agent asked for, or Cursor or GitHub Copilot. */
  agent: string;
  /**
   * connected: the agent's own config files point at the gateway. printed: the settings are in
   * `settings`, to paste. not_applicable: the agent can't use a gateway. subscription: the agent
   * is signed in with a subscription, so nothing was changed. The last two issue no key.
   */
  status: "connected" | "printed" | "not_applicable" | "subscription";
  key: GatewayKey | null;
  value: string | null;
  base_url: string | null;
  settings: string | null;
  target: string | null;
  /** The agent config files written, with the backup of each one that existed. */
  files: AppliedChange[];
  notes: string[];
}

function client(io: GatewayIo): TeamClient {
  const membership = readMembership(io.configPath);
  if (!membership) {
    throw new Error(
      "This laptop is not in a team: the gateway lives on the team server. Join one with selfhost join <server> <invite>.",
    );
  }
  return new TeamClient(membership.server, membership.token, io.fetch);
}

const PERIOD: Record<GatewayBudget["period"], string> = {
  day: "a day",
  week: "a week",
  month: "a month",
  run: "for the run",
};

export function budgetText(budgets: GatewayBudget[]): string {
  if (budgets.length === 0) return "none on the gateway";
  return budgets
    .map((b) => {
      const spent =
        b.spent_usd === null
          ? ""
          : `, ${usd(b.spent_usd)} spent, ${usd(Math.max(b.limit_usd - b.spent_usd, 0))} left`;
      return `${usd(b.limit_usd)} ${PERIOD[b.period]}${spent}`;
    })
    .join("; ");
}

export async function gatewayStatus(options: TeamOption, io: GatewayIo): Promise<GatewayStatus> {
  const status = await client(io).gateway(options.team);
  if (options.json) {
    io.write(JSON.stringify(status, null, 2));
    return status;
  }
  const { write } = io;
  table(
    [
      ["  Gateway", `${status.tool} at ${status.base_url ?? "an unknown address"}`],
      ["  Health", status.healthy ? "answering" : `not answering: ${status.detail ?? "no detail"}`],
      [
        "  Budgets",
        status.mode === "hard"
          ? `hard: the gateway refuses requests once a budget is spent`
          : "alert: spend is shown and alerted, nothing is stopped ([budget] mode = hard stops it)",
      ],
      [`  Team ${status.team}`, budgetText(status.team_budgets)],
      [
        "  Your key",
        status.key
          ? `${status.key.name}${status.key.active ? "" : " (turned off)"}: ${budgetText(status.key.budgets)}`
          : "none yet: selfhost gateway connect <agent>",
      ],
      [
        "  Last sync",
        status.last_sync
          ? `${status.last_sync.at}${status.last_sync.errors.length ? `, ${status.last_sync.errors.length} errors: ${status.last_sync.errors[0]}` : ""}`
          : "not yet",
      ],
      [
        "  Usage read",
        status.last_usage
          ? `${status.last_usage.at}, ${status.last_usage.events} new requests${status.last_usage.error ? `, failed: ${status.last_usage.error}` : ""}`
          : "not yet",
      ],
    ],
    write,
  );
  for (const note of status.notes) write(`Note: ${note}`);
  return status;
}

export async function gatewayKeys(
  options: TeamOption,
  io: GatewayIo,
): Promise<GatewayKeysResponse> {
  const keys = await client(io).gatewayKeys(options.team);
  if (options.json) {
    io.write(JSON.stringify(keys, null, 2));
    return keys;
  }
  if (keys.keys.length === 0) {
    io.write(`No gateway keys in team ${keys.team} yet.`);
    return keys;
  }
  table(
    [
      ["Key", "Owner", "State", "Limits"],
      ...keys.keys.map((key) => [
        key.name,
        key.person ?? (key.kind === "team" ? "the team" : (key.run_id ?? "")),
        key.active ? "on" : "off",
        budgetText(key.budgets),
      ]),
    ],
    io.write,
  );
  io.write("Values are never shown here: each was shown once, to whoever it was issued to.");
  return keys;
}

/** selfhost's record of the files connect changed, for disconnect. */
export const connectRecordPath = (home: string) => join(home, ".selfhost", "gateway-connect.json");

/** Stands in for the gateway's address and key to see whether connect could write at all. */
const PLACEHOLDER: GatewaySpec = {
  anthropic: "https://gateway.invalid/anthropic",
  openai: "https://gateway.invalid/v1",
  key: "placeholder",
};

/** Variables in the shell that would send Claude Code past the gateway or with another key. */
const CLAUDE_SHELL_RIVALS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

interface Scope {
  home: string;
  platform: NodeJS.Platform;
}

function scope(io: GatewayIo): Scope {
  return { home: io.home ?? io.env.HOME ?? homedir(), platform: io.platform ?? process.platform };
}

function planConnect(id: AgentId, spec: GatewaySpec, io: GatewayIo): AgentConfigPlan {
  const { home, platform } = scope(io);
  return planAgentConfig(id, {
    home,
    platform,
    processEnv: io.env,
    profile: GATEWAY_PROFILE,
    gateway: spec,
  });
}

const BLOCKING = new Set(["conflict", "error", "unsupported"]);

const blocking = (plan: AgentConfigPlan) => plan.items.filter((item) => BLOCKING.has(item.status));

function itemText(item: PlanItem, home: string): string {
  const where = item.path ? ` ${tilde(item.path, home)}` : "";
  return `${item.status}${where}${item.message ? `: ${item.message}` : ""}`;
}

async function issue(options: ConnectOptions, io: GatewayIo): Promise<IssueGatewayKeyResponse> {
  try {
    return await client(io).issueGatewayKey({
      ...(options.run ? { kind: "run" as const, run_id: options.run } : {}),
      ...(options.rotate ? { rotate: true } : {}),
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "key_exists") {
      throw new Error(
        "You have a gateway key already, and its value was shown once when it was issued. Run again with --rotate for a new value; the old one stops working.",
      );
    }
    throw error;
  }
}

/** Notes about the laptop that connect can't change: shell variables and file modes. */
function laptopNotes(agent: ConnectAgent, files: AppliedChange[], io: GatewayIo): string[] {
  const notes: string[] = [];
  const set = CLAUDE_SHELL_RIVALS.filter((name) => (io.env[name] ?? "").trim() !== "");
  if (agent === "claude-code" && set.length > 0) {
    notes.push(
      `${set.join(" and ")} ${set.length > 1 ? "are" : "is"} set in your shell: unset ${set.length > 1 ? "them" : "it"}, or Claude Code may go past the gateway or send that key too.`,
    );
  }
  const { home } = scope(io);
  for (const file of files) {
    if (file.action === "deleted") continue;
    try {
      const mode = statSync(file.path).mode & 0o777;
      if (mode & 0o077) {
        notes.push(
          `${tilde(file.path, home)} holds your key and other accounts on this laptop can read it (mode ${mode.toString(8)}): chmod 600 it if you share the laptop.`,
        );
      }
    } catch {
      // Gone already: nothing to say about it.
    }
  }
  return notes;
}

function printConnect(report: ConnectReport, io: GatewayIo): ConnectReport {
  const { write } = io;
  const home = scope(io).home;
  if (report.key) {
    write(`Gateway key ${report.key.name}. Limits: ${budgetText(report.key.budgets)}.`);
    write("Its value is shown this once; selfhost keeps no copy. It is not a provider key.");
    write("");
  }
  if (report.status === "connected") {
    for (const file of report.files) {
      const backup = file.backup ? ` (backup ${tilde(file.backup, home)})` : "";
      write(
        `${file.action === "created" ? "Created" : "Updated"} ${tilde(file.path, home)}${backup}`,
      );
    }
    write(`Undo: selfhost gateway disconnect ${report.agent} puts each file back byte for byte.`);
  } else if (report.settings !== null) {
    write(`For ${report.target}:`);
    write("");
    write(report.settings);
  }
  if (report.notes.length > 0) write("");
  for (const note of report.notes) write(`Note: ${note}`);
  return report;
}

function done(report: ConnectReport, options: ConnectOptions, io: GatewayIo): ConnectReport {
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return report;
  }
  return printConnect(report, io);
}

const empty = (agent: string, status: ConnectReport["status"], notes: string[]): ConnectReport => ({
  schema: "selfhost.gateway_connect/v1",
  agent,
  status,
  key: null,
  value: null,
  base_url: null,
  settings: null,
  target: null,
  files: [],
  notes,
});

/**
 * Points one agent at the gateway with the person's virtual key. Claude Code, Codex, OpenCode and
 * Goose get it written into their own config files, with a backup and a record for disconnect;
 * env, --print and --managed only print. Nothing is written, and no key issued, for Cursor and
 * Copilot (they can't use a gateway) or for an agent signed in with a subscription, unless
 * --api-billing says to send it through the gateway anyway.
 */
export async function gatewayConnect(
  agentName: string,
  options: ConnectOptions,
  io: GatewayIo,
): Promise<ConnectReport | DisconnectReport> {
  if (options.undo) return gatewayDisconnect(agentName, options, io);
  const target = connectTarget(agentName);
  if (target.kind === "admin_api") {
    return done(empty(target.name, "not_applicable", [target.message]), options, io);
  }
  const { agent } = target;
  const id = AGENT_ID[agent];
  if (options.managed && agent !== "claude-code") {
    throw new Error("--managed is for claude-code: other agents have no managed env settings");
  }
  // A run's key expires in a day: it goes in that run's environment, not in a config file.
  const writes = id !== null && !options.print && !options.managed && !options.run;
  const { home, platform } = scope(io);

  if (writes && id) {
    const connected = existsSync(manifestPath(home, id, GATEWAY_PROFILE));
    const login =
      connected || options.apiBilling
        ? null
        : subscriptionLogin(id, { home, env: io.env, platform, keychain: io.probes?.keychain });
    if (login) {
      return done(
        empty(agent, "subscription", [
          `${AGENT_NAMES[id]} is signed in with ${login.plan} (${isAbsolute(login.source) ? tilde(login.source, home) : login.source}). That traffic goes straight to the vendor and never reaches the gateway, so the gateway's budgets and usage cover API key traffic only. Nothing was changed and no key was issued.`,
          `To send ${AGENT_NAMES[id]} through the gateway on API billing instead, run again with --api-billing.`,
        ]),
        options,
        io,
      );
    }
    const stops = blocking(planConnect(id, PLACEHOLDER, io));
    if (stops.length > 0) {
      throw new Error(
        `Nothing was changed and no key was issued: ${stops.map((item) => itemText(item, home)).join("; ")}`,
      );
    }
  }

  const issued = await issue(options, io);
  const spec = gatewaySpec(issued.tool, issued.base_url, issued.value);
  const kit = options.managed
    ? claudeManagedKit(spec, platform)
    : connectKit(agent, issued.tool, spec);
  const report: ConnectReport = {
    schema: "selfhost.gateway_connect/v1",
    agent,
    status: "printed",
    key: issued.key,
    value: issued.value,
    base_url: issued.base_url,
    settings: kit.text,
    target: kit.target,
    files: [],
    notes: kit.notes,
  };
  if (!writes || !id) return done(report, options, io);

  const plan = planConnect(id, spec, io);
  const stops = blocking(plan);
  if (stops.length > 0) {
    // The files changed since the check: hand over the settings instead of losing the key.
    report.notes = [
      ...stops.map((item) => `Not written, ${itemText(item, home)}`),
      ...report.notes,
    ];
    return done(report, options, io);
  }
  const applied = applyAgentConfig(plan, io.now ? { now: io.now } : {});
  recordApplied(
    connectRecordPath(home),
    [plan],
    new Map(applied.map((file) => [file.path, file.backup])),
    GATEWAY_RECORD_SCHEMA,
  );
  const files = applied.filter((file) =>
    plan.changes.some((c) => c.path === file.path && c.role === "config"),
  );
  report.status = "connected";
  report.settings = null;
  report.target = null;
  report.files = files;
  report.notes = [...laptopNotes(agent, files, io), ...kit.notes];
  return done(report, options, io);
}

/** `selfhost gateway disconnect --json`. */
export interface DisconnectReport {
  schema: "selfhost.gateway_disconnect/v1";
  dry_run: boolean;
  record: string;
  files: UndoFile[];
  /** Files left as is; their record entries are kept for another try. */
  left: number;
}

/**
 * Puts back, byte for byte, the files `selfhost gateway connect` changed for one agent or all of
 * them, while each still holds what connect wrote. The key stays on the gateway.
 */
export function gatewayDisconnect(
  agentName: string | undefined,
  options: { dryRun?: boolean; json?: boolean },
  io: GatewayIo,
): DisconnectReport {
  let only: Set<AgentId | null> | undefined;
  if (agentName !== undefined) {
    const target = connectTarget(agentName);
    const id = target.kind === "agent" ? AGENT_ID[target.agent] : null;
    only = new Set([id]);
  }
  const { home } = scope(io);
  const record = connectRecordPath(home);
  const dryRun = options.dryRun ?? false;
  const result = undoRecorded(record, dryRun, { schema: GATEWAY_RECORD_SCHEMA, only });
  const report: DisconnectReport = {
    schema: "selfhost.gateway_disconnect/v1",
    dry_run: dryRun,
    record,
    ...result,
  };
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return report;
  }
  const { write } = io;
  if (report.files.length === 0) {
    write(
      `Nothing to undo: selfhost gateway connect wrote no files${agentName ? ` for ${agentName}` : ""} on this laptop.`,
    );
    return report;
  }
  for (const file of report.files) {
    const path = tilde(file.path, home);
    if (file.action === "left") write(`Left ${path} as is: ${file.message}`);
    else if (file.role === "state") continue;
    else if (file.action === "restored") {
      write(
        `${dryRun ? "Would restore" : "Restored"} ${path} byte for byte from ${file.backup ? tilde(file.backup, home) : "its backup"}.`,
      );
    } else write(`${dryRun ? "Would delete" : "Deleted"} ${path}: connect created it.`);
  }
  if (!dryRun) {
    write(
      "The key itself stays on the gateway; connect --rotate replaces its value if it got out.",
    );
  }
  return report;
}

export function registerGateway(
  program: Command,
  io: () => GatewayIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const gateway = program
    .command("gateway")
    .description(
      "the AI gateway on the team server: its health and budgets, the team's keys, and an agent's settings to send its model traffic through it",
    );
  gateway
    .command("status", { isDefault: true })
    .description("health, the team's hard limits and your own key, with what is left")
    .option("--team <id>", "another team you are in")
    .option("--json", "print the selfhost GatewayStatus object")
    .action(async (options: TeamOption) => {
      try {
        await gatewayStatus(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
  gateway
    .command("keys")
    .description("the team's gateway keys and their limits, never their values (owners and admins)")
    .option("--team <id>", "another team you are in")
    .option("--json", "print the keys as JSON")
    .action(async (options: TeamOption) => {
      try {
        await gatewayKeys(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
  gateway
    .command("connect")
    .description(
      "issue your gateway key and point an agent at the gateway with it: writes the settings of claude-code, codex, opencode or goose (backed up, undone by disconnect), or prints them for env. Cursor, Copilot and subscription logins can't go through it, and are left as they are",
    )
    .argument("<agent>", "claude-code, codex, opencode, goose or env")
    .option("--rotate", "replace your key's value; the old one stops working")
    .option("--run <id>", "a key for one background run instead, which expires after 24 hours")
    .option("--print", "print the settings to paste instead of writing them")
    .option(
      "--managed",
      "claude-code: print a managed settings file instead, which no project can override",
    )
    .option(
      "--api-billing",
      "connect even when the agent is signed in with a subscription: its traffic then goes through the gateway on API billing",
    )
    .option("--undo", "the same as selfhost gateway disconnect <agent>")
    .option("--dry-run", "with --undo: say what would be put back, change nothing")
    .option("--json", "print one selfhost.gateway_connect/v1 object, with the key's value")
    .action(async (agent: string, options: ConnectOptions) => {
      try {
        await gatewayConnect(agent, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
  gateway
    .command("disconnect")
    .description(
      "put back, byte for byte, the agent config files selfhost gateway connect changed: one agent's, or every agent's",
    )
    .argument("[agent]", "claude-code, codex, opencode or goose; default: all")
    .option("--dry-run", "say what would be put back, change nothing")
    .option("--json", "print one selfhost.gateway_disconnect/v1 object")
    .action((agent: string | undefined, options: { dryRun?: boolean; json?: boolean }) => {
      try {
        gatewayDisconnect(agent, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
