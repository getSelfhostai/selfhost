import {
  BRIEF_MARKER,
  briefInputs,
  buildBrief,
  GITHUB_COMMENT_LIMIT,
  renderBrief,
  summarizeBrief,
} from "@selfhost/brief";
import type { GitHubApp } from "@selfhost/github";
import type { Ledger } from "@selfhost/ledger";
import {
  CODEOWNERS_PATHS,
  type CodeOwners,
  openReviewList,
  parseCodeOwners,
  type RefreshOptions,
  type Routing,
  routeItem,
} from "@selfhost/review";
import { CODEOWNERS_TARGET } from "@selfhost/schema";
import { loadReceipt } from "./ee.js";
import type { GitHubProviders, PullContext, RiskAssessment } from "./github-pull.js";

/**
 * CODEOWNERS of a repository (owner/name) read through the GitHub App's installation on it, at
 * its default branch, where pull requests usually merge: the `codeowners` target of
 * [[review.routes]] on the items the review list builds, for a server with no clones
 * (SELFHOST_GIT_CLONES), as the GitHub sync reads it. undefined when the App is not installed
 * there or the repository has none.
 */
export function appCodeowners(
  github: Pick<GitHubApp, "repoInstallation" | "installation">,
): NonNullable<RefreshOptions["codeowners"]> {
  return async (repo) => {
    const [owner, name, ...rest] = repo.split("/");
    if (!owner || !name || rest.length > 0) return undefined;
    const installation = await github.repoInstallation(owner, name);
    if (installation === undefined) return undefined;
    const octokit = github.installation(installation);
    for (const path of CODEOWNERS_PATHS) {
      try {
        const { data } = await octokit.rest.repos.getContent({
          owner,
          repo: name,
          path,
          mediaType: { format: "raw" },
        });
        if (typeof data === "string") return data;
      } catch {
        // GitHub reads the first of these that exists.
      }
    }
    return undefined;
  };
}

/** The CODEOWNERS of the pull request's repository at its base commit, read through the App. */
async function codeownersAt(ctx: PullContext): Promise<CodeOwners | undefined> {
  for (const path of CODEOWNERS_PATHS) {
    const text = await ctx.reads.contents(path, ctx.pull.baseSha);
    if (text !== undefined) return parseCodeOwners(text);
  }
  return undefined;
}

const usesCodeowners = (ctx: PullContext) =>
  ctx.config.review.routes.some((route) => route.to.includes(CODEOWNERS_TARGET));

/**
 * How the review list routes an agent pull request, read once per delivery. Its `pr` review
 * item (by PR URL, in the team's items when `team` is set) decides when there is one. Before
 * the review list has one, `routeItem` routes the pull request the way the item will be:
 * `[[review.routes]]` (with CODEOWNERS read through the App when a route names it), else
 * `[review.owners]` globs on its changed files (old paths of renames too), else the person
 * whose session made its commits, else the team's members, else `[review] fallback`.
 */
export function reviewRouting(
  ledger: Ledger,
  team: string | undefined,
): (ctx: PullContext & { risk?: RiskAssessment }) => Promise<Routing> {
  const list = openReviewList(ledger, team === undefined ? {} : { team });
  const seen = new WeakMap<object, Promise<Routing>>();
  const route = async (ctx: PullContext & { risk?: RiskAssessment }): Promise<Routing> => {
    const item = await list.pullRequest(ctx.pull.url);
    if (item?.route && (item.owners.length > 0 || item.route.github)) {
      return { owners: item.owners, route: item.route };
    }
    const change = await ctx.reads.change();
    const person = change.run?.events.find((event) => event.actor.kind === "person")?.actor.id;
    const codeowners = usesCodeowners(ctx) ? await codeownersAt(ctx) : undefined;
    return routeItem(
      ctx.config,
      {
        kind: "pr",
        repo: `${ctx.pull.owner}/${ctx.pull.repo}`,
        paths: change.files.flatMap((file) =>
          file.previousPath ? [file.path, file.previousPath] : [file.path],
        ),
        ...(ctx.risk?.score !== undefined ? { risk: ctx.risk.score } : {}),
        ...(person ? { person } : {}),
        ...(team ? { team } : {}),
      },
      codeowners ? { codeowners } : {},
    );
  };
  return (ctx) => {
    let found = seen.get(ctx.reads);
    if (!found) {
      found = route(ctx);
      seen.set(ctx.reads, found);
    }
    return found;
  };
}

/** The owner the review list routes an agent pull request to: the first owner of its routing. */
export function reviewOwner(
  ledger: Ledger,
  team: string | undefined,
  routing = reviewRouting(ledger, team),
): GitHubProviders["owner"] {
  return async (ctx) => (await routing(ctx)).owners[0];
}

/**
 * The GitHub accounts the pull request's route names (`@` targets and CODEOWNERS), asked to
 * review it besides the owner. Without `[[review.routes]]` nothing is read and there are none.
 */
export function reviewRoute(
  ledger: Ledger,
  team: string | undefined,
  routing = reviewRouting(ledger, team),
): GitHubProviders["route"] {
  return async (ctx) => {
    if (ctx.config.review.routes.length === 0) return undefined;
    return (await routing(ctx)).route;
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
        ...(ctx.config.integrations.tracer ? { tracer: ctx.config.integrations.tracer } : {}),
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
