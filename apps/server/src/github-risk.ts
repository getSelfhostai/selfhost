import { isManifest, type ManifestChange, newDependencies } from "@selfhost/pr";
import { loadRisk } from "./ee.js";
import type { GitHubProviders, PullContext } from "./github-pull.js";

type RiskModule = NonNullable<Awaited<ReturnType<typeof loadRisk>>>;
type RiskInputs = Parameters<RiskModule["scoreRisk"]>[0];

const RUN_UNAVAILABLE = "the server does not match agent runs to pull requests yet";

/** A file's text at a commit, or undefined when GitHub has none. */
async function fileAt(ctx: PullContext, path: string, ref: string): Promise<string | undefined> {
  try {
    const { data } = await ctx.octokit.rest.repos.getContent({
      owner: ctx.pull.owner,
      repo: ctx.pull.repo,
      path,
      ref,
      mediaType: { format: "raw" },
    });
    return typeof data === "string" ? data : undefined;
  } catch {
    return undefined;
  }
}

/** The changed files and the manifests before and after, read through the installation. */
async function readChange(ctx: PullContext, isManifest: (path: string) => boolean) {
  const listed = await ctx.octokit.paginate(ctx.octokit.rest.pulls.listFiles, {
    owner: ctx.pull.owner,
    repo: ctx.pull.repo,
    pull_number: ctx.pull.number,
    per_page: 100,
  });
  const files: RiskInputs["files"] = listed.map((file) => ({
    path: file.filename,
    ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
    additions: file.additions,
    deletions: file.deletions,
  }));
  const manifests: ManifestChange[] = [];
  let problem: string | undefined;
  for (const file of listed.filter((f) => isManifest(f.filename))) {
    const before =
      file.status === "added"
        ? undefined
        : await fileAt(ctx, file.previous_filename ?? file.filename, ctx.pull.baseSha);
    const after =
      file.status === "removed" ? undefined : await fileAt(ctx, file.filename, ctx.pull.headSha);
    if (
      (file.status !== "added" && before === undefined) ||
      (file.status !== "removed" && after === undefined)
    ) {
      problem = `could not read ${file.filename} from GitHub`;
    }
    manifests.push({
      path: file.filename,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    });
  }
  return { files, manifests, problem };
}

/**
 * The risk provider backed by ee/risk: the score from the pull request's files, new
 * dependencies and agent, read from GitHub with the installation token, and the check text that
 * lists every input. Inputs the server cannot read yet (the agent run, tests, revert history) are
 * named as missing, as `selfhost review risk` does. Without ee/ in the build it scores nothing.
 */
export function eeRisk(
  load: () => Promise<RiskModule | undefined> = loadRisk,
): GitHubProviders["risk"] {
  let loaded: Promise<RiskModule | undefined> | undefined;
  return async (ctx) => {
    loaded ??= load();
    const risk = await loaded;
    if (!risk) return undefined;
    const { files, manifests, problem } = await readChange(ctx, isManifest);
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
