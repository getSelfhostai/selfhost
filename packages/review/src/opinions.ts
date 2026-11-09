import {
  describeSecondOpinion,
  latestSecondOpinions,
  type ResolvedSelfhostConfig,
  type ReviewItem,
  type SecondOpinion,
} from "@selfhost/schema";

/** Reasons a second opinion adds to a pr item's risk start with this. */
export const SECOND_OPINION_REASON = "Second opinion: ";

const SEVERE = new Set(["critical", "high"]);

/**
 * The lowest score a second opinion holds a pr item at: the high threshold when the reviewer
 * asked for changes over a critical or high finding, the medium band (half of it, rounded up)
 * for any other request for changes or a severe finding left as a comment. Approvals, clean
 * comments and failed runs hold nothing.
 */
export function opinionFloor(opinion: SecondOpinion, config: ResolvedSelfhostConfig): number {
  const high = config.review.high_risk_threshold;
  const severe = SEVERE.has(opinion.severity ?? "");
  if (opinion.verdict === "changes") return severe ? high : Math.ceil(high / 2);
  if (opinion.verdict === "comment" && severe && (opinion.findings ?? 1) > 0) {
    return Math.ceil(high / 2);
  }
  return 0;
}

/**
 * A pr item's risk with its second opinions as one input: each opinion that holds a floor raises
 * the score to it, with its reason. Reasons from earlier opinions are replaced by the current
 * ones. A later approval does not lower the score, since the item does not keep the score from
 * before: once a reviewer flagged the change, a person reads it.
 */
export function withSecondOpinionRisk(
  risk: ReviewItem["risk"],
  opinions: readonly SecondOpinion[] | undefined,
  config: ResolvedSelfhostConfig,
): ReviewItem["risk"] {
  if (!opinions || opinions.length === 0) return risk;
  let score = risk.score;
  const reasons = risk.reasons.filter((reason) => !reason.startsWith(SECOND_OPINION_REASON));
  for (const opinion of opinions) {
    const floor = opinionFloor(opinion, config);
    if (floor === 0) continue;
    score = Math.max(score, floor);
    reasons.push(`${SECOND_OPINION_REASON}${describeSecondOpinion(opinion)}`);
  }
  return { score, reasons };
}

/** The item's opinions with `added` in, the newest from each tool kept. */
export function mergeOpinions(
  current: readonly SecondOpinion[] | undefined,
  added: readonly SecondOpinion[],
): SecondOpinion[] {
  return latestSecondOpinions([...(current ?? []), ...added]);
}
