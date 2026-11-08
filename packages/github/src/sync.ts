import type { Octokit } from "@octokit/rest";
import { agentLabel, isManagedLabel, type RiskLevel, riskLabel } from "./labels.js";

/** The check run's name, the one a team marks as required in branch protection. */
export const REVIEW_CHECK_NAME = "selfhost/review";

/** GitHub's limits on a check run's summary and text, and on a comment body. */
export const MAX_CHECK_OUTPUT = 65_535;
export const MAX_COMMENT_BODY = 65_536;

const TRUNCATED = "\n\n(cut to fit GitHub's size limit)";

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  /** The head commit the check run belongs to. */
  headSha: string;
  /** Login that opened the pull request. GitHub refuses a review request from the author. */
  author?: string;
}

/** `neutral` and `success` pass a required check; `failure` blocks the merge. */
export type CheckConclusion = "neutral" | "success" | "failure";

export interface DesiredCheck {
  /** Default: `selfhost/review`. */
  name?: string;
  title: string;
  /** Markdown, at most 65,535 characters; longer is cut. */
  summary: string;
  /** Markdown, at most 65,535 characters; longer is cut. */
  text?: string;
  conclusion: CheckConclusion;
}

/** What the pull request should show. Each part left out is not read and not changed. */
export interface DesiredState {
  /**
   * Exactly the risk and agent labels the pull request should carry. A managed label that is not
   * listed here (an old risk level, another agent) is removed.
   */
  labels: { risk?: RiskLevel; agent?: string };
  check?: DesiredCheck;
  /** Logins and team slugs to request reviews from, added to any already requested. */
  reviewers?: { users: string[]; teams: string[] };
  /** The review brief comment, found again by `marker`, which `body` should contain. */
  brief?: { body: string; marker: string };
}

export type SyncWrite =
  | { action: "add_labels"; labels: string[] }
  | { action: "remove_label"; label: string }
  | { action: "create_check"; externalId: string }
  | { action: "update_check"; id: number }
  | { action: "request_reviewers"; users: string[]; teams: string[] }
  | { action: "create_comment" }
  | { action: "update_comment"; id: number };

export interface RefusedReviewRequest {
  users: string[];
  teams: string[];
  /** GitHub's reason, such as a login that is not a collaborator. */
  message: string;
}

export interface SyncResult {
  /** Every change made, in order. Empty when the pull request already matched. */
  writes: SyncWrite[];
  /** Review requests GitHub answered with 422. Nothing else is skipped. */
  refused: RefusedReviewRequest[];
}

const lower = (value: string) => value.toLowerCase();

const statusOf = (error: unknown) =>
  typeof error === "object" && error !== null && "status" in error
    ? (error as { status: unknown }).status
    : undefined;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - TRUNCATED.length)}${TRUNCATED}`;
}

/** GitHub keeps bodies as sent, but editors and proxies can change line endings. */
const sameBody = (a: string, b: string) =>
  a.replace(/\r\n/g, "\n").trimEnd() === b.replace(/\r\n/g, "\n").trimEnd();

/**
 * The check run's external_id: one per pull request and head commit, so each push gets its own
 * run and every delivery for the same commit finds the run it already made.
 */
export function checkExternalId(pr: Pick<PullRequestRef, "owner" | "repo" | "number" | "headSha">) {
  return `selfhost:${lower(pr.owner)}/${lower(pr.repo)}#${pr.number}@${lower(pr.headSha)}`;
}

/** A marked comment body as posted: the marker first unless `body` already holds it. */
export function briefBody(brief: { body: string; marker: string }): string {
  const body = brief.body.includes(brief.marker) ? brief.body : `${brief.marker}\n${brief.body}`;
  return clip(body, MAX_COMMENT_BODY);
}

