import { connected, failed } from "../http.js";
import type { Adapter } from "../types.js";

export const CODERABBIT_APP = "coderabbitai";
export const CODERABBIT_BOT = "coderabbitai[bot]";
const INSTALL = `https://github.com/apps/${CODERABBIT_APP}`;

/**
 * CodeRabbit is a GitHub App. The check asks GitHub whether it is installed on each repository's
 * owner (that needs the selfhost App to have Administration read on the org), else looks for its
 * bot's comments on recent pull requests.
 */
export const coderabbit: Adapter<"reviewer"> = {
  kind: "reviewer",
  tool: "coderabbit",
  describe: () => ({
    kind: "reviewer",
    tool: "coderabbit",
    name: "CodeRabbit",
    check: `The ${CODERABBIT_APP} GitHub App is installed, or ${CODERABBIT_BOT} commented on recent pull requests.`,
    docs: "https://docs.coderabbit.ai/platforms/github-com",
  }),
  async check(_settings, _env, _fetch, repos) {
    if (!repos || repos.repos.length === 0 || (!repos.appInstalled && !repos.recentBots)) {
      return failed(
        `selfhost cannot see GitHub App installations from here. Check CodeRabbit is installed on your repositories at ${INSTALL}; on a team server with the selfhost GitHub App this check looks for itself.`,
      );
    }
    const notInstalled: string[] = [];
    for (const repo of repos.repos) {
      const installed = await repos.appInstalled?.(repo, CODERABBIT_APP);
      if (installed) {
        return connected(`CodeRabbit is installed on ${repo.split("/")[0]}.`);
      }
      if (installed === false) notInstalled.push(repo);
      const bots = await repos.recentBots?.(repo);
      if (bots?.includes(CODERABBIT_BOT)) {
        return connected(`CodeRabbit commented on recent pull requests in ${repo}.`);
      }
    }
    if (notInstalled.length > 0) {
      return failed(
        `CodeRabbit is not installed on ${notInstalled.join(", ")}. Install it at ${INSTALL}.`,
      );
    }
    return failed(
      `No sign of CodeRabbit in ${repos.repos.join(", ")}: no comments from it on recent pull requests, and ${repos.via} cannot list the org's GitHub Apps (that needs Administration read). Install it at ${INSTALL}; this turns connected after its first review.`,
    );
  },
};
