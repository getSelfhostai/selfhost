import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  AGENT_NAMES,
  type AgentConfigPlan,
  type AgentId,
  type AppliedChange,
  applyAgentConfig,
  DEFAULT_GATEWAY_MODELS,
  GATEWAY_PROFILE,
  type GatewaySpec,
  manifestPath,
  type PlanItem,
  type Probes,
  planAgentConfig,
  subscriptionLogin,
} from "@selfhost/agents";
import {
  type GatewayBudget,
  type GatewayKey,
  type GatewayKeysResponse,
  type GatewayStatus,
  ROUTER_TOOLS,
  type RouterTool,
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
import { type Membership, readMembership } from "../team/config.js";
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
  /**
   * True when the value is the person's key already kept on this laptop: one key per person,
   * shared by every agent connected here.
   */
  reused: boolean;
  value: string | null;
  base_url: string | null;
  settings: string | null;
  target: string | null;
  /** The agent config files written, with the backup of each one that existed. */
  files: AppliedChange[];
  /** Things on this laptop that would take the agent's traffic past the gateway. */
  warnings: string[];
  notes: string[];
}

function membershipOf(io: GatewayIo): Membership {
  const membership = readMembership(io.configPath);
  if (!membership) {
    throw new Error(
      "This laptop is not in a team: the gateway lives on the team server. Join one with selfhost join <server> <invite>.",
    );
  }
  return membership;
}

function client(io: GatewayIo): TeamClient {
  const membership = membershipOf(io);
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
          : b.spent_usd >= b.limit_usd
            ? `, ${usd(b.spent_usd)} spent: CUT OFF, the gateway refuses these requests with HTTP 402 until the ${b.period === "run" ? "run ends" : `${b.period} is over`}`
            : `, ${usd(b.spent_usd)} spent, ${usd(Math.max(b.limit_usd - b.spent_usd, 0))} left`;
      return `${usd(b.limit_usd)} ${PERIOD[b.period]}${spent}`;
    })
    .join("; ");
}

/**
 * What the gateway's HTTP 402 means. Its body is the gateway's own text, which selfhost cannot
 * change, so connect and status say it here.
 */
export const CUT_OFF_NOTE =
  "When a gateway budget is spent the gateway answers HTTP 402 with its own message. selfhost gateway status, the console's Spend screen and the get_budget MCP tool name the budget that was hit; an owner or admin of the team raises it in the team's selfhost.toml ([budget] or [budget.person]) and the gateway gets it within seconds.";

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
  const spent = [...status.team_budgets, ...(status.key?.budgets ?? [])].some(
    (b) => b.spent_usd !== null && b.spent_usd >= b.limit_usd,
  );
  if (spent) write(`Note: ${CUT_OFF_NOTE}`);
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

/**
 * The person's own gateway key, kept on this laptop (mode 0600) so that every agent connect
 * points at the gateway uses the same key and the same [budget.person] limits. Run keys are never
 * kept.
 */
export const gatewayKeyPath = (home: string) => join(home, ".selfhost", "gateway-key.json");

const KEY_SCHEMA = "selfhost.gateway_key/v1";

