import {
  BRIEF_MARKER,
  briefInputs,
  buildBrief,
  renderBrief,
  summarizeBrief,
} from "@selfhost/brief";
import type { Ledger } from "@selfhost/ledger";
import { openReviewList, routeItem } from "@selfhost/review";
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

/**
 * The review brief, built on the server: the change read from GitHub through the App (no clone,
 * no gh), its run joined from the ledger, `[review] high_risk_paths` from the delivery's
 * selfhost.toml, and trace links to this server's events API. Its summary leads the check run.
 */
export function reviewBrief(): GitHubProviders["brief"] {
  return async (ctx) => {
    const change = await ctx.reads.change();
    const brief = buildBrief(
      briefInputs(change, {
        highRiskPaths: ctx.config.review.high_risk_paths,
        server: ctx.server,
      }),
    );
    return { body: renderBrief(brief), marker: BRIEF_MARKER, summary: summarizeBrief(brief) };
  };
}
