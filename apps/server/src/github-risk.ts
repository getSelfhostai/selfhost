import type { Ledger } from "@selfhost/ledger";
import { ledgerEvents, newDependencies, readPullFiles } from "@selfhost/pr";
import {
  readProvenance,
  runCommits,
  settingsFromConfig,
  touchedModules,
} from "@selfhost/provenance";
import type { LedgerEvent } from "@selfhost/schema";
import { loadRisk } from "./ee.js";
import type { GitHubProviders, PullContext } from "./github-pull.js";
import type { GitClones } from "./provenance.js";

type RiskModule = NonNullable<Awaited<ReturnType<typeof loadRisk>>>;
type RiskInputs = Parameters<RiskModule["scoreRisk"]>[0];
type ModuleReverts = NonNullable<RiskInputs["modules"]>;

const RUN_UNAVAILABLE = "the server's risk score does not read agent runs yet";

const DAY_MS = 86_400_000;

/**
 * Revert and rework rates of the modules a pull request touches, from the server's clone of
 * its repository over the last `days` of merges, with commits joined to the runs the ledger
 * recorded; a reason instead when there is no clone.
 */
export async function cloneModuleReverts(
  clones: GitClones | undefined,
  ctx: Pick<PullContext, "pull" | "config">,
  files: { path: string; previousPath?: string }[],
  days: number,
  opts: { ledger?: Pick<Ledger, "query">; now?: Date } = {},
): Promise<ModuleReverts | string> {
  const repo = `${ctx.pull.owner}/${ctx.pull.repo}`.toLowerCase();
  const dir = clones?.dir(repo);
  if (!dir) return `the server has no clone of ${repo} (SELFHOST_GIT_CLONES)`;
  const settings = settingsFromConfig(ctx.config);
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * DAY_MS);
  try {
    const events: LedgerEvent[] = [];
    if (opts.ledger) {
      for await (const event of ledgerEvents(opts.ledger, {
        kind: "commit.created",
        from: since.toISOString(),
      })) {
        events.push(event);
      }
    }
    const report = await readProvenance(dir, {
      since,
      until: now,
      settings,
      repo,
      runs: runCommits(events),
    });
    const rows = new Map(report.modules.map((row) => [row.module, row] as const));
    return {
      days,
      modules: touchedModules(files, settings).map((module) => ({
        module,
        agentLines: rows.get(module)?.agent_lines ?? 0,
        rate: rows.get(module)?.agent_revert_rework_rate ?? null,
      })),
    };
  } catch (error) {
    return `could not read the clone of ${repo}: ${(error as Error).message.split("\n")[0]}`;
  }
}

/**
 * The risk provider backed by ee/risk: the score from the pull request's files, new
 * dependencies and agent, read from GitHub with the installation token (the same reads the
 * brief uses, made once per delivery), the revert and rework rates of the modules it touches
 * when the server has a clone of the repo, and the check text that lists every input. Inputs
 * the score does not read on the server (the agent run, tests, revert history) are named as
 * missing, as `selfhost review risk` does. Without ee/ in the build it scores nothing.
 */
export function eeRisk(
  load: () => Promise<RiskModule | undefined> = loadRisk,
  clones?: GitClones,
  ledger?: Pick<Ledger, "query">,
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
    const modules = await cloneModuleReverts(clones, ctx, files, risk.REVERT_WINDOW_DAYS, {
      ...(ledger ? { ledger } : {}),
    });
    const inputs: RiskInputs = {
      files,
      ...(problem ? {} : { dependencies: newDependencies(manifests) }),
      ...(typeof modules === "string" ? {} : { modules }),
      agent: ctx.agent,
      unavailable: {
        outside_effects: RUN_UNAVAILABLE,
        guardrails: RUN_UNAVAILABLE,
        tests: "no sandbox run yet",
        reverts: "the server has no git history to count reverts in",
        ...(problem ? { dependencies: problem } : {}),
        ...(typeof modules === "string" ? { module_reverts: modules } : {}),
      },
    };
    const result = risk.scoreRisk(inputs, ctx.config);
    const check = risk.riskCheck(result, ctx.config);
    return {
      level: result.level,
      score: result.score,
      title: check.title,
      summary: check.summary,
      text: check.text,
    };
  };
}
