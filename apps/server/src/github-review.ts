import {
  BRIEF_MARKER,
  briefInputs,
  buildBrief,
  GITHUB_COMMENT_LIMIT,
  renderBrief,
  summarizeBrief,
} from "@selfhost/brief";
import type { Ledger } from "@selfhost/ledger";
import { openReviewList, routeItem } from "@selfhost/review";
import { loadReceipt } from "./ee.js";
import type { GitHubProviders } from "./github-pull.js";

/**
 * The owner the review list routes an agent pull request to. Its `pr` review item (by PR URL,
 * in the team's items when `team` is set) decides when there is one: the first of its owners.
 * Before the review list has one, `routeItem` routes the pull request the way the item will be:
 * `[review.owners]` globs on its changed files (old paths of renames too), else the person
 * whose session made its commits, else the team's members, else `[review] fallback`.
 */
export function reviewOwner(ledger: Ledger, team: string | undefined): GitHubProviders["owner"] {
  const list = openReviewList(ledger, team === undefined ? {} : { team });
  return async (ctx) => {
    const item = await list.pullRequest(ctx.pull.url);
    if (item?.owners[0]) return item.owners[0];
    const change = await ctx.reads.change();
    const person = change.run?.events.find((event) => event.actor.kind === "person")?.actor.id;
    const { owners } = routeItem(ctx.config, {
      paths: change.files.flatMap((file) =>
        file.previousPath ? [file.path, file.previousPath] : [file.path],
      ),
      ...(person ? { person } : {}),
      ...(team ? { team } : {}),
    });
    return owners[0];
  };
}

/** The ee/receipt functions the brief and the receipts route use. */
export type ReceiptModule = NonNullable<Awaited<ReturnType<typeof loadReceipt>>>;

/** The stored receipt's own URL on this server. */
export const receiptUrl = (server: string, id: string) =>
  `${server.replace(/\/+$/, "")}/v1/receipts/${id}`;

/**
 * The review brief, built on the server: the change read from GitHub through the App (no clone,
 * no gh), its run joined from the ledger, `[review] high_risk_paths` from the delivery's
 * selfhost.toml, and trace links to this server's events API. Its summary leads the check run.
 * When the receipt step in CI has posted a proof receipt for the pull request, the brief ends
 * with its headline and links to the receipt comment, the preview and the screenshots.
 */
export function reviewBrief(
  ledger: Pick<Ledger, "receipts">,
  load: () => Promise<ReceiptModule | undefined> = loadReceipt,
): GitHubProviders["brief"] {
  let loaded: Promise<ReceiptModule | undefined> | undefined;
  return async (ctx) => {
    const change = await ctx.reads.change();
    const brief = buildBrief(
      briefInputs(change, {
        highRiskPaths: ctx.config.review.high_risk_paths,
        server: ctx.server,
      }),
    );
    const stored = await ledger.receipts.latest(
      `${ctx.pull.owner}/${ctx.pull.repo}`,
      ctx.pull.number,
    );
    loaded ??= stored ? load() : undefined;
    const receipts = stored ? await loaded : undefined;
    const section =
      stored && receipts
        ? receipts.receiptBriefSection(stored.receipt, {
            headSha: ctx.pull.headSha,
            ...(stored.comment_url ? { commentUrl: stored.comment_url } : {}),
            receiptUrl: receiptUrl(ctx.server, stored.id),
          })
        : undefined;
    const summary = summarizeBrief(brief);
    if (!section || !stored || !receipts) {
      return { body: renderBrief(brief), marker: BRIEF_MARKER, summary };
    }
    const body = renderBrief(brief, { maxChars: GITHUB_COMMENT_LIMIT - section.length - 2 });
    const current = stored.head_sha === ctx.pull.headSha.toLowerCase();
    return {
      body: `${body}\n${section}\n`,
      marker: BRIEF_MARKER,
      summary: current
        ? `${summary} Proof receipt: ${receipts.receiptHeadline(stored.receipt)}`
        : summary,
    };
  };
}
