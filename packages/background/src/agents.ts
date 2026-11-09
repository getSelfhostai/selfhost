import type { AgentId } from "@selfhost/agents";
import type { AgentVendor, BackgroundAgent } from "@selfhost/schema";
import type { GatewayAccess } from "./types.js";

/** Quotes a value for a POSIX shell. */
export function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** How selfhost drives one agent CLI headless. selfhost installs and runs it; it is not ours. */
export interface AgentCli {
  name: BackgroundAgent;
  /** The id packages/agents knows it by, for writing hook settings. */
  id: AgentId;
  vendor: AgentVendor;
  /** The executable, checked with `command -v` before installing. */
  bin: string;
  /** Installs the CLI in an image that lacks it. */
  install: string;
  /** The headless command for a task; the output is one JSON object per line where it can be. */
  command(task: string): string;
  /** Branch prefix GitHub attribution reads as this agent. */
  branchPrefix: string;
  /** The line selfhost's attribution reads as this agent in a pull request body. */
  footer: string;
  /** Environment that sends the agent's model traffic through the gateway with a run's key. */
  gatewayEnv(gateway: GatewayAccess): Record<string, string>;
  /** Whether the agent has hook settings selfhost can install, so the team's rules apply. */
  hooks: boolean;
}

const anthropicEnv = (g: GatewayAccess) => ({
  ANTHROPIC_BASE_URL: g.anthropic,
  ANTHROPIC_AUTH_TOKEN: g.key,
});
const openaiEnv = (g: GatewayAccess) => ({ OPENAI_BASE_URL: g.openai, OPENAI_API_KEY: g.key });

export const AGENT_CLIS: Readonly<Record<BackgroundAgent, AgentCli>> = {
  claude: {
    name: "claude",
    id: "claude_code",
    vendor: "claude_code",
    bin: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    // Hooks still run under this mode: PreToolUse blocks are applied before permissions.
    command: (task) =>
      `claude -p ${sh(task)} --output-format stream-json --verbose --permission-mode bypassPermissions`,
    branchPrefix: "claude/",
    footer: "Generated with [Claude Code](https://claude.com/claude-code)",
    gatewayEnv: anthropicEnv,
    hooks: true,
  },
  codex: {
    name: "codex",
    id: "codex",
    vendor: "codex",
    bin: "codex",
    install: "npm install -g @openai/codex",
    command: (task) => `codex exec --json --full-auto --skip-git-repo-check ${sh(task)}`,
    branchPrefix: "codex/",
    footer: "Generated with [Codex](https://openai.com/codex)",
    gatewayEnv: openaiEnv,
    hooks: true,
  },
  opencode: {
    name: "opencode",
    id: "opencode",
    vendor: "opencode",
    bin: "opencode",
    install: "npm install -g opencode-ai",
    command: (task) => `opencode run --format json ${sh(task)}`,
    branchPrefix: "opencode/",
    footer: "Generated with OpenCode",
    gatewayEnv: (g) => ({ ...anthropicEnv(g), ...openaiEnv(g) }),
    hooks: false,
  },
  goose: {
    name: "goose",
    id: "goose",
    vendor: "goose",
    bin: "goose",
    install:
      "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash",
    command: (task) => `goose run --no-session --output-format stream-json -t ${sh(task)}`,
    branchPrefix: "goose/",
    footer: "Generated with Goose",
    gatewayEnv: (g) => ({ ...anthropicEnv(g), ...openaiEnv(g) }),
    hooks: false,
  },
};

/** A branch name no other run has: the agent's prefix, a slug of the task and the run id's tail. */
export function runBranch(agent: BackgroundAgent, task: string, runId: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const tail = runId
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(-8)
    .toLowerCase();
  return `${AGENT_CLIS[agent].branchPrefix}selfhost-${slug ? `${slug}-` : ""}${tail}`;
}