interface StoredKey {
  schema: typeof KEY_SCHEMA;
  server: string;
  team: string;
  person: string;
  name: string;
  value: string;
  base_url: string;
  tool: RouterTool;
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

/** The kept key, when it is this membership's: another server, team or person never gets it. */
function readStoredKey(home: string, membership: Membership): StoredKey | undefined {
  let value: Partial<StoredKey>;
  try {
    value = JSON.parse(readFileSync(gatewayKeyPath(home), "utf8")) as Partial<StoredKey>;
  } catch {
    return undefined;
  }
  const mine =
    value.schema === KEY_SCHEMA &&
    value.server === membership.server &&
    value.team === membership.team &&
    value.person === membership.person &&
    isText(value.value) &&
    isText(value.base_url) &&
    (ROUTER_TOOLS as readonly unknown[]).includes(value.tool);
  return mine ? (value as StoredKey) : undefined;
}

function storeKey(home: string, membership: Membership, held: HeldKey): void {
  const path = gatewayKeyPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const stored: StoredKey = {
    schema: KEY_SCHEMA,
    server: membership.server,
    team: membership.team,
    person: membership.person,
    name: held.key?.name ?? "",
    value: held.value,
    base_url: held.base_url,
    tool: held.tool,
  };
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The agents whose config files connect wrote on this laptop and still owns. */
const GATEWAY_AGENTS = Object.values(AGENT_ID).filter((id): id is AgentId => id !== null);

function connectedAgents(home: string): AgentId[] {
  return GATEWAY_AGENTS.filter((id) => existsSync(manifestPath(home, id, GATEWAY_PROFILE)));
}

/** Variables in the shell that would send Claude Code to a cloud instead of the gateway. */
const CLAUDE_SHELL_CLOUDS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

/**
 * Shell variables connect can't change that take the agent's traffic past the gateway. Settings
 * files can't unset a variable the shell exports, so these are said first, as warnings.
 */
function shellWarnings(agent: ConnectAgent, env: NodeJS.ProcessEnv): string[] {
  if (agent !== "claude-code" && agent !== "env") return [];
  const isSet = (name: string) => (env[name] ?? "").trim() !== "";
  const who = agent === "claude-code" ? "Claude Code" : "Tools built on the Anthropic SDK";
  const warnings: string[] = [];
  if (isSet("ANTHROPIC_API_KEY")) {
    warnings.push(
      `ANTHROPIC_API_KEY is set in your shell, and connect can't unset it. ${who} can send that key instead of, or as well as, your gateway key, and anywhere ANTHROPIC_BASE_URL is not set (a project or script that overrides it, a shell without it) requests go straight to Anthropic on it, outside the gateway's budgets and usage. Unset it, and take it out of your shell profile (~/.zshrc, ~/.bashrc).`,
    );
  }
  const clouds = agent === "claude-code" ? CLAUDE_SHELL_CLOUDS.filter(isSet) : [];
  if (clouds.length > 0) {
    warnings.push(
      `${clouds.join(" and ")} ${clouds.length > 1 ? "are" : "is"} set in your shell: Claude Code then sends its requests to that cloud, never to the gateway. Unset ${clouds.length > 1 ? "them" : "it"} to use the gateway.`,
    );
  }
  return warnings;
}

/** How long connect waits for the gateway's model list before using the defaults. */
const MODELS_TIMEOUT_MS = 5_000;

/**
 * The gateway's model names from its OpenAI-style /models, asked with the person's key, for the
 * agents that list models (Goose). When the gateway does not answer, the defaults, with a note.
 */
async function gatewayModels(
  spec: GatewaySpec,
  tool: RouterTool,
  io: GatewayIo,
): Promise<{ models: string[]; note?: string }> {
  try {
    const res = await io.fetch(`${spec.openai}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${spec.key}` },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: unknown };
      const ids = Array.isArray(body.data)
        ? body.data
            .map((model) => (model as { id?: unknown } | null)?.id)
            .filter((id): id is string => isText(id))
        : [];
      if (ids.length > 0) return { models: [...new Set(ids)].sort() };
    }
  } catch {
    // Not reachable from here: the defaults below.
  }
  const models =
    tool === "bifrost"
      ? DEFAULT_GATEWAY_MODELS.map((name) =>
          name.startsWith("claude") ? `anthropic/${name}` : `openai/${name}`,
        )
      : DEFAULT_GATEWAY_MODELS;
  return {
    models,
    note: `The gateway did not list its models, so Goose lists ${models.join(" and ")}: add the gateway's other model names to models in the provider file.`,
  };
}

/** The gateway settings for one agent, with the gateway's models for an agent that lists them. */
async function specFor(
  agent: ConnectAgent,
  held: HeldKey,
  io: GatewayIo,
): Promise<{ spec: GatewaySpec; note?: string }> {
  const spec = gatewaySpec(held.tool, held.base_url, held.value);
  if (agent !== "goose") return { spec };
  const { models, note } = await gatewayModels(spec, held.tool, io);
  return { spec: { ...spec, models }, ...(note ? { note } : {}) };
}

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

/** The key an agent gets: issued now, or the person's own key already kept on this laptop. */
interface HeldKey {
  key: GatewayKey | null;
  value: string;
  base_url: string;
  tool: RouterTool;
  reused: boolean;
}

const AGENT_OF: Record<AgentId, ConnectAgent | undefined> = Object.fromEntries(
  Object.entries(AGENT_ID).map(([agent, id]) => [id, agent]),
) as Record<AgentId, ConnectAgent | undefined>;

/**
 * One key per person: issued the first time, and from then on the value kept on this laptop,
 * whichever agent asks. A key that exists on the gateway but is not kept here (issued on another
 * laptop, or before keys were kept) needs --rotate.
 */
