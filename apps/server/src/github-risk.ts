import { newDependencies, readPullFiles } from "@selfhost/pr";
import { loadRisk } from "./ee.js";
import type { GitHubProviders } from "./github-pull.js";

type RiskModule = NonNullable<Awaited<ReturnType<typeof loadRisk>>>;
type RiskInputs = Parameters<RiskModule["scoreRisk"]>[0];

const RUN_UNAVAILABLE = "the server's risk score does not read agent runs yet";

/**
 * The risk provider backed by ee/risk: the score from the pull request's files, new
 * dependencies and agent, read from GitHub with the installation token (the same reads the
 * brief uses, made once per delivery), and the check text that lists every input. Inputs the
 * score does not read on the server (the agent run, tests, revert history) are named as
 * missing, as `selfhost review risk` does. Without ee/ in the build it scores nothing.
 */
export function eeRisk(
  load: () => Promise<RiskModule | undefined> = loadRisk,
): GitHubProviders["risk"] {
  let loaded: Promise<RiskModule | undefined> | undefined;
  return async (ctx) => {
    loaded ??= load();
    const risk = await loaded;
    if (!risk) return undefined;
    const {
      files,
      manifests,
      manifestProblem: problem,
    } = await readPullFiles(ctx.reads, ctx.pull.baseSha, ctx.pull.headSha);
    const inputs: RiskInputs = {
      files,
      ...(problem ? {} : { dependencies: newDependencies(manifests) }),
      agent: ctx.agent,
      unavailable: {
        outside_effects: RUN_UNAVAILABLE,
        guardrails: RUN_UNAVAILABLE,
        tests: "no sandbox run yet",
        reverts: "the server has no git history to count reverts in",
        ...(problem ? { dependencies: problem } : {}),
      },
    };
    const result = risk.scoreRisk(inputs, ctx.config);
    const check = risk.riskCheck(result, ctx.config);
    return { level: result.level, title: check.title, summary: check.summary, text: check.text };
  };
}
