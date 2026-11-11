import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_IDS,
  AGENT_NAMES,
  type AgentConfigPlan,
  type AgentId,
  type McpServerSpec,
  planAgentConfig,
  removeAgentConfig,
  type Which,
} from "@selfhost/agents";
import { createMcpServer, createProxyServer, serveStdio } from "@selfhost/mcp";
import { MCP_SERVER_NAME, type McpItemStatus } from "@selfhost/schema";
import type { Command } from "commander";
import {
  AGENT_ALIASES,
  type AgentsIo,
  agentScope,
  agentsReport,
  applyConfigure,
  tilde,
} from "../agents.js";
import { table } from "../format.js";
import { exceptionsDir, readGrant } from "../hooks/exceptions.js";
import { exceptionTrust } from "../hooks/trust.js";
import { refreshGrants, serverGrants } from "../inbox/grants.js";
import { type Fetch, serverUrl, TeamClient } from "../team/client.js";
import { type Membership, readMembership } from "../team/config.js";
import { type LocalMcpOptions, localMcpData } from "./local.js";

/**
 * `selfhost mcp`: the agent MCP server on stdio. Solo, it answers from this machine's ledger and
 * selfhost.toml. In a team, it hands every call to the team server's /v1/mcp with the person
 * token from `selfhost join`, so the server's permissions apply and no token is written into an
 * agent's config; approved exceptions still become grants here, where the blocked call was made.
 *
 * `selfhost mcp install | uninstall` add or remove the `selfhost` entry in each agent's MCP
 * config through packages/agents, under a profile of its own, apart from `selfhost init`,
 * `agents configure` and `guard install`.
 */

/** The profile the entries are recorded under (~/.selfhost/agents/<agent>.mcp.json). */
export const MCP_PROFILE = "mcp";

export interface McpIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  configPath: string;
  fetch?: Fetch;
  /** A fixed clock, for tests. */
  now?: Date;
}

export interface McpServeOptions extends LocalMcpOptions {
  /** Ignore a team membership and answer from this machine's ledger. */
  local?: boolean;
}

/** Text a tool result carries for the agent: the structured content, as JSON. */
const asResult = (status: McpItemStatus): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(status) }],
  structuredContent: status as unknown as Record<string, unknown>,
});

/**
 * In team mode: after the server says an exception this machine asked for was approved, fetches
 * the grant it signed (as `selfhost import` would on its next sync), keeps it when it verifies
 * with a pinned key, and tells the agent it may go.
 */
export function grantsOnResult(membership: Membership, configPath: string, fetch: Fetch) {
  const dir = exceptionsDir(dirname(configPath));
  const client = new TeamClient(serverUrl(membership.server), membership.token, fetch);
  return async (name: string, result: CallToolResult): Promise<CallToolResult> => {
    if (result.isError || (name !== "get_answer" && name !== "request_exception")) return result;
    const status = result.structuredContent as McpItemStatus | undefined;
    if (status?.kind !== "exception" || status.state !== "answered") return result;
    const now = new Date();
    const trust = exceptionTrust(configPath, process.platform);
    await refreshGrants(configPath, serverGrants(client), now, trust);
    const grant = readGrant(dir, status.item_id, now, trust.keys);
    if (!grant) return result;
    return asResult({
      ...status,
      grant: { expires_at: grant.expires_at },
      next: "Approved. Make the identical call again now: it is allowed once.",
    });
  };
}

/** The server `selfhost mcp` runs: a proxy to the team server, or the local one. */
export function mcpServer(options: McpServeOptions, io: McpIo, version: string): Server {
  const membership = options.local ? undefined : readMembership(io.configPath);
  if (membership) {
    const fetch = io.fetch ?? ((url, init) => globalThis.fetch(url, init));
    return createProxyServer({
      url: new URL(`${serverUrl(membership.server)}/v1/mcp`),
      token: membership.token,
      version,
      fetch: (url, init) => fetch(String(url), init ?? {}),
      onResult: grantsOnResult(membership, io.configPath, fetch),
    });
  }
  const fixed = io.now;
  const now = fixed ? () => fixed : () => new Date();
  return createMcpServer(localMcpData(io, options, now), {
    version,
    now,
    exposeErrors: true,
    onError: (error) => console.error("selfhost mcp:", error),
  });
}

/** `selfhost mcp` when selfhost is on PATH; otherwise the absolute command running now. */
export function mcpCommand(which: Which | undefined): { spec: McpServerSpec; warning?: string } {
  if (which?.("selfhost")) return { spec: { command: "selfhost", args: ["mcp"] } };
  const script = process.argv[1];
  const self =
    script && /\.[cm]?js$/.test(script) && existsSync(script)
      ? [process.execPath, script]
      : [process.execPath];
  const [command = process.execPath, ...args] = self;
  return {
    spec: { command, args: [...args, "mcp"] },
    warning:
      "selfhost is not on PATH, so the agents run selfhost mcp from where it runs now. For a path that lasts, install it (npm install -g selfhostai) and run selfhost mcp install again.",
  };
}