async function syncLabels(
  octokit: Octokit,
  pr: PullRequestRef,
  labels: DesiredState["labels"],
  writes: SyncWrite[],
) {
  const issue = { owner: pr.owner, repo: pr.repo, issue_number: pr.number };
  const current = (
    await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, { ...issue, per_page: 100 })
  ).map((label) => label.name);
  const wanted = [
    ...(labels.risk ? [riskLabel(labels.risk)] : []),
    ...(labels.agent ? [agentLabel(labels.agent)] : []),
  ];
  const wantedLower = new Set(wanted.map(lower));
  const currentLower = new Set(current.map(lower));

  // Old labels go first, so a risk change reads as the old level removed and the new one added.
  for (const name of current) {
    if (!isManagedLabel(name) || wantedLower.has(lower(name))) continue;
    try {
      await octokit.rest.issues.removeLabel({ ...issue, name });
    } catch (error) {
      // Someone removed it since the read; the label is gone either way.
      if (statusOf(error) !== 404) throw error;
    }
    writes.push({ action: "remove_label", label: name });
  }
  const missing = wanted.filter((name) => !currentLower.has(lower(name)));
  if (missing.length > 0) {
    await octokit.rest.issues.addLabels({ ...issue, labels: missing });
    writes.push({ action: "add_labels", labels: missing });
  }
}

async function syncCheck(
  octokit: Octokit,
  pr: PullRequestRef,
  check: DesiredCheck,
  writes: SyncWrite[],
) {
  const name = check.name ?? REVIEW_CHECK_NAME;
  const externalId = checkExternalId(pr);
  const output = {
    title: check.title,
    summary: clip(check.summary, MAX_CHECK_OUTPUT),
    ...(check.text ? { text: clip(check.text, MAX_CHECK_OUTPUT) } : {}),
  };
  const runs = await octokit.paginate(octokit.rest.checks.listForRef, {
    owner: pr.owner,
    repo: pr.repo,
    ref: pr.headSha,
    check_name: name,
    filter: "all",
    per_page: 100,
  });
  // A run made by a race of two deliveries would leave two; the oldest is the one kept up to date.
  const existing = runs
    .filter((run) => run.external_id === externalId && run.name === name)
    .sort((a, b) => a.id - b.id)[0];

  if (!existing) {
    await octokit.rest.checks.create({
      owner: pr.owner,
      repo: pr.repo,
      name,
      head_sha: pr.headSha,
      external_id: externalId,
      status: "completed",
      conclusion: check.conclusion,
      output,
    });
    writes.push({ action: "create_check", externalId });
    return;
  }
  const same =
    existing.status === "completed" &&
    existing.conclusion === check.conclusion &&
    existing.output.title === output.title &&
    existing.output.summary === output.summary &&
    (existing.output.text ?? "") === (output.text ?? "");
  if (same) return;
  await octokit.rest.checks.update({
    owner: pr.owner,
    repo: pr.repo,
    check_run_id: existing.id,
    status: "completed",
    conclusion: check.conclusion,
    output,
  });
  writes.push({ action: "update_check", id: existing.id });
}

async function syncReviewers(
  octokit: Octokit,
  pr: PullRequestRef,
  reviewers: NonNullable<DesiredState["reviewers"]>,
  result: SyncResult,
) {
  const author = pr.author ? lower(pr.author) : undefined;
  const users = [...new Set(reviewers.users)].filter((login) => lower(login) !== author);
  const teams = [...new Set(reviewers.teams)];
  if (users.length === 0 && teams.length === 0) return;

  const pull = { owner: pr.owner, repo: pr.repo, pull_number: pr.number };
  const { data: requested } = await octokit.rest.pulls.listRequestedReviewers(pull);
  const haveUsers = new Set(requested.users.map((user) => lower(user.login)));
  const haveTeams = new Set(requested.teams.map((team) => lower(team.slug)));
  if (users.some((login) => !haveUsers.has(lower(login)))) {
    // GitHub drops a request once the person reviews; asking again would undo their review.
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      ...pull,
      per_page: 100,
    });
    for (const review of reviews) if (review.user) haveUsers.add(lower(review.user.login));
  }
  const newUsers = users.filter((login) => !haveUsers.has(lower(login)));
  const newTeams = teams.filter((slug) => !haveTeams.has(lower(slug)));
  if (newUsers.length === 0 && newTeams.length === 0) return;
  try {
    await octokit.rest.pulls.requestReviewers({
      ...pull,
      reviewers: newUsers,
      team_reviewers: newTeams,
    });
  } catch (error) {
    if (statusOf(error) !== 422) throw error;
    result.refused.push({
      users: newUsers,
      teams: newTeams,
      message: (error instanceof Error && error.message.split("\n")[0]) || "Unprocessable",
    });
    return;
  }
  result.writes.push({ action: "request_reviewers", users: newUsers, teams: newTeams });
}

