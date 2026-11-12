import { readHeadChecks } from "@selfhost/github";
import { databaseOf, type Ledger, recordDecision, stableEventId } from "@selfhost/ledger";
import { openReviewList } from "@selfhost/review";
import { EVENT_SCHEMA, type LedgerEvent, type ReviewItem } from "@selfhost/schema";
import { loadRisk } from "./ee.js";
import type { AutoApproval, GitHubProviders, PullContext } from "./github-pull.js";

type RiskModule = NonNullable<Awaited<ReturnType<typeof loadRisk>>>;
type SecondOpinion = NonNullable<Parameters<RiskModule["autoApproveVerdict"]>[0]["secondOpinion"]>;

/** data.alert of the ledger event a dry run writes for each head commit it would approve. */
export const AUTO_APPROVE_DRY_RUN_ALERT = "auto_approve_dry_run";

/** Who auto-approve's records name, matching ee/risk's AUTO_APPROVE_DECIDER. */
const DECIDER = "selfhost auto-approve";

const PASSING_OPINIONS = new Set(["pass", "passed", "clean", "approve", "approved", "lgtm"]);

/**
 * The second opinion on a review item, from the reviewer integration's ingest, which writes it
 * as `second_opinion` on the pull request's item. Read through this narrow shape only:
 * `{ verdict, tool?, summary? }`, where pass, clean or approve passes and anything else fails.
 */
export function secondOpinionOf(item: ReviewItem | undefined): SecondOpinion | undefined {
  const raw = (item as Record<string, unknown> | undefined)?.second_opinion;
  if (raw === null || typeof raw !== "object") return undefined;
  const { verdict, tool, by, summary } = raw as Record<string, unknown>;
  if (typeof verdict !== "string") return undefined;
  const who = typeof tool === "string" ? tool : typeof by === "string" ? by : undefined;
  return {
    verdict: PASSING_OPINIONS.has(verdict.toLowerCase()) ? "pass" : "fail",
    ...(who ? { by: who } : {}),
    ...(typeof summary === "string" && summary.trim() ? { summary: summary.trim() } : {}),
  };
}

export interface AutoApproverOptions {
  load?: () => Promise<RiskModule | undefined>;
  /** Default: the `second_opinion` the reviewer integration put on the pull request's item. */
  secondOpinion?: (
    ctx: PullContext,
    item: ReviewItem | undefined,
  ) => Promise<SecondOpinion | undefined>;
}

/**
 * The auto-approve provider: with `[review.auto_approve] enabled`, it reads the head commit's
 * checks through the App, the agent's run and guardrail hits from the ledger, the open review
 * items of the pull request and its run, and the second opinion, and asks ee/risk whether the
 * pull request may be approved. It reads nothing while auto-approve is off.
 */
export function autoApprover(
  ledger: Ledger,
  team: string | undefined,
  options: AutoApproverOptions = {},
): GitHubProviders["autoApprove"] {
  const list = openReviewList(ledger, team === undefined ? {} : { team });
  const load = options.load ?? loadRisk;
  let loaded: Promise<RiskModule | undefined> | undefined;
  return async (ctx): Promise<AutoApproval | undefined> => {
    const auto = ctx.config.review.auto_approve;
    if (!auto.enabled) return undefined;
    loaded ??= load();
    const risk = await loaded;
    if (!risk) {
      return {
        eligible: false,
        dryRun: auto.dry_run,
        reasons: [],
        files: [],
        summary:
          "Auto-approve is on in selfhost.toml, but this server was built without ee/, so a person reviews this.",
      };
    }
    const listed = await ctx.reads.files();
    const files = listed.flatMap((file) =>
      file.previous_filename ? [file.filename, file.previous_filename] : [file.filename],
    );
    let checks: Awaited<ReturnType<typeof readHeadChecks>> | undefined;
    try {
      checks = await readHeadChecks(ctx.octokit, ctx.pull);
    } catch {
      checks = undefined;
    }
    const change = await ctx.reads.change();
    const item = await list.pullRequest(ctx.pull.url);
    const open = item?.state === "open" ? item : undefined;
    const waits = new Map<string, ReviewItem>();
    if (open?.blocking) waits.set(open.id, open);
    for (const wait of await list.waits({
      sessions: change.run?.sessions ?? [],
      runIds: open?.run_id ? [open.run_id] : [],
    })) {
      waits.set(wait.id, wait);
    }
    const opinion = await (options.secondOpinion?.(ctx, item) ?? secondOpinionOf(item));
    const verdict = risk.autoApproveVerdict(
      {
        draft: ctx.pull.draft,
        ...(ctx.risk?.score !== undefined
          ? { risk: { level: ctx.risk.level, score: ctx.risk.score } }
          : {}),
        files,
        ...(checks ? { checks: checks.checks } : {}),
        ...(checks?.note ? { checksNote: checks.note } : {}),
        ...(change.run
          ? { guardrails: change.run.guardrails.map(({ event: _event, ...hit }) => hit) }
          : {}),
        ...(opinion ? { secondOpinion: opinion } : {}),
        waits: [...waits.values()],
      },
      ctx.config,
    );
    return {
      eligible: verdict.eligible,
      dryRun: verdict.dryRun,
      reasons: verdict.reasons,
      files,
      summary: risk.autoApproveSummary(verdict),
      text: risk.autoApproveText(verdict),
      ...(verdict.eligible && !verdict.dryRun
        ? {
            approve: {
              body: risk.autoApproveReviewBody(verdict),
              marker: risk.AUTO_APPROVE_MARKER,
            },
          }
        : {}),
      ...(open ? { itemId: open.id } : {}),
    };
  };
}

