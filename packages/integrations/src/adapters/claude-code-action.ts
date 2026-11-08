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
          "Run /install-github-app in Claude Code, or add .github/workflows/claude.yml with a step `uses: anthropics/claude-code-action@v1` and anthropic_api_key set from the repository secret ANTHROPIC_API_KEY. See https://github.com/anthropics/claude-code-action.",
        ...(settings.api_key_env ? { keyEnv: settings.api_key_env } : {}),
      },
      repos,
    ),
};
