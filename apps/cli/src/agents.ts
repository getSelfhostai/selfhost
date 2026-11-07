import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  AGENT_IDS,
  AGENT_NAMES,
  type AgentConfigInput,
  type AgentConfigPlan,
  type AgentId,
  type AgentStatus,
  type AppliedChange,
  applyAgentConfig,
  CONTEXT_KIND_LABELS,
  type ContextFile,
  detectAgents,
  type Env,
  findContextFiles,
  type McpServerSpec,
  type OtlpProtocol,
  PATH_ENV_VARS,
  type PlanItem,
  type Probes,
  planAgentConfig,
  removeAgentConfig,
  repoRoot,
  unifiedDiff,
} from "@selfhost/agents";

export interface AgentsIo {
  env: Env;
  cwd: string;
  platform: NodeJS.Platform;
  probes: Probes;
  write: (line: string) => void;
  now?: Date;
}

export interface AgentsOptions {
  json?: boolean;
  /** Treat this folder as the home directory; for fixtures and tests. */
  home?: string;
}

/** `selfhost agents --json`. */
export interface AgentsReport {
  schema: "selfhost.agents/v1";
  home: string;
  agents: AgentStatus[];
  context: ContextFile[];
}

export interface Scope {
  home: string;
  env: Env;
  probes: Probes;
}

/**
 * The home directory and probes to use. --home re-roots every agent path under that folder:
 * the environment variables that move agent folders are dropped, and the keychain and
 * version probes are off, because they would look at this machine's real logins.
 */
export function agentScope(homeFlag: string | undefined, io: AgentsIo): Scope {
  if (homeFlag === undefined) {
    const home = homedir();
    if (!home) throw new Error("could not find the home directory; pass --home");
    return { home, env: io.env, probes: io.probes };
  }
  const env = { ...io.env };
  for (const name of PATH_ENV_VARS) delete env[name];
  return { home: resolve(io.cwd, homeFlag), env, probes: { which: io.probes.which } };
}

export function tilde(path: string, home: string): string {
  const rel = relative(home, path);
  if (rel === "") return "~";
  return rel.startsWith("..") || isAbsolute(rel) ? path : `~${sep}${rel}`;
}