/** true when the ledger already has a record of this kind for the pull request at this commit. */
async function recorded(
  ledger: Ledger,
  kind: "decision" | "dry_run",
  url: string,
  sha: string,
): Promise<boolean> {
  const rows = await databaseOf(ledger).query(
    kind === "decision"
      ? `SELECT 1 FROM events WHERE kind = 'decision.recorded'
         AND body#>>'{links,pr_url}' = $1 AND lower(body#>>'{links,commit_sha}') = $2
         AND body#>>'{data,surface}' = 'auto_approve' LIMIT 1`
      : `SELECT 1 FROM events WHERE kind = 'alert.raised'
         AND body#>>'{links,pr_url}' = $1 AND lower(body#>>'{links,commit_sha}') = $2
         AND body#>>'{data,alert}' = '${AUTO_APPROVE_DRY_RUN_ALERT}' LIMIT 1`,
    [url, sha.toLowerCase()],
  );
  return rows.length > 0;
}

export type AutoApprovalRecord = "approved" | "dry_run" | "already_recorded" | "none";

/**
 * Writes what auto-approve did for the head commit, once per commit. Live: a decision.recorded
 * event, verdict approve by "selfhost auto-approve" (a system actor, surface auto_approve) with
 * the reasons, the pull request, the commit and the files, and the pull request's open review
 * item answered by it. Dry run: an alert.raised event (data.alert auto_approve_dry_run) with the
 * same reasons, which opens no review item and approves nothing.
 */
export async function recordAutoApproval(
  ledger: Ledger,
  team: string | undefined,
  ctx: Pick<PullContext, "pull">,
  approval: AutoApproval,
  now: () => Date = () => new Date(),
): Promise<AutoApprovalRecord> {
  if (!approval.eligible) return "none";
  const { pull } = ctx;
  const repo = `${pull.owner}/${pull.repo}`;
  const what = `${repo}#${pull.number} at ${pull.headSha.slice(0, 12)}`;
  const append = (events: LedgerEvent[]) =>
    ledger.append(events, team === undefined ? undefined : { team });
  if (approval.dryRun) {
    if (await recorded(ledger, "dry_run", pull.url, pull.headSha)) return "already_recorded";
    const ts = now().toISOString();
    await append([
      {
        id: stableEventId(ts, `${AUTO_APPROVE_DRY_RUN_ALERT}\n${pull.url}\n${pull.headSha}`),
        schema: EVENT_SCHEMA,
        ts,
        source: "server",
        kind: "alert.raised",
        actor: { kind: "system", id: DECIDER },
        repo,
        target: { type: "pr", value: pull.url },
        links: { pr_url: pull.url, commit_sha: pull.headSha },
        data: {
          alert: AUTO_APPROVE_DRY_RUN_ALERT,
          message: `Auto-approve would have approved ${what} (dry run).`,
          reasons: approval.reasons,
          paths: approval.files,
        },
      },
    ]);
    return "dry_run";
  }
  if (await recorded(ledger, "decision", pull.url, pull.headSha)) return "already_recorded";
  const { event } = await recordDecision(
    { append, decisions: ledger.decisions },
    {
      verdict: "approve",
      by: DECIDER,
      reason: approval.reasons.join("; "),
      question: `Auto-approve ${what}`,
      ...(approval.itemId ? { item_id: approval.itemId } : {}),
      repo,
      pr_url: pull.url,
      commit_sha: pull.headSha,
      ...(approval.files.length > 0 ? { paths: approval.files.slice(0, 1000) } : {}),
      surface: "auto_approve",
    },
    { system: true, source: "server", now: now() },
  );
  if (approval.itemId) {
    const list = openReviewList(ledger, team === undefined ? {} : { team });
    await list.closeApproved(approval.itemId, {
      by: DECIDER,
      verdict: "approve",
      ...(event.decision?.reason !== undefined ? { reason: event.decision.reason } : {}),
      at: event.ts,
      decision_event_id: event.id,
    });
  }
  return "approved";
}
