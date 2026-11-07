import {
  botMatch,
  branchMatch,
  isBotAccount,
  type KnownSessions,
  type Match,
  resolve,
  sessionMatches,
  trailerMatches,
} from "./match.js";
import type {
  AgentVendor,
  CommitRecord,
  GitHubCommit,
  GitHubPull,
  GitHubReview,
  GitHubReviewComment,
  GitHubSource,
  PullRecord,
} from "./types.js";

/** Changed lines (additions plus deletions) above which an approval with no comments is suspect. */
export const DEFAULT_LARGE_DIFF_LINES = 300;

/** Pull requests fetched at once; each one is four API calls. */
const CONCURRENCY = 4;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * People whose latest decisive review, submitted before the merge (or at any time when not
 * merged), approves. Bot reviews and reviews dismissed or followed by changes requested do not
 * count.
 */
function countApprovals(reviews: GitHubReview[], mergedAt: string | undefined): number {
  const cutoff = mergedAt ? Date.parse(mergedAt) : Number.POSITIVE_INFINITY;
  const latest = new Map<string, GitHubReview["state"]>();
  const ordered = [...reviews]
    .filter((r) => r.submitted_at && Date.parse(r.submitted_at) <= cutoff)
    .sort((a, b) => Date.parse(a.submitted_at ?? "") - Date.parse(b.submitted_at ?? ""));
  for (const review of ordered) {
    if (!review.user || isBotAccount(review.user)) continue;
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    latest.set(review.user.login.toLowerCase(), review.state);
  }
  return [...latest.values()].filter((state) => state === "APPROVED").length;
}

function humanComments(comments: GitHubReviewComment[]): number {
  return comments.filter((c) => c.user && !isBotAccount(c.user)).length;
}

function pullMatches(
  pull: GitHubPull,
  apiCommits: GitHubCommit[],
  local: Map<string, CommitRecord>,
  known: KnownSessions,
): Match[] {
  const body = pull.body ?? "";
  const matches: Match[] = [...trailerMatches(body), ...sessionMatches(body, known)];
  for (const commit of apiCommits) {
    const record = local.get(commit.sha);
    if (record?.agent && record.signal) {
      // The local read already weighed this commit's signals, including file and time.
      matches.push({
        signal: record.signal,
        vendor: record.agent.vendor,
        ...(record.agent.model ? { model: record.agent.model } : {}),
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      });
      continue;
    }
    const message = commit.commit.message ?? "";
    matches.push(...trailerMatches(message), ...sessionMatches(message, known));
    const bot =
      (commit.author && botMatch(commit.author)) ||
      botMatch({ email: commit.commit.author?.email });
    if (bot) matches.push(bot);
  }
  const author = pull.user && botMatch(pull.user);
  if (author) matches.push(author);
  const branch = branchMatch(pull.head.ref);
  if (branch) matches.push(branch);
  return matches;
}

/**
 * Pull requests opened, merged or closed since `since`, each linked to the agent and model that
 * produced it. Evidence comes from the body, the author, the branch, the commits' messages and
 * authors on GitHub, and the attribution `readCommits` gave the same commits locally. Session ids
 * count when they appear in a vendor's session link or belong to a session one of `commits`
 * was matched to.
 */
export async function readPulls(
  repo: string,
  opts: {
    since: Date;
    commits: CommitRecord[];
    source: GitHubSource;
    largeDiffLines?: number;
  },
): Promise<PullRecord[]> {
  const since = opts.since.getTime();
  const largeDiff = opts.largeDiffLines ?? DEFAULT_LARGE_DIFF_LINES;
  const local = new Map(opts.commits.map((c) => [c.sha, c] as const));
  const known = new Map<string, { vendor: AgentVendor; model?: string }>();
  for (const c of opts.commits) {
    if (c.sessionId && c.agent && !known.has(c.sessionId)) {
      known.set(c.sessionId, { vendor: c.agent.vendor, model: c.agent.model });
    }
  }

  const listed = (await opts.source.pulls(repo, opts.since)).filter((p) =>
    [p.created_at, p.merged_at, p.closed_at].some((ts) => ts && Date.parse(ts) >= since),
  );

  return mapLimit(listed, CONCURRENCY, async (summary) => {
    const ref = { number: summary.number, updatedAt: summary.updated_at };
    const [pull, reviews, comments, commits] = await Promise.all([
      opts.source.pull(repo, ref),
      opts.source.reviews(repo, ref),
      opts.source.reviewComments(repo, ref),
      opts.source.commits(repo, ref),
    ]);
    const mergedAt = pull.merged_at ?? undefined;
    const closedAt = pull.closed_at ?? undefined;
    const state: PullRecord["state"] = mergedAt ? "merged" : pull.state;
    const additions = pull.additions ?? 0;
    const deletions = pull.deletions ?? 0;
    const approvals = countApprovals(reviews, mergedAt);
    const reviewComments = humanComments(comments);
    const unreviewedMerge =
      state === "merged" &&
      (approvals === 0 || (reviewComments === 0 && additions + deletions > largeDiff));
    const found = resolve(pullMatches(pull, commits, local, known));
    return {
      number: pull.number,
      url: pull.html_url,
      state,
      createdAt: new Date(pull.created_at).toISOString(),
      ...(mergedAt ? { mergedAt: new Date(mergedAt).toISOString() } : {}),
      ...(closedAt ? { closedAt: new Date(closedAt).toISOString() } : {}),
      author: pull.user?.login ?? "ghost",
      headRef: pull.head.ref,
      additions,
      deletions,
      commits: commits.map((c) => c.sha),
      approvals,
      reviewComments,
      issueComments: pull.comments ?? 0,
      ...(found ? { agent: found.agent, signal: found.signal } : {}),
      unreviewedMerge,
    };
  });
}
