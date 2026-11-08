import type { Adapter } from "../types.js";
import { workflowCheck } from "./workflow.js";

/** The action under its current and earlier names, and its Docker image. */
const USES =
  /uses:\s*["']?(?:(?:the-pr-agent|qodo-ai|codium-ai)\/pr-agent@|docker:\/\/(?:pragent|codiumai)\/pr-agent)/i;

/** PR-Agent runs as a GitHub Action, so the check looks for its step in the repositories' workflows. */
export const prAgent: Adapter<"reviewer"> = {
  kind: "reviewer",
  tool: "pr-agent",
  describe: () => ({
    kind: "reviewer",
    tool: "pr-agent",
    name: "PR-Agent",
    check: "A workflow in .github/workflows uses the PR-Agent action.",
    docs: "https://github.com/the-pr-agent/pr-agent",
  }),
  check: (settings, _env, _fetch, repos) =>
    workflowCheck(
      {
        name: "PR-Agent",
        uses: USES,
        howTo:
          "Add .github/workflows/pr-agent.yml that runs on pull_request with a step `uses: the-pr-agent/pr-agent@main` and OPENAI_KEY and GITHUB_TOKEN in its env, from the repository secrets. See https://github.com/the-pr-agent/pr-agent.",
        ...(settings.api_key_env ? { keyEnv: settings.api_key_env } : {}),
      },
      repos,
    ),
};
