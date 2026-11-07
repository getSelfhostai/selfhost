import type { AgentVendor } from "./types.js";

/**
 * What each agent leaves behind in git and on GitHub. Each entry names where the string comes
 * from; entries marked "observed" come from real commits and pull requests, not from the vendor's
 * docs, and are the first to check when a vendor changes its output.
 */

export interface CoAuthorRule {
  vendor: AgentVendor;
  email: RegExp;
  /** Model id from the trailer's name, when the vendor puts one there. */
  model?: (name: string) => string | undefined;
}

/** `Co-authored-by: Claude Opus 4.5 <...>` gives `claude-opus-4-5`, the API model id. */
export function claudeModel(name: string): string | undefined {
  const match = /^Claude\s+([A-Za-z]+)\s+(\d+(?:\.\d+)*)\b/.exec(name.trim());
  if (!match?.[1] || !match[2]) return undefined;
  return `claude-${match[1].toLowerCase()}-${match[2].replaceAll(".", "-")}`;
}

/** `Co-authored-by: aider (gpt-5) <...>` gives `gpt-5`. */
function aiderModel(name: string): string | undefined {
  return /^aider\s+\((.+)\)$/i.exec(name.trim())?.[1]?.trim() || undefined;
}

/**
 * Co-author trailers, matched on the email so a person who happens to be named Claude is not an
 * agent. Bot accounts' GitHub noreply addresses are matched through BOT_LOGINS below.
 */
export const CO_AUTHORS: CoAuthorRule[] = [
  // Name is the model, e.g. "Claude Opus 4.5", else "Claude" or "Claude Code".
  // https://code.claude.com/docs/en/settings-reference (attribution)
  { vendor: "claude_code", email: /^noreply@anthropic\.com$/i, model: claudeModel },
  // "Co-authored-by: Codex <noreply@openai.com>", no model.
  // https://github.com/openai/codex/blob/main/codex-rs/ext/git-attribution/src/world_state.rs
  { vendor: "codex", email: /^noreply@openai\.com$/i },
  // Cursor cloud agents, observed: "Cursor Agent <cursoragent@cursor.com>".
  { vendor: "cursor", email: /^cursoragent@cursor\.com$/i },
  // Aider: "aider (<model>) <aider@aider.chat>", older releases used noreply@aider.chat.
  // https://github.com/Aider-AI/aider/blob/main/aider/repo.py
  { vendor: "other", email: /^(?:aider|noreply)@aider\.chat$/i, model: aiderModel },
  // Amp: "Amp <amp@ampcode.com>". https://ampcode.com/docs/cli/settings
  { vendor: "other", email: /^amp@ampcode\.com$/i },
];

export interface FooterRule {
  vendor: AgentVendor;
  pattern: RegExp;
}

/** Attribution lines a vendor adds to commit messages or pull request bodies. */
export const FOOTERS: FooterRule[] = [
  // https://code.claude.com/docs/en/settings-reference (attribution.pr); the GitHub Action
  // links claude.ai/code instead (anthropics/claude-code-action, src/create-prompt/index.ts).
  {
    vendor: "claude_code",
    pattern:
      /Generated with \[Claude Code\]\(https:\/\/(?:claude\.com\/claude-code|claude\.ai\/code)\/?\)/,
  },
  // codex-rs/ext/git-attribution/src/world_state.rs
  { vendor: "codex", pattern: /Generated with \[Codex\]\(https:\/\/openai\.com\/codex\/?\)/ },
  // attribution.attributeCommitsToAgent, https://cursor.com/docs/cli/reference/configuration;
  // the trailer text is observed.
  { vendor: "cursor", pattern: /^Made-with:\s*Cursor\s*$/im },
];