async function holdKey(
  options: ConnectOptions,
  io: GatewayIo,
  membership: Membership,
  holders: AgentId[],
): Promise<HeldKey> {
  const team = client(io);
  try {
    const issued = await team.issueGatewayKey({
      ...(options.run ? { kind: "run" as const, run_id: options.run } : {}),
      ...(options.rotate ? { rotate: true } : {}),
    });
    return { ...issued, reused: false };
  } catch (error) {
    if ((error as { code?: string }).code !== "key_exists") throw error;
  }
  if (options.run) {
    throw new Error(
      `Run ${options.run} has a gateway key already, and its value was shown once when it was issued. Run again with --rotate for a new value; the old one stops working.`,
    );
  }
  const stored = readStoredKey(scope(io).home, membership);
  if (stored) {
    const status = await team.gateway();
    return {
      key: status.key,
      value: stored.value,
      base_url: status.base_url ?? stored.base_url,
      tool: status.tool ?? stored.tool,
      reused: true,
    };
  }
  const names = holders.map((id) => AGENT_NAMES[id]);
  throw new Error(
    `You have a gateway key already, and its value is not kept on this laptop: it was shown once, when it was issued${names.length > 0 ? `, and is in the settings of ${names.join(" and ")}` : ""}. Run again with --rotate for a new value${names.length > 0 ? ": connect rewrites those settings with it too" : ""}. Anything else that holds the old value (another laptop, settings you pasted) stops working.`,
  );
}

/** Writes a plan and records it for disconnect; returns the agent config files it changed. */
function writePlan(plan: AgentConfigPlan, io: GatewayIo): AppliedChange[] {
  const applied = applyAgentConfig(plan, io.now ? { now: io.now } : {});
  const made = new Map<string, string>();
  for (const file of applied) if (file.madeDir) made.set(file.path, file.madeDir);
  recordApplied(
    connectRecordPath(scope(io).home),
    [plan],
    new Map(applied.map((file) => [file.path, file.backup])),
    GATEWAY_RECORD_SCHEMA,
    made,
  );
  return applied.filter((file) =>
    plan.changes.some((c) => c.path === file.path && c.role === "config"),
  );
}

