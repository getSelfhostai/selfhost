import type { AgentRef } from "@selfhost/attribution";
import type { Octokit } from "@selfhost/github";
import {
  coderabbitSeverity,
  higherSeverity,
  REVIEWER_EVENTS,
  type ReviewedPull,
  type ReviewerDelivery,
} from "@selfhost/integrations";
import { databaseOf, type Ledger, stableEventId } from "@selfhost/ledger";
import {
  EVENT_SCHEMA,
  type LedgerEvent,
  latestSecondOpinions,
  REVIEWER_NAMES,
  SECOND_OPINION_EVENT_KIND,
  type SecondOpinion,
  type SecondOpinionData,
  secondOpinionOf,
} from "@selfhost/schema";

/** X-GitHub-Event values that can carry a reviewer's verdict. */
export const isReviewerEvent = (event: string) =>
  (REVIEWER_EVENTS as readonly string[]).includes(event);

const json = <T>(value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as T;

/**
 * The newest second opinion from each reviewer on a pull request, from the review.submitted
 * events the GitHub App recorded, in any team: they are about the pull request, not a person.
 */
export function ledgerSecondOpinions(ledger: Ledger): (url: string) => Promise<SecondOpinion[]> {
  return async (url) => {
    const rows = await databaseOf(ledger).query<{ body: unknown }>(
      `SELECT body FROM events
       WHERE kind = $1 AND coalesce(body#>>'{links,pr_url}', body#>>'{target,value}') = $2
       ORDER BY ts, id`,
      [SECOND_OPINION_EVENT_KIND, url],
    );
    return latestSecondOpinions(
      rows.flatMap((row) => {
        const opinion = secondOpinionOf(json<LedgerEvent>(row.body));
        return opinion ? [opinion] : [];
      }),
    );
  };
}

/** The pull request a delivery is about: from the payload, else read through the App. */
export async function reviewedPull(
  octokit: Octokit,
  delivery: ReviewerDelivery,
): Promise<ReviewedPull> {
  if (delivery.pull) return delivery.pull;
  const { data } = await octokit.rest.pulls.get({
    owner: delivery.owner,
    repo: delivery.name,
    pull_number: delivery.number,
  });
  return data as ReviewedPull;
}

/**
 * CodeRabbit puts each finding's severity on its inline comment, not in the review body, so the
 * review's comments are read once. A failed read keeps the severity from the body.
 */
export async function withInlineSeverity(
  octokit: Octokit,
  delivery: ReviewerDelivery,
): Promise<SecondOpinionData> {
  const review = delivery.coderabbitReview;
  if (review === undefined) return delivery.opinion;
  try {
    const comments = await octokit.paginate(octokit.rest.pulls.listCommentsForReview, {
      owner: delivery.owner,
      repo: delivery.name,
      pull_number: delivery.number,
      review_id: review,
      per_page: 100,
    });
    const severity = higherSeverity(
      delivery.opinion.severity,
      coderabbitSeverity(comments.map((comment) => comment.body ?? "")),
    );
    return { ...delivery.opinion, ...(severity ? { severity } : {}) };
  } catch {
    return delivery.opinion;
  }
}

/**
 * The review.submitted event for one verdict. Its id comes from the repository and GitHub's id
 * for what was posted (an edited comment's edit time included), so a redelivery writes nothing
 * new and each new review of the same comment does.
 */
export function secondOpinionEvent(
  delivery: ReviewerDelivery,
  opinion: SecondOpinionData,
  url: string,
  agent: AgentRef,
): LedgerEvent {
  return {
    id: stableEventId(
      delivery.at,
      `${SECOND_OPINION_EVENT_KIND}\n${delivery.repo}\n${delivery.key}`,
    ),
    schema: EVENT_SCHEMA,
    ts: delivery.at,
    source: "github",
    kind: SECOND_OPINION_EVENT_KIND,
    actor: { kind: "system", id: opinion.reviewer, name: REVIEWER_NAMES[opinion.tool] },
    repo: delivery.repo,
    agent: { vendor: agent.vendor },
    ...(agent.model ? { model: agent.model } : {}),
    target: { type: "pr", value: url },
    links: {
      pr_url: url,
      ...(opinion.head_sha ? { commit_sha: opinion.head_sha } : {}),
    },
    data: { second_opinion: opinion },
  };
}
