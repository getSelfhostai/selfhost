import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, StringEnum, Url, Uuidv7 } from "./common.js";
import type { LedgerEvent } from "./event.js";
import { REVIEWER_TOOLS } from "./integration-tools.js";
import { createValidator } from "./validate.js";

/**
 * A second opinion: what the team's AI reviewer (PR-Agent, the Claude Code GitHub Action or
 * CodeRabbit) said about an agent pull request, normalized so the three can be compared. The
 * GitHub App writes one review.submitted ledger event per review, with this under
 * data.second_opinion; the review list attaches the newest from each tool to the pull request's
 * item, and the risk score reads it as one input.
 */

/** The ledger event kind a reviewer's verdict is recorded under. */
export const SECOND_OPINION_EVENT_KIND = "review.submitted";

/**
 * approve: the reviewer found nothing to fix. changes: it asks for changes before merge.
 * comment: it left findings without a verdict. failed: its run failed, so there is no opinion.
 */
export const SECOND_OPINION_VERDICTS = ["approve", "changes", "comment", "failed"] as const;

/** Highest first. */
export const FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type SecondOpinionVerdict = (typeof SECOND_OPINION_VERDICTS)[number];
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** What a reviewer said, as data.second_opinion of a review.submitted event. */
export const SecondOpinionDataSchema = Type.Object(
  {
    tool: StringEnum(REVIEWER_TOOLS, {
      description: "The reviewer: pr-agent, claude-code-action or coderabbit.",
    }),
    reviewer: NonEmpty({
      description: "GitHub login the review was posted under, such as coderabbitai[bot].",
    }),
    verdict: StringEnum(SECOND_OPINION_VERDICTS, {
      description:
        "approve (nothing to fix), changes (asks for changes before merge), comment (findings without a verdict) or failed (the reviewer's run failed).",
    }),
    findings: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "Findings the reviewer reported, when it says how many. Style nitpicks are not counted.",
      }),
    ),
    severity: Type.Optional(
      StringEnum(FINDING_SEVERITIES, {
        description: "The highest severity among the findings, when the reviewer grades them.",
      }),
    ),
    url: Type.Optional(Url({ description: "The review, comment or CI run on GitHub." })),
    head_sha: Type.Optional(
      Type.String({ pattern: "^[0-9a-f]{7,64}$", description: "The commit that was reviewed." }),
    ),
  },
  { additionalProperties: false, description: "A reviewer's verdict, normalized." },
);

export const SecondOpinionSchema = Type.Object(
  {
    ...SecondOpinionDataSchema.properties,
    at: DateTime({ description: "When the reviewer posted it." }),
    event_id: Uuidv7({ description: "The review.submitted ledger event that holds it." }),
  },
  {
    additionalProperties: false,
    description:
      "What the team's AI reviewer said about the pull request: the newest review from one tool.",
  },
);

export type SecondOpinionData = Static<typeof SecondOpinionDataSchema>;
export type SecondOpinion = Static<typeof SecondOpinionSchema>;

const dataValidator = createValidator(SecondOpinionDataSchema);

/** The pull request a review.submitted event is about. */
export function secondOpinionPull(event: Pick<LedgerEvent, "links" | "target">) {
  return event.links?.pr_url ?? (event.target?.type === "pr" ? event.target.value : undefined);
}

/** The second opinion a review.submitted event holds, or undefined for any other event. */
export function secondOpinionOf(event: LedgerEvent): SecondOpinion | undefined {
  if (event.kind !== SECOND_OPINION_EVENT_KIND) return undefined;
  const checked = dataValidator.validate(event.data?.second_opinion);
  if (!checked.ok) return undefined;
  return { ...checked.value, at: new Date(event.ts).toISOString(), event_id: event.id };
}

/** The newest opinion from each tool, in REVIEWER_TOOLS order. */
export function latestSecondOpinions(opinions: readonly SecondOpinion[]): SecondOpinion[] {
  const newest = new Map<string, SecondOpinion>();
  for (const opinion of opinions) {
    const current = newest.get(opinion.tool);
    const later =
      !current ||
      Date.parse(opinion.at) > Date.parse(current.at) ||
      (opinion.at === current.at && opinion.event_id > current.event_id);
    if (later) newest.set(opinion.tool, opinion);
  }
  return REVIEWER_TOOLS.flatMap((tool) => {
    const opinion = newest.get(tool);
    return opinion ? [opinion] : [];
  });
}

const VERDICT_TEXT: Record<SecondOpinionVerdict, string> = {
  approve: "approved",
  changes: "requested changes",
  comment: "commented",
  failed: "failed to run",
};

export const REVIEWER_NAMES: Record<SecondOpinionData["tool"], string> = {
  "pr-agent": "PR-Agent",
  "claude-code-action": "Claude Code",
  coderabbit: "CodeRabbit",
};

/** "CodeRabbit requested changes: 3 findings, highest critical". */
export function describeSecondOpinion(
  opinion: Pick<SecondOpinionData, "tool" | "verdict" | "findings" | "severity">,
): string {
  const name = REVIEWER_NAMES[opinion.tool];
  const parts: string[] = [];
  if (opinion.findings !== undefined) {
    parts.push(`${opinion.findings} finding${opinion.findings === 1 ? "" : "s"}`);
  }
  if (opinion.severity) parts.push(`highest ${opinion.severity}`);
  return `${name} ${VERDICT_TEXT[opinion.verdict]}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
}

/**
 * The overall second opinion on a pull request, `second_opinion` on its review item: the
 * strictest of the newest verdicts from each tool (changes, then failed, then comment, then
 * approve), so approve means every reviewer approved. Approval routing reads it.
 */
export const OverallSecondOpinionSchema = Type.Object(
  {
    verdict: StringEnum(SECOND_OPINION_VERDICTS, {
      description:
        "approve only when every reviewer approved; changes when any asked for changes; failed when a reviewer's run failed and none asked for changes; else comment.",
    }),
    tool: Type.Optional(
      StringEnum(REVIEWER_TOOLS, { description: "The reviewer whose verdict this is." }),
    ),
    summary: Type.Optional(
      Type.String({
        description: "One line per reviewer, such as CodeRabbit requested changes: 3 findings.",
      }),
    ),
  },
  { additionalProperties: false, description: "The overall verdict of the team's AI reviewers." },
);

export type OverallSecondOpinion = Static<typeof OverallSecondOpinionSchema>;

const STRICTNESS: readonly SecondOpinionVerdict[] = ["changes", "failed", "comment", "approve"];

/** The overall verdict of the newest opinion from each tool, or undefined with none. */
export function overallSecondOpinion(
  opinions: readonly SecondOpinion[],
): OverallSecondOpinion | undefined {
  const latest = latestSecondOpinions(opinions);
  const strictest = [...latest].sort(
    (a, b) => STRICTNESS.indexOf(a.verdict) - STRICTNESS.indexOf(b.verdict),
  )[0];
  if (!strictest) return undefined;
  return {
    verdict: strictest.verdict,
    tool: strictest.tool,
    summary: latest.map((opinion) => describeSecondOpinion(opinion)).join("; "),
  };
}