/** The bot comment holding `marker`, as found and kept in place by `syncComment`. */
export interface SyncedComment {
  id: number;
  /** The comment on github.com. */
  url: string;
  /** The write made, or none when the comment already read `body`. */
  write?: SyncWrite;
}

/**
 * Keeps one bot comment on a pull request: finds the comment holding `marker` (only an app's
 * own comment counts, so a person quoting the marker does not take it over), edits it when its
 * body differs, or posts it once.
 */
export async function syncComment(
  octokit: Octokit,
  pr: Pick<PullRequestRef, "owner" | "repo" | "number">,
  comment: { body: string; marker: string },
): Promise<SyncedComment> {
  if (comment.marker.trim() === "") throw new Error("The comment marker is empty");
  const body = briefBody(comment);
  const issue = { owner: pr.owner, repo: pr.repo, issue_number: pr.number };
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    ...issue,
    per_page: 100,
  });
  const existing = comments.find(
    (found) => found.user?.type === "Bot" && (found.body ?? "").includes(comment.marker),
  );
  if (!existing) {
    const { data } = await octokit.rest.issues.createComment({ ...issue, body });
    return { id: data.id, url: data.html_url, write: { action: "create_comment" } };
  }
  if (sameBody(existing.body ?? "", body)) return { id: existing.id, url: existing.html_url };
  await octokit.rest.issues.updateComment({
    owner: pr.owner,
    repo: pr.repo,
    comment_id: existing.id,
    body,
  });
  return {
    id: existing.id,
    url: existing.html_url,
    write: { action: "update_comment", id: existing.id },
  };
}

async function syncBrief(
  octokit: Octokit,
  pr: PullRequestRef,
  brief: NonNullable<DesiredState["brief"]>,
  writes: SyncWrite[],
) {
  const { write } = await syncComment(octokit, pr, brief);
  if (write) writes.push(write);
}

/**
 * Makes the pull request show `desired`: reads the labels, the check runs on the head commit,
 * the review requests and the comments, then writes only what differs. Each write follows a
 * read of the state it changes, so once a run succeeds the next run with the same `desired`
 * finds everything in place and writes nothing; a webhook delivered twice changes nothing.
 *
 * Labels are kept to exactly the risk and agent label given. The check run is found by its
 * external_id (one per pull request and head commit) and updated, or created once. Reviewers
 * are only added: someone already requested, or who already reviewed, is not asked again, and
 * requests made by people are never removed. The brief comment is found by its marker and
 * edited in place, or created once.
 */
export async function syncPullRequest(
  octokit: Octokit,
  pr: PullRequestRef,
  desired: DesiredState,
): Promise<SyncResult> {
  const result: SyncResult = { writes: [], refused: [] };
  await syncLabels(octokit, pr, desired.labels, result.writes);
  if (desired.check) await syncCheck(octokit, pr, desired.check, result.writes);
  if (desired.brief) await syncBrief(octokit, pr, desired.brief, result.writes);
  if (desired.reviewers) await syncReviewers(octokit, pr, desired.reviewers, result);
  return result;
}