function table(rows: string[][]): string[] {
  const widths =
    rows[0]?.map((_, col) => Math.max(...rows.map((row) => row[col]?.length ?? 0))) ?? [];
  return rows.map((row) =>
    row
      .map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

function loginText(agent: AgentStatus): string {
  const { status, method, source } = agent.login;
  if (status === "logged_out") return "not signed in";
  if (status === "unknown") return method === "database" ? "unknown (in opencode.db)" : "unknown";
  return method === "env" ? `signed in (${source})` : `signed in (${method})`;
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function agentsReport(options: AgentsOptions, io: AgentsIo): AgentsReport {
  const { home, env, probes } = agentScope(options.home, io);
  return {
    schema: "selfhost.agents/v1",
    home,
    agents: detectAgents({ home, env, platform: io.platform, ...probes }),
    context: findContextFiles({ home, env, platform: io.platform, cwd: io.cwd }),
  };
}

/** `selfhost agents`: the agents on this machine, their logins and their context files. */
export function agentsCommand(options: AgentsOptions, io: AgentsIo): number {
  const report = agentsReport(options, io);
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return 0;
  }
  const { home } = report;
  const rows = [["AGENT", "INSTALLED", "VERSION", "LOGIN", "CONFIG"]];
  for (const agent of report.agents) {
    rows.push([
      agent.name,
      agent.installed ? "yes" : "no",
      agent.version ?? "-",
      loginText(agent),
      tilde(agent.configPath, home) + (agent.configExists ? "" : " (none yet)"),
    ]);
  }
  for (const line of table(rows)) io.write(line);
  for (const agent of report.agents) {
    if (agent.installed && agent.login.status === "logged_out") {
      io.write(`${agent.name} is not signed in. Sign in with \`${agent.login.hint}\`.`);
    }
  }
  io.write("");
  if (report.context.length === 0) {
    io.write("No context files (CLAUDE.md, AGENTS.md, skills) found.");
    return 0;
  }
  io.write(`Context files (${report.context.length})`);
  const root = repoRoot(io.cwd);
  const contextRows = report.context.map((file) => [
    file.scope,
    file.scope === "repo" ? relative(root, file.path) : tilde(file.path, home),
    CONTEXT_KIND_LABELS[file.kind],
    size(file.size),
  ]);
  for (const line of table(contextRows)) io.write(`  ${line}`);
  return 0;
}

export interface ConfigureOptions extends AgentsOptions {
  agent?: string[];
  dryRun?: boolean;
  remove?: boolean;
  otelEndpoint?: string;
  otelProtocol?: string;
  otelHeader?: string[];
  otelLogPrompts?: boolean;
  otelTraces?: boolean;
  hookCommand?: string;
  mcp?: string[];
  env?: string[];
}

/** `selfhost agents configure --json`. */
export interface ConfigureReport {
  schema: "selfhost.agents_configure/v1";
  home: string;
  dryRun: boolean;
  remove: boolean;
  agents: {
    agent: AgentId;
    items: PlanItem[];
    files: {
      path: string;
      role: "config" | "state";
      action: "create" | "update" | "delete";
      /** Backup of the previous content; null on a dry run, for new files and for state. */
      backup: string | null;
      /** Unified diff with credential-looking values masked; empty for state files. */
      diff: string;
    }[];
  }[];
}

export const AGENT_ALIASES: Record<string, AgentId> = {
  claude: "claude_code",
  "claude-code": "claude_code",
  claude_code: "claude_code",
  codex: "codex",
  opencode: "opencode",
  goose: "goose",
  cursor: "cursor",
  "cursor-agent": "cursor",
};

const PROTOCOLS: OtlpProtocol[] = ["http/protobuf", "http/json", "grpc"];

function pairs(values: string[] | undefined, flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values ?? []) {
    const at = value.indexOf("=");
    if (at <= 0) throw new Error(`${flag}: expected KEY=VALUE, got "${value}"`);
    out[value.slice(0, at)] = value.slice(at + 1);
  }
  return out;
}

/** `name=https://host/mcp` or `name=command arg1 arg2` (split on spaces, no quoting). */
export function parseMcp(value: string): [string, McpServerSpec] {
  const at = value.indexOf("=");
  const name = value.slice(0, at).trim();
  const rest = value.slice(at + 1).trim();
  if (at <= 0 || !name || !rest) {
    throw new Error(`--mcp: expected name=command [args] or name=url, got "${value}"`);
  }
  if (/^https?:\/\//.test(rest)) return [name, { url: rest }];
  const [command = "", ...args] = rest.split(/\s+/);
  return [name, args.length > 0 ? { command, args } : { command }];
}

export function configInput(options: ConfigureOptions): AgentConfigInput {
  const input: AgentConfigInput = {};
  if (options.otelEndpoint) {
    const protocol = options.otelProtocol ?? "http/protobuf";
    if (!PROTOCOLS.includes(protocol as OtlpProtocol)) {
      throw new Error(
        `--otel-protocol: expected one of ${PROTOCOLS.join(", ")}, got "${protocol}"`,
      );
    }
    const headers = pairs(options.otelHeader, "--otel-header");
    input.otel = {
      endpoint: options.otelEndpoint,
      protocol: protocol as OtlpProtocol,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(options.otelLogPrompts ? { logUserPrompts: true } : {}),
      ...(options.otelTraces ? { traces: true } : {}),
    };
  } else if (options.otelProtocol || options.otelHeader?.length) {
    throw new Error("--otel-protocol and --otel-header need --otel-endpoint");
  }
  if (options.hookCommand) input.hooks = { command: options.hookCommand };
  if (options.mcp?.length) input.mcpServers = Object.fromEntries(options.mcp.map(parseMcp));
  const env = pairs(options.env, "--env");
  if (Object.keys(env).length > 0) input.env = env;
  return input;
}

function chooseAgents(options: ConfigureOptions, scoped: Scope, io: AgentsIo): AgentId[] {
  if (options.agent?.length) {
    return options.agent.map((name) => {
      const id = AGENT_ALIASES[name.trim().toLowerCase()];
      if (!id) {
        throw new Error(
          `--agent: expected one of claude, codex, opencode, goose, cursor, got "${name}"`,
        );
      }
      return id;
    });
  }
  if (options.remove) return [...AGENT_IDS];
  return detectAgents({
    home: scoped.home,
    env: scoped.env,
    platform: io.platform,
    ...scoped.probes,
  })
    .filter((agent) => agent.installed || agent.configExists)
    .map((agent) => agent.id);
}

const ACTION_OF = (before: string | null, after: string | null) =>
  after === null ? "delete" : before === null ? "create" : "update";

const PAST = { create: "created", update: "updated", delete: "deleted" } as const;

/** The agents to configure and the changes for each. Nothing is written. */
export function planConfigure(
  options: ConfigureOptions,
  io: AgentsIo,
): { home: string; plans: AgentConfigPlan[] } {
  const scoped = agentScope(options.home, io);
  const input = options.remove ? {} : configInput(options);
  if (!options.remove && Object.keys(input).length === 0) {
    throw new Error("nothing to configure: pass --otel-endpoint, --hook-command, --mcp or --env");
  }
  const agents = chooseAgents(options, scoped, io);
  const planOptions = { home: scoped.home, processEnv: scoped.env, platform: io.platform };
  const plans = agents.map((agent) =>
    options.remove
      ? removeAgentConfig(agent, planOptions)
      : planAgentConfig(agent, { ...planOptions, ...input }),
  );
  return { home: scoped.home, plans };
}

/** Writes the plans, unless dryRun, and describes them as `selfhost agents configure --json`. */
export function applyConfigure(
  home: string,
  plans: AgentConfigPlan[],
  options: Pick<ConfigureOptions, "dryRun" | "remove">,
  io: Pick<AgentsIo, "now">,
): ConfigureReport {
  const applied = new Map<string, AppliedChange>();
  if (!options.dryRun) {
    for (const plan of plans) {
      for (const change of applyAgentConfig(plan, { now: io.now }))
        applied.set(change.path, change);
    }
  }
  return {
    schema: "selfhost.agents_configure/v1",
    home,
    dryRun: options.dryRun ?? false,
    remove: options.remove ?? false,
    agents: plans.map((plan) => ({
      agent: plan.agent,
      items: plan.items,
      files: plan.changes.map((change) => ({
        path: change.path,
        role: change.role,
        action: ACTION_OF(change.before, change.after),
        backup: applied.get(change.path)?.backup ?? null,
        diff: change.role === "config" ? unifiedDiff(change.path, change.before, change.after) : "",
      })),
    })),
  };
}

/**
 * `selfhost agents configure`: writes selfhost's hooks, env, MCP servers and OpenTelemetry
 * settings into each agent's own settings files (never a shell profile). --dry-run prints
 * the changes as a unified diff; --remove takes selfhost's settings out again.
 */
export function configureCommand(options: ConfigureOptions, io: AgentsIo): number {
  const { home, plans } = planConfigure(options, io);
  const report = applyConfigure(home, plans, options, io);
  const failed = plans.some((plan) => plan.items.some((item) => item.status === "error"));
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return failed ? 1 : 0;
  }

  if (plans.length === 0) {
    io.write("No agents found to configure. Pass --agent to choose one.");
    return 0;
  }
  for (const entry of report.agents) {
    io.write(AGENT_NAMES[entry.agent]);
    const rows = entry.items.map((item) => [
      item.status,
      item.item,
      [item.path ? tilde(item.path, home) : "", item.message ?? ""].filter(Boolean).join(": "),
    ]);
    if (rows.length === 0) rows.push(["unchanged", "-", "nothing of selfhost's to change"]);
    for (const line of table(rows)) io.write(`  ${line}`);
    for (const file of entry.files) {
      if (file.role === "state") continue;
      if (report.dryRun) {
        for (const line of file.diff.trimEnd().split("\n"))
          io.write(line.replace(file.path, tilde(file.path, home)));
      } else {
        const backup = file.backup ? ` (backup ${tilde(file.backup, home)})` : "";
        io.write(`  ${PAST[file.action]} ${tilde(file.path, home)}${backup}`);
      }
    }
    io.write("");
  }
  io.write(report.dryRun ? "Dry run: no files were changed." : "Done.");
  return failed ? 1 : 0;
}
