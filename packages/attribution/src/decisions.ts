import type { CreateDecisionRequest, PersonVerdict } from "@selfhost/schema";
import {
  type Attribution,
  botMatch,
  branchMatch,
  isBotAccount,
  type Match,
  resolve,
  sessionMatches,
  trailerMatches,
} from "./match.js";
import type { GitHubUser } from "./types.js";

/** The parts of a `pull_request_review` webhook payload the mapper reads. */
export interface PullRequestReviewWebhook {
  action: string;
  review: {
    id: number;
    user: GitHubUser | null;
    body: string | null;
    /** Lower case in webhooks: approved, changes_requested, commented, dismissed. */
    state: string;
    submitted_at: string | null;
    commit_id?: string | null;
  };
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    user: GitHubUser | null;
    body: string | null;
    head: { ref: string };
  };
  repository: { full_name: string };
}

/** The parts of an `issue_comment` webhook payload the mapper reads. */
export interface IssueCommentWebhook {
  action: string;
  comment: { id: number; user: GitHubUser | null; body: string | null; created_at: string };
  issue: {
    number: number;
    title: string;
    user: GitHubUser | null;
    body: string | null;
    /** Present only when the issue is a pull request. */
    pull_request?: { html_url: string } | null;
  };
  repository: { full_name: string };
}

export interface GitHubDecisionOptions {
  /** The selfhost person id for a GitHub login, such as their git email. Default: the login. */
  person?: (login: string) => string | undefined;
}

const REVIEW_VERDICTS: Record<string, PersonVerdict> = {
  approved: "approve",
  changes_requested: "deny",
  commented: "answer",
};

/**
 * The agent that opened a pull request, from what a webhook carries: attribution lines and
 * session links in the body, an agent account as author, and an agent branch prefix.
 */
export function webhookPullAgent(pull: {
  user: GitHubUser | null;
  body: string | null;
  head?: { ref: string };
}): Attribution | undefined {
  const body = pull.body ?? "";
  const matches: Match[] = [...trailerMatches(body), ...sessionMatches(body, new Map())];
  const author = pull.user && botMatch(pull.user);
  if (author) matches.push(author);
  const branch = pull.head && branchMatch(pull.head.ref);
  if (branch) matches.push(branch);
  return resolve(matches);
}

const iso = (ts: string) => new Date(ts).toISOString();

const person = (login: string, options: GitHubDecisionOptions) => options.person?.(login) ?? login;

function reviewDecision(
  payload: PullRequestReviewWebhook,
  options: GitHubDecisionOptions,
): CreateDecisionRequest | undefined {
  const { review, pull_request: pull } = payload;
  if (payload.action !== "submitted" || !review.user || isBotAccount(review.user)) return undefined;
  const verdict = REVIEW_VERDICTS[review.state.toLowerCase()];
  const reason = review.body?.trim();
  // A comment-only review with no text is the wrapper around inline comments, not an answer.
  if (!verdict || !review.submitted_at || (verdict === "answer" && !reason)) return undefined;
  if (!webhookPullAgent(pull)) return undefined;
  return {
    verdict,
    by: person(review.user.login, options),
    ...(reason ? { reason } : {}),
    question: `#${pull.number} ${pull.title}`,
    repo: payload.repository.full_name,
    pr_url: pull.html_url,
    ...(review.commit_id ? { commit_sha: review.commit_id } : {}),
    surface: "github_review",
    key: `pull_request_review:${review.id}`,
    ts: iso(review.submitted_at),
  };
}

function commentDecision(
  payload: IssueCommentWebhook,
  options: GitHubDecisionOptions,
): CreateDecisionRequest | undefined {
  const { comment, issue } = payload;
  if (payload.action !== "created" || !issue.pull_request) return undefined;
  if (!comment.user || isBotAccount(comment.user)) return undefined;
  const reason = comment.body?.trim();
  if (!reason || !webhookPullAgent(issue)) return undefined;
  return {
    verdict: "answer",
    by: person(comment.user.login, options),
    reason,
    question: `#${issue.number} ${issue.title}`,
    repo: payload.repository.full_name,
    pr_url: issue.pull_request.html_url,
    surface: "github_comment",
    key: `issue_comment:${comment.id}`,
    ts: iso(comment.created_at),
  };
}

/**
 * The decision a GitHub webhook delivery records, or undefined when it is not a person's
 * answer on an agent's pull request. `event` is the X-GitHub-Event header.
 *
 * - `pull_request_review`, action submitted: approved is approve, changes_requested is deny,
 *   commented with text is answer. The review text is the reason.
 * - `issue_comment`, action created, on a pull request: answer, with the comment as the reason.
 *
 * Reviews and comments by bots, on pull requests no agent opened, and edits, dismissals and
 * deletions give nothing. The key is GitHub's review or comment id, so a redelivered webhook
 * records nothing new. Pass the result to recordDecision or POST /v1/decisions.
 */
export function githubDecision(
  event: string,
  payload: unknown,
  options: GitHubDecisionOptions = {},
): CreateDecisionRequest | undefined {
  if (event === "pull_request_review") {
    const review = shaped<PullRequestReviewWebhook>(event, payload, ["review", "pull_request"]);
    return reviewDecision(review, options);
  }
  if (event === "issue_comment") {
    return commentDecision(
      shaped<IssueCommentWebhook>(event, payload, ["comment", "issue"]),
      options,
    );
  }
  return undefined;
}

/** The payload as T when it has the objects T is read from; GitHub always sends them. */
function shaped<T>(event: string, payload: unknown, keys: string[]): T {
  const record = payload !== null && typeof payload === "object" ? payload : undefined;
  const ok =
    record &&
    [...keys, "repository"].every((key) => {
      const value = (record as Record<string, unknown>)[key];
      return value !== null && typeof value === "object";
    });
  if (!ok)
    throw new Error(`Unexpected ${event} payload: expected ${keys.join(", ")} and repository`);
  return payload as T;
}