/** Notes about the laptop that connect can't change: file modes. */
function laptopNotes(files: AppliedChange[], io: GatewayIo): string[] {
  const notes: string[] = [];
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

function printConnect(report: ConnectReport, io: GatewayIo, run: boolean): ConnectReport {
  const { write } = io;
  const home = scope(io).home;
  for (const warning of report.warnings) write(`Warning: ${warning}`);
  if (report.warnings.length > 0) write("");
  if (report.key) {
    const limits = `Limits: ${budgetText(report.key.budgets)}.${report.key.budgets.length > 0 ? ` ${CUT_OFF_NOTE}` : ""}`;
    if (report.reused) {
      write(`Gateway key ${report.key.name}, the one your other agents here use. ${limits}`);
    } else {
      write(`Gateway key ${report.key.name}. ${limits}`);
      write(
        run
          ? "Its value is shown this once; selfhost keeps no copy. It is not a provider key."
          : `Its value is shown here and kept only on this laptop, in ${tilde(gatewayKeyPath(home), home)} (mode 600), so every agent you connect uses this one key. It is not a provider key.`,
      );
    }
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
  return printConnect(report, io, options.run !== undefined);
}

const empty = (
  agent: string,
  status: ConnectReport["status"],
  notes: string[],
  warnings: string[] = [],
): ConnectReport => ({
  schema: "selfhost.gateway_connect/v1",
  agent,
  status,
  key: null,
  reused: false,
  value: null,
  base_url: null,
  settings: null,
  target: null,
  files: [],
  warnings,
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
  const warnings = shellWarnings(agent, io.env);
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
        empty(
          agent,
          "subscription",
          [
            `${AGENT_NAMES[id]} is signed in with ${login.plan} (${isAbsolute(login.source) ? tilde(login.source, home) : login.source}). That traffic goes straight to the vendor and never reaches the gateway, so the gateway's budgets and usage cover API key traffic only. Nothing was changed and no key was issued.`,
            `To send ${AGENT_NAMES[id]} through the gateway on API billing instead, run again with --api-billing.`,
          ],
          warnings,
        ),
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

  const membership = membershipOf(io);
  // The person's key is shared by every agent connected here: a new value goes into all of them.
  const others = options.run
    ? []
    : connectedAgents(home).filter((other) => !(writes && other === id));
  if (options.rotate && others.length > 0) {
    const stuck = others.flatMap((other) =>
      blocking(planConnect(other, PLACEHOLDER, io)).map(
        (item) => `${AGENT_NAMES[other]}, ${itemText(item, home)}`,
      ),
    );
    if (stuck.length > 0) {
      throw new Error(
        `Nothing was changed and the key was not rotated: these settings hold your key and can't take the new value: ${stuck.join("; ")}. Fix them, or take that agent off the gateway first (selfhost gateway disconnect <agent>).`,
      );
    }
  }

  const held = await holdKey(options, io, membership, others);
  if (!options.run && !held.reused) storeKey(home, membership, held);
  const { spec, note: modelsNote } = await specFor(agent, held, io);
  const kit = options.managed
    ? claudeManagedKit(spec, platform)
    : connectKit(agent, held.tool, spec);
  const report: ConnectReport = {
    schema: "selfhost.gateway_connect/v1",
    agent,
    status: "printed",
    key: held.key,
    reused: held.reused,
    value: held.value,
    base_url: held.base_url,
    settings: kit.text,
    target: kit.target,
    files: [],
    warnings,
    notes: [...(modelsNote ? [modelsNote] : []), ...kit.notes],
  };

  // A new value: rewrite every other agent connected here, so none is left with the old one.
  const rewritten: AppliedChange[] = [];
  const rewriteNotes: string[] = [];
  if (!held.reused) {
    for (const other of others) {
      const otherAgent = AGENT_OF[other];
      if (!otherAgent) continue;
      const { spec: otherSpec } = await specFor(otherAgent, held, io);
      const plan = planConnect(other, otherSpec, io);
      const stops = blocking(plan);
      if (stops.length > 0) {
        rewriteNotes.push(
          `Not updated, so ${AGENT_NAMES[other]} still has the old value: ${stops.map((item) => itemText(item, home)).join("; ")}`,
        );
        continue;
      }
      rewritten.push(...writePlan(plan, io));
    }
    if (options.rotate) {
      rewriteNotes.push(
        "The old value no longer works. Paste the new one wherever you put the old one yourself (--print, --managed, env, another laptop).",
      );
    }
  }

  if (!writes || !id) {
    report.files = rewritten;
    report.notes = [...rewriteNotes, ...report.notes];
    return done(report, options, io);
  }

  const plan = planConnect(id, spec, io);
  const stops = blocking(plan);
  if (stops.length > 0) {
    // The files changed since the check: hand over the settings instead of losing the key.
    report.files = rewritten;
    report.notes = [
      ...stops.map((item) => `Not written, ${itemText(item, home)}`),
      ...rewriteNotes,
      ...report.notes,
    ];
    return done(report, options, io);
  }
  const files = [...writePlan(plan, io), ...rewritten];
  report.status = "connected";
  report.settings = null;
  report.target = null;
  report.files = files;
  report.notes = [...laptopNotes(files, io), ...rewriteNotes, ...report.notes];
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
  /** The kept key's file, removed once no agent on this laptop is connected. */
  key_removed: string | null;
}

/**
 * Puts back, byte for byte, the files `selfhost gateway connect` changed for one agent or all of
 * them, while each still holds what connect wrote. The key stays on the gateway; its copy on this
 * laptop goes once no agent here uses it.
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
  const keyPath = gatewayKeyPath(home);
  let removed: string | null = null;
  if (!dryRun && connectedAgents(home).length === 0 && existsSync(keyPath)) {
    rmSync(keyPath, { force: true });
    removed = keyPath;
  }
  const report: DisconnectReport = {
    schema: "selfhost.gateway_disconnect/v1",
    dry_run: dryRun,
    record,
    ...result,
    key_removed: removed,
  };
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return report;
  }
  const { write } = io;
  const removedText = `Deleted ${removed ? tilde(removed, home) : ""}, the copy of your key: no agent here uses it now. The key stays on the gateway; the next connect asks for --rotate to get a new value.`;
  if (report.files.length === 0) {
    write(
      `Nothing to undo: selfhost gateway connect wrote no files${agentName ? ` for ${agentName}` : ""} on this laptop.`,
    );
    if (removed) write(removedText);
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
  if (removed) write(removedText);
  else if (!dryRun) {
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
