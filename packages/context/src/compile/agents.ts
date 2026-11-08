import type { ContextAgent } from "@selfhost/schema";

// Vendor docs, checked 2026-11-08. Each kind module cites the page its mapping follows.

export const AGENT_NAMES: Record<ContextAgent, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  goose: "Goose",
};

export const AGENT_DOCS: Record<ContextAgent, string[]> = {
  claude_code: [
    "https://code.claude.com/docs/en/memory",
    "https://code.claude.com/docs/en/skills",
    "https://code.claude.com/docs/en/sub-agents",
    "https://code.claude.com/docs/en/mcp",
  ],
  codex: [
    "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
    "https://learn.chatgpt.com/docs/build-skills",
    "https://learn.chatgpt.com/docs/custom-prompts",
    "https://learn.chatgpt.com/docs/agent-configuration/subagents",
    "https://learn.chatgpt.com/docs/extend/mcp",
  ],
  cursor: [
    "https://cursor.com/docs/context/rules",
    "https://cursor.com/docs/context/skills",
    "https://cursor.com/docs/context/subagents",
    "https://cursor.com/docs/context/mcp",
  ],
  copilot: [
    "https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions",
    "https://docs.github.com/en/copilot/reference/custom-instructions-support",
    "https://docs.github.com/en/copilot/concepts/agents/about-agent-skills",
    "https://code.visualstudio.com/docs/agent-customization/prompt-files",
    "https://docs.github.com/en/copilot/reference/custom-agents-configuration",
    "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
  ],
  gemini: [
    "https://geminicli.com/docs/cli/gemini-md/",
    "https://geminicli.com/docs/cli/skills/",
    "https://geminicli.com/docs/cli/custom-commands/",
    "https://geminicli.com/docs/core/subagents/",
    "https://geminicli.com/docs/tools/mcp-server/",
  ],
  opencode: [
    "https://opencode.ai/docs/instructions/",
    "https://opencode.ai/docs/skills/",
    "https://opencode.ai/docs/commands/",
    "https://opencode.ai/docs/agents/",
    "https://opencode.ai/docs/mcp-servers/",
    "https://opencode.ai/docs/migrate-v1/",
  ],
  goose: [
    "https://goose-docs.ai/docs/guides/context-engineering/using-goosehints/",
    "https://goose-docs.ai/docs/guides/context-engineering/using-skills/",
    "https://goose-docs.ai/docs/guides/context-engineering/custom-agents/",
    "https://goose-docs.ai/docs/guides/context-engineering/slash-commands/",
    "https://goose-docs.ai/docs/guides/config-files/",
  ],
};

/**
 * Repository paths each agent loads on its own, whichever agent selfhost wrote them for. A
 * trailing / is a folder. From the docs above:
 *
 * - CLAUDE.md: Claude Code; Cursor reads it always applied; Copilot's cloud agent and CLI.
 * - AGENTS.md: Codex, Cursor, Copilot, OpenCode and Goose. Claude Code only when there is no
 *   CLAUDE.md, which selfhost writes whenever it compiles for Claude Code.
 * - GEMINI.md: Gemini CLI, and Copilot's cloud agent and CLI.
 * - .claude/rules, .claude/commands: Claude Code and the Copilot CLI.
 * - .claude/skills: Claude Code, Cursor, Copilot, OpenCode and Goose.
 * - .claude/agents: Claude Code, Cursor, the Copilot CLI and VS Code, and Goose.
 * - .agents/skills: Codex, Cursor, Copilot, Gemini CLI (it wins over .gemini/skills),
 *   OpenCode and Goose.
 * - .codex/agents: Codex and Cursor. .mcp.json: Claude Code, the Copilot CLI and VS Code.
 */
export const READERS: readonly (readonly [string, readonly ContextAgent[]])[] = [
  ["CLAUDE.md", ["claude_code", "cursor", "copilot"]],
  ["AGENTS.md", ["codex", "cursor", "copilot", "opencode", "goose"]],
  ["GEMINI.md", ["gemini", "copilot"]],
  [".goosehints", ["goose"]],
  [".mcp.json", ["claude_code", "copilot"]],
  [".claude/rules/", ["claude_code", "copilot"]],
  [".claude/skills/", ["claude_code", "cursor", "copilot", "opencode", "goose"]],
  [".claude/commands/", ["claude_code", "copilot"]],
  [".claude/agents/", ["claude_code", "cursor", "copilot", "goose"]],
  [".agents/skills/", ["codex", "cursor", "copilot", "gemini", "opencode", "goose"]],
  [".agents/agents/", ["goose"]],
  [".codex/config.toml", ["codex"]],
  [".codex/agents/", ["codex", "cursor"]],
  [".cursor/rules/", ["cursor"]],
  [".cursor/skills/", ["cursor"]],
  [".cursor/agents/", ["cursor"]],
  [".cursor/mcp.json", ["cursor"]],
  [".github/copilot-instructions.md", ["copilot"]],
  [".github/instructions/", ["copilot"]],
  [".github/prompts/", ["copilot"]],
  [".github/agents/", ["copilot"]],
  [".gemini/settings.json", ["gemini"]],
  [".gemini/commands/", ["gemini"]],
  [".gemini/agents/", ["gemini"]],
  ["opencode.json", ["opencode"]],
  [".opencode/commands/", ["opencode"]],
  [".opencode/agents/", ["opencode"]],
];

/** The READERS entry a path falls under: the file itself or its folder, like .claude/skills/. */
export function readerKey(path: string): string | undefined {
  return READERS.find(([key]) => (key.endsWith("/") ? path.startsWith(key) : path === key))?.[0];
}

export function readersOf(path: string): readonly ContextAgent[] {
  const key = readerKey(path);
  return READERS.find(([candidate]) => candidate === key)?.[1] ?? [];
}

/** "A", "A and B", "A, B and C". */
export function listed(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

export const namesOf = (agents: readonly ContextAgent[]) =>
  listed(agents.map((agent) => AGENT_NAMES[agent]));
