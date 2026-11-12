import { databaseOf, type Ledger } from "@selfhost/ledger";
import { ledgerEvents, newDependencies, readPullFiles } from "@selfhost/pr";
import {
  readProvenance,
  runCommits,
  settingsFromConfig,
  touchedModules,
} from "@selfhost/provenance";
import type { LedgerEvent, SecondOpinion } from "@selfhost/schema";
import { loadRisk } from "./ee.js";
import type { GitHubProviders, PullContext } from "./github-pull.js";
import type { LearnedLookup } from "./github-reverts.js";
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

/** What a background run's tests-first gate found for a pull request it opened. */
export type GateTests = (url: string) => Promise<"passed" | "failed" | undefined>;

/**
 * The tests-first gate's result for a pull request a background run opened: the newest pr.opened
 * event for it that carries data.tests. undefined for every other pull request.
 */
export function backgroundRunTests(ledger: Ledger): GateTests {
  const db = databaseOf(ledger);
  return async (url) => {
    const [row] = await db.query<{ tests: string | null }>(
      `SELECT body -> 'data' ->> 'tests' AS tests FROM events
       WHERE kind = 'pr.opened' AND body -> 'links' ->> 'pr_url' = $1
         AND body -> 'data' ->> 'tests' IS NOT NULL
       ORDER BY ts DESC LIMIT 1`,
      [url],
    );
    return row?.tests === "passed" || row?.tests === "failed" ? row.tests : undefined;
  };
}

/**
 * The risk provider backed by ee/risk: the score from the pull request's files, new
 * dependencies and agent, read from GitHub with the installation token (the same reads the
 * brief uses, made once per delivery), the revert and rework rates of the modules it touches
 * when the server has a clone of the repo, the newest verdict of each AI reviewer on it (the
 * second opinion, once [integrations.reviewer] is set or a reviewer has reviewed), and the check
 * text that lists every input. Inputs
 * the score does not read on the server (the agent run, tests, revert history) are named as
 * missing, as `selfhost review risk` does. Without ee/ in the build it scores nothing.
 */
export function eeRisk(
  load: () => Promise<RiskModule | undefined> = loadRisk,
  clones?: GitClones,
  ledger?: Pick<Ledger, "query">,
  secondOpinions?: (url: string) => Promise<SecondOpinion[]>,
  /** The tests-first gate of the background run that opened the pull request, if one did. */
  gateTests?: GateTests,
  /** Revert signals a person approved for the agent, model and touched modules. */
  learned?: LearnedLookup,
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
    const approved = learned
      ? await learned(
          `${ctx.pull.owner}/${ctx.pull.repo}`,
          ctx.agent,
          touchedModules(files, settingsFromConfig(ctx.config)),
        )
      : [];
    const opinions = await secondOpinions?.(ctx.pull.url);
    const tests = await gateTests?.(ctx.pull.url);
    const reviewer = ctx.config.integrations.reviewer;
    const inputs: RiskInputs = {
      files,
      headSha: ctx.pull.headSha,
      ...(opinions && (opinions.length > 0 || reviewer)
        ? {
            secondOpinions: opinions.map(({ tool, verdict, findings, severity, head_sha }) => ({
              tool,
              verdict,
              ...(findings !== undefined ? { findings } : {}),
              ...(severity ? { severity } : {}),
              ...(head_sha ? { head_sha } : {}),
            })),
          }
        : {}),
      ...(problem ? {} : { dependencies: newDependencies(manifests) }),
      ...(typeof modules === "string" ? {} : { modules }),
      ...(approved.length > 0 ? { learned: approved } : {}),
      agent: ctx.agent,
      ...(tests ? { tests } : {}),
      unavailable: {
        outside_effects: RUN_UNAVAILABLE,
        guardrails: RUN_UNAVAILABLE,
        ...(tests ? {} : { tests: "no sandbox run yet" }),
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
