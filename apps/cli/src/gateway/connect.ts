import {
  type AgentId,
  GATEWAY_PROVIDER,
  type GatewaySpec,
  gooseGatewayProvider,
  tomlValue,
} from "@selfhost/agents";
import type { RouterTool } from "@selfhost/schema";

/**
 * The agent connection kit: the settings that send one agent's model traffic through the AI
 * gateway with a virtual key. Only API key traffic can go through it.
 */

export const CONNECT_AGENTS = ["claude-code", "codex", "opencode", "goose", "env"] as const;
export type ConnectAgent = (typeof CONNECT_AGENTS)[number];

const ALIASES: Record<string, ConnectAgent> = {
  claude: "claude-code",
  claude_code: "claude-code",
};

/** The agent whose own config files connect writes; env writes none. */
export const AGENT_ID: Record<ConnectAgent, AgentId | null> = {
  "claude-code": "claude_code",
  codex: "codex",
  opencode: "opencode",
  goose: "goose",
  env: null,
};

/**
 * Agents whose model traffic can't go through a gateway: it leaves from the vendor's own
 * servers. Their usage is read from the vendor's admin API instead.
 */
export const ADMIN_API_AGENTS: Record<string, { name: string; vendor: string }> = {
  cursor: { name: "Cursor", vendor: "Cursor" },
  "cursor-agent": { name: "Cursor", vendor: "Cursor" },
  copilot: { name: "GitHub Copilot", vendor: "GitHub" },
  "github-copilot": { name: "GitHub Copilot", vendor: "GitHub" },
};

export type ConnectTarget =
  | { kind: "agent"; agent: ConnectAgent }
  | { kind: "admin_api"; name: string; message: string };

export function adminApiMessage(name: string, vendor: string): string {
  return `${name} sends model traffic from ${vendor}'s own servers, so it can't use the gateway, and nothing was changed. selfhost reads ${name}'s usage from ${vendor}'s admin API instead.`;
}

export function connectTarget(name: string): ConnectTarget {
  const key = name.trim().toLowerCase();
  const found = ALIASES[key] ?? CONNECT_AGENTS.find((agent) => agent === key);
  if (found) return { kind: "agent", agent: found };
  const admin = ADMIN_API_AGENTS[key];
  if (admin) {
    return {
      kind: "admin_api",
      name: admin.name,
      message: adminApiMessage(admin.name, admin.vendor),
    };
  }
  throw new Error(
    `Unknown agent "${name}": expected ${CONNECT_AGENTS.join(", ")} (cursor and copilot can't use a gateway)`,
  );
}

/** Where each SDK style reaches the gateway. */
export function gatewayUrls(tool: RouterTool, baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, "");
  return tool === "bifrost"
    ? { anthropic: `${base}/anthropic`, openai: `${base}/openai/v1` }
    : { anthropic: base, openai: `${base}/v1` };
}

export function gatewaySpec(tool: RouterTool, baseUrl: string, key: string): GatewaySpec {
  return { ...gatewayUrls(tool, baseUrl), key };
}

/** Claude Code's managed settings drop-in folder (2.1.83 or later), per platform. */
const CLAUDE_MANAGED_DIR: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "/Library/Application Support/ClaudeCode/managed-settings.d",
  linux: "/etc/claude-code/managed-settings.d",
  win32: "C:\\Program Files\\ClaudeCode\\managed-settings.d",
};

export function claudeManagedPath(platform: NodeJS.Platform): string {
  const dir = CLAUDE_MANAGED_DIR[platform] ?? CLAUDE_MANAGED_DIR.linux;
  return `${dir}${platform === "win32" ? "\\" : "/"}selfhost-gateway.json`;
}

export interface ConnectKit {
  agent: ConnectAgent;
  /** Where the settings go, for people pasting them. */
  target: string;
  /** The settings as text to paste. */
  text: string;
  notes: string[];
}