/** GitHub App accounts that write code. Logins ending in [bot] belong to apps only. */
export const BOT_LOGINS: Record<string, AgentVendor> = {
  // Copilot coding agent; the REST API shows it as login "Copilot", type "Bot".
  // https://docs.github.com/en/copilot/responsible-use/agents
  "copilot-swe-agent[bot]": "copilot",
  // claude-code-action default bot_name. https://github.com/anthropics/claude-code-action/blob/main/action.yml
  "claude[bot]": "claude_code",
  "claude-code[bot]": "claude_code",
  // GitHub Agent HQ accounts, shown as logins "Claude" and "Codex".
  "anthropic-code-agent[bot]": "claude_code",
  "openai-code-agent[bot]": "codex",
  // Codex cloud and code review. https://developers.openai.com/codex/integrations/github
  "chatgpt-codex-connector[bot]": "codex",
  // Cursor Bugbot and cloud agents (observed; the docs do not name the account).
  "cursor[bot]": "cursor",
  // OpenCode GitHub agent git identity, packages/opencode/src/cli/cmd/github.ts.
  "opencode-agent[bot]": "opencode",
  // https://docs.devin.ai/integrations/gh
  "devin-ai-integration[bot]": "other",
  // https://jules.google/docs/code
  "google-labs-jules[bot]": "other",
};

/**
 * Agent accounts GitHub shows under a plain login. These count only with `type: "Bot"` on an API
 * user, or with one of these account ids in a noreply email.
 */
export const AGENT_LOGINS: Record<string, { vendor: AgentVendor; ids: number[] }> = {
  copilot: { vendor: "copilot", ids: [198982749, 223556219] },
  claude: { vendor: "claude_code", ids: [242468646] },
  codex: { vendor: "codex", ids: [242516109] },
};

/** Branch prefixes agents use for branches they create. */
export const BRANCH_PREFIXES: [string, AgentVendor][] = [
  // Claude Code on the web and routines (https://code.claude.com/docs/en/routines), and the
  // GitHub Action's branch_prefix default.
  ["claude/", "claude_code"],
  // Codex cloud (observed).
  ["codex/", "codex"],
  // Cursor cloud agents: cursor/<slug>-<4hex>. https://cursor.com/docs/cloud-agent/api/endpoints
  ["cursor/", "cursor"],
  // https://docs.github.com/en/copilot/responsible-use/agents
  ["copilot/", "copilot"],
  // opencode/issue<N>-<timestamp>, packages/opencode/src/cli/cmd/github.ts
  ["opencode/", "opencode"],
  // Devin (observed): devin/<unix-ts>-<slug>.
  ["devin/", "other"],
];

export interface SessionLinkRule {
  vendor: AgentVendor;
  /** The first group is the session id. */
  pattern: RegExp;
}

/** Session links agents put in commit trailers and pull request bodies. */
export const SESSION_LINKS: SessionLinkRule[] = [
  // "Claude-Session: https://claude.ai/code/session_..." trailer and the PR body line.
  // https://code.claude.com/docs/en/cloud-environments
  { vendor: "claude_code", pattern: /https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)/g },
  // Codex cloud task footer (observed), old and new path.
  {
    vendor: "codex",
    pattern: /https:\/\/chatgpt\.com\/codex\/(?:cloud\/)?tasks\/(task_[a-z]_[0-9a-f]+)/g,
  },
  // https://cursor.com/docs/cloud-agent/api/endpoints; background-agent?bcId= is observed.
  {
    vendor: "cursor",
    pattern:
      /https:\/\/(?:www\.)?cursor\.com\/(?:agents\/|background-agent\?bcId=)(bc-[0-9a-f-]+)/g,
  },
  // OpenCode share links, packages/opencode/src/cli/cmd/github.ts.
  { vendor: "opencode", pattern: /https:\/\/opencode\.ai\/s\/([A-Za-z0-9]+)/g },
  // Amp-Thread-ID trailer. https://ampcode.com/docs/cli/settings
  { vendor: "other", pattern: /https:\/\/ampcode\.com\/threads\/(T-[0-9a-f-]+)/g },
  // Devin session link (observed).
  { vendor: "other", pattern: /https:\/\/app\.devin\.ai\/sessions\/([0-9a-f]{32})/g },
  // Jules task link (observed).
  { vendor: "other", pattern: /https:\/\/jules\.google\.com\/task\/(\d+)/g },
];
