import type { Adapter } from "../types.js";
import { workflowCheck } from "./workflow.js";

const USES = /uses:\s*["']?anthropics\/claude-code-action@/i;

/**
 * The Claude Code GitHub Action runs in CI, so the check looks for its step in the repositories'
 * workflows.
 */
export const claudeCodeAction: Adapter<"reviewer"> = {
  kind: "reviewer",
  tool: "claude-code-action",
  describe: () => ({
    kind: "reviewer",
    tool: "claude-code-action",
    name: "Claude Code GitHub Action",
    check: "A workflow in .github/workflows uses anthropics/claude-code-action.",
    docs: "https://github.com/anthropics/claude-code-action",
  }),
  check: (settings, _env, _fetch, repos) =>
    workflowCheck(
      {
        name: "the Claude Code GitHub Action",
        uses: USES,
        howTo:
          "Run selfhost review setup claude-code-action in the repository: it writes a pinned workflow that reviews agent pull requests on the repository secret ANTHROPIC_API_KEY. See https://github.com/anthropics/claude-code-action.",
        refuse: {
          test: (text) =>
            /claude_code_oauth_token\s*:/.test(text) && !/anthropic_api_key\s*:/.test(text),
          why: "the Claude Code action signs in with claude_code_oauth_token, one person's Claude subscription. A reviewer runs on every pull request the team opens, so give it the org's API key: anthropic_api_key from a repository or org secret.",
        },
        ...(settings.api_key_env ? { keyEnv: settings.api_key_env } : {}),
      },
      repos,
    ),
};