export const SUBSCRIPTION_NOTE =
  "Only API key traffic goes through the gateway. A subscription login (a Claude plan, a ChatGPT plan) sends its traffic straight to the vendor, so the gateway's budgets, keys and usage don't cover it.";

const BIFROST_MODELS = "On Bifrost, name models with their provider: openai/gpt-5.5.";

export function connectKit(agent: ConnectAgent, tool: RouterTool, spec: GatewaySpec): ConnectKit {
  switch (agent) {
    case "claude-code":
      return {
        agent,
        target: "the env block of ~/.claude/settings.json",
        text: JSON.stringify(
          { env: { ANTHROPIC_BASE_URL: spec.anthropic, ANTHROPIC_AUTH_TOKEN: spec.key } },
          null,
          2,
        ),
        notes: [
          SUBSCRIPTION_NOTE,
          "A repository's .claude/settings.json can set ANTHROPIC_BASE_URL too, and wins over yours: --managed prints a managed settings file that no project can override.",
        ],
      };
    case "codex": {
      const provider = {
        name: "selfhost gateway",
        base_url: spec.openai,
        wire_api: "responses",
        experimental_bearer_token: spec.key,
      };
      return {
        agent,
        target: "the top of ~/.codex/config.toml, before any [table]",
        text: [
          `model_provider = ${tomlValue(GATEWAY_PROVIDER)}`,
          `model_providers.${GATEWAY_PROVIDER} = ${tomlValue(provider)}`,
        ].join("\n"),
        notes: [SUBSCRIPTION_NOTE, ...(tool === "bifrost" ? [BIFROST_MODELS] : [])],
      };
    }
    case "opencode":
      return {
        agent,
        target: "opencode.json in the project, or ~/.config/opencode/opencode.json",
        text: JSON.stringify(
          {
            provider: {
              anthropic: { options: { baseURL: `${spec.anthropic}/v1`, apiKey: spec.key } },
              openai: { options: { baseURL: spec.openai, apiKey: spec.key } },
            },
          },
          null,
          2,
        ),
        notes: [SUBSCRIPTION_NOTE],
      };
    case "goose":
      return {
        agent,
        target: `~/.config/goose/custom_providers/${GATEWAY_PROVIDER}.json (Windows: %APPDATA%\\Block\\goose\\config\\custom_providers)`,
        text: gooseGatewayProvider(spec).trimEnd(),
        notes: [
          `Goose uses it once picked: goose session --provider ${GATEWAY_PROVIDER}, or make it the default in goose configure.`,
          "Goose talks to it OpenAI-style, so models are the gateway's names for them.",
          ...(tool === "bifrost"
            ? ["On Bifrost: anthropic/claude-sonnet-4-5, openai/gpt-5.5."]
            : []),
        ],
      };
    case "env":
      return {
        agent,
        target: "the environment of any tool built on the Anthropic or OpenAI SDKs",
        text: [
          `export ANTHROPIC_BASE_URL=${spec.anthropic}`,
          `export ANTHROPIC_AUTH_TOKEN=${spec.key}`,
          `export OPENAI_BASE_URL=${spec.openai}`,
          `export OPENAI_API_KEY=${spec.key}`,
        ].join("\n"),
        notes: [SUBSCRIPTION_NOTE],
      };
  }
}

/** Claude Code's managed settings drop-in with the gateway, which wins over every other setting. */
export function claudeManagedKit(spec: GatewaySpec, platform: NodeJS.Platform): ConnectKit {
  return {
    agent: "claude-code",
    target: `${claudeManagedPath(platform)} (needs admin rights; mode 0644 so Claude Code can read it)`,
    text: JSON.stringify(
      { env: { ANTHROPIC_BASE_URL: spec.anthropic, ANTHROPIC_AUTH_TOKEN: spec.key } },
      null,
      2,
    ),
    notes: [
      SUBSCRIPTION_NOTE,
      "Managed settings win over user and project settings, so no repository can point Claude Code elsewhere. Every account on the laptop can read the file, key included. Claude Code 2.1.83 or later reads managed-settings.d.",
    ],
  };
}
