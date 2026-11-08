import type { RouterTool } from "@selfhost/schema";

/**
 * The agent connection kit: the settings that send one agent's model traffic through the AI
 * gateway with a virtual key. Only API key traffic can go through it.
 */

export const CONNECT_AGENTS = ["claude-code", "codex", "opencode", "env"] as const;
export type ConnectAgent = (typeof CONNECT_AGENTS)[number];

const ALIASES: Record<string, ConnectAgent> = {
  claude: "claude-code",
  "claude-code": "claude-code",
};

/** Agents that cannot use a gateway, and why. */
export const CANNOT_CONNECT: Record<string, string> = {
  cursor:
    "Cursor sends model traffic from its own servers, which cannot reach a gateway on your network, and its own plans are billed by Cursor.",
  copilot: "GitHub Copilot sends model traffic from GitHub's servers and bills it to the seat.",
  goose:
    "Goose can, but selfhost does not write its settings yet: point its Anthropic or OpenAI host at the URLs `selfhost gateway connect env` prints.",
};

export function connectAgent(name: string): ConnectAgent {
  const key = name.trim().toLowerCase();
  const found = ALIASES[key] ?? CONNECT_AGENTS.find((agent) => agent === key);
  if (found) return found;
  const why = CANNOT_CONNECT[key];
  if (why) throw new Error(`${name} cannot use the gateway here: ${why}`);
  throw new Error(`Unknown agent "${name}": expected ${CONNECT_AGENTS.join(", ")}`);
}

/** Where each SDK style reaches the gateway. */
export function gatewayUrls(tool: RouterTool, baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, "");
  return tool === "bifrost"
    ? { anthropic: `${base}/anthropic`, openai: `${base}/openai/v1` }
    : { anthropic: base, openai: `${base}/v1` };
}

/** Name of the variable that holds the key for Codex and the env kit. */
export const KEY_VARIABLE = "SELFHOST_GATEWAY_KEY";

export interface ConnectKit {
  agent: ConnectAgent;
  /** Where the settings go, for people. */
  target: string;
  /** The settings as text to paste. */
  text: string;
  /** For Claude Code: the env entries --write merges into ~/.claude/settings.json. */
  claudeEnv?: Record<string, string>;
  notes: string[];
}

const SUBSCRIPTION_NOTE =
  "This uses API billing through the gateway, where the team's budgets stop it. A subscription login (Claude Pro or Max, a ChatGPT plan) keeps going straight to the vendor, and nothing outside the vendor can cap it.";

export function connectKit(
  agent: ConnectAgent,
  tool: RouterTool,
  baseUrl: string,
  key: string,
): ConnectKit {
  const urls = gatewayUrls(tool, baseUrl);
  switch (agent) {
    case "claude-code": {
      const claudeEnv = { ANTHROPIC_BASE_URL: urls.anthropic, ANTHROPIC_AUTH_TOKEN: key };
      return {
        agent,
        target:
          "~/.claude/settings.json (selfhost gateway connect claude-code --write merges it in)",
        text: JSON.stringify({ env: claudeEnv }, null, 2),
        claudeEnv,
        notes: [
          SUBSCRIPTION_NOTE,
          "Remove CLAUDE_CODE_USE_BEDROCK or CLAUDE_CODE_USE_VERTEX if set: they send Claude Code to the cloud provider instead of the gateway.",
        ],
      };
    }
    case "codex":
      return {
        agent,
        target: "~/.codex/config.toml, and the key in your shell profile",
        text: [
          'model_provider = "selfhost"',
          "",
          "[model_providers.selfhost]",
          'name = "selfhost gateway"',
          `base_url = "${urls.openai}"`,
          'wire_api = "responses"',
          `env_key = "${KEY_VARIABLE}"`,
          "requires_openai_auth = false",
          "",
          `# In your shell profile: export ${KEY_VARIABLE}=${key}`,
        ].join("\n"),
        notes: [
          SUBSCRIPTION_NOTE,
          "Run /logout in Codex first: it prefers a ChatGPT login over a configured provider.",
          ...(tool === "bifrost"
            ? ["On Bifrost, name models with their provider: openai/gpt-5.5."]
            : []),
        ],
      };
    case "opencode":
      return {
        agent,
        target: "opencode.json in the project, or ~/.config/opencode/opencode.json",
        text: JSON.stringify(
          {
            provider: {
              anthropic: { options: { baseURL: `${urls.anthropic}/v1`, apiKey: key } },
              openai: { options: { baseURL: urls.openai, apiKey: key } },
            },
          },
          null,
          2,
        ),
        notes: [SUBSCRIPTION_NOTE],
      };
    case "env":
      return {
        agent,
        target: "the environment of any tool built on the Anthropic or OpenAI SDKs",
        text: [
          `export ANTHROPIC_BASE_URL=${urls.anthropic}`,
          `export ANTHROPIC_AUTH_TOKEN=${key}`,
          `export OPENAI_BASE_URL=${urls.openai}`,
          `export OPENAI_API_KEY=${key}`,
        ].join("\n"),
        notes: [SUBSCRIPTION_NOTE],
      };
  }
}