export interface McpInstallOptions {
  agent?: string[];
  dryRun?: boolean;
  json?: boolean;
  /** Treat this folder as the home directory; for fixtures and tests. */
  home?: string;
}

/** `selfhost mcp install|uninstall --json`. */
export interface McpInstallReport {
  schema: "selfhost.mcp_install/v1";
  action: "install" | "uninstall";
  dry_run: boolean;
  home: string;
  /** The command each agent runs. */
  command: string[];
  agents: {
    id: AgentId;
    name: string;
    status: string;
    path: string | null;
    backup: string | null;
    message: string | null;
  }[];
  warnings: string[];
}

function chooseAgents(options: McpInstallOptions, io: AgentsIo, remove: boolean): AgentId[] {
  if (options.agent?.length) {
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
  if (remove) return [...AGENT_IDS];
  return agentsReport({ home: options.home }, io)
    .agents.filter((agent) => agent.installed || agent.configExists)
    .map((agent) => agent.id);
}

/** Adds or removes the selfhost MCP server in each agent's config; returns the exit code. */
export function runMcpInstall(
  action: McpInstallReport["action"],
  options: McpInstallOptions,
  io: AgentsIo,
): number {
  const scope = agentScope(options.home, io);
  const remove = action === "uninstall";
  const { spec, warning } = mcpCommand(io.probes.which);
  const base = {
    home: scope.home,
    processEnv: scope.env,
    platform: io.platform,
    profile: MCP_PROFILE,
  };
  const plans: AgentConfigPlan[] = chooseAgents(options, io, remove).map((agent) =>
    remove
      ? removeAgentConfig(agent, base)
      : planAgentConfig(agent, { ...base, mcpServers: { [MCP_SERVER_NAME]: spec } }),
  );
  const configured = applyConfigure(scope.home, plans, { dryRun: options.dryRun, remove }, io);
  const report: McpInstallReport = {
    schema: "selfhost.mcp_install/v1",
    action,
    dry_run: options.dryRun ?? false,
    home: scope.home,
    command: [spec.command ?? "", ...(spec.args ?? [])],
    agents: plans.map((plan) => {
      const item = plan.items.find((entry) => entry.item === `mcp:${MCP_SERVER_NAME}`);
      const backup = configured.agents
        .find((entry) => entry.agent === plan.agent)
        ?.files.find((file) => file.path === item?.path)?.backup;
      return {
        id: plan.agent,
        name: AGENT_NAMES[plan.agent],
        status: item?.status ?? "unchanged",
        path: item?.path ?? null,
        backup: backup ?? null,
        message: item?.message ?? null,
      };
    }),
    warnings: warning && !remove ? [warning] : [],
  };
  const failed = plans.some((plan) => plan.items.some((item) => item.status === "error"));
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return failed ? 1 : 0;
  }
  if (report.dry_run) io.write("Dry run: nothing is written.");
  io.write(`MCP server "${MCP_SERVER_NAME}": ${report.command.join(" ")}`);
  if (report.agents.length === 0) io.write("  No agents found. Pass --agent to choose one.");
  table(
    report.agents.map((agent) => [
      `  ${agent.name}`,
      agent.status,
      [
        agent.path ? tilde(agent.path, scope.home) : "",
        agent.backup ? `backup ${tilde(agent.backup, scope.home)}` : "",
        agent.message ?? "",
      ]
        .filter(Boolean)
        .join("  "),
    ]),
    io.write,
  );
  for (const line of report.warnings) io.write(`Note: ${line}`);
  if (!remove && !report.dry_run && report.agents.length > 0) {
    io.write(
      "Restart the agents to load it. In a team, selfhost mcp talks to the team server as you; solo, it reads this machine's ledger.",
    );
  }
  return failed ? 1 : 0;
}

export function registerMcp(
  program: Command,
  io: () => McpIo & AgentsIo & { setExitCode: (code: number) => void },
  version: string,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const mcp = program
    .command("mcp")
    .description(
      "the MCP server for agents on stdio: the policy, budget, review items, file history, decisions, and asking a person (agents run this)",
    )
    .option("--local", "answer from this machine's ledger even in a team")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .enablePositionalOptions()
    .action(async (options: McpServeOptions) => {
      try {
        await serveStdio(mcpServer(options, io(), version));
      } catch (error) {
        fail(error, false);
      }
    });

  const actions = [
    [
      "install",
      "add the selfhost MCP server to each agent found (Claude Code, Codex, Cursor, ...)",
    ],
    ["uninstall", "take the selfhost MCP server out of each agent's config again"],
  ] as const;
  for (const [action, description] of actions) {
    mcp
      .command(action)
      .description(description)
      .option(
        "--agent <name...>",
        "claude, codex, cursor, opencode or goose (default: the ones found)",
      )
      .option("--dry-run", "print what would change and write nothing")
      .option("--json", "print one selfhost.mcp_install/v1 object")
      .option("--home <dir>", "use this folder as the home directory (for testing)")
      .action((options: McpInstallOptions) => {
        try {
          const own = io();
          own.setExitCode(runMcpInstall(action, options, own));
        } catch (error) {
          fail(error, options.json);
        }
      });
  }
}
