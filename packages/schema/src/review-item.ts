import { type Static, Type } from "@sinclair/typebox";
import {
  DateTime,
  NonEmpty,
  RepoSlug,
  requiredWhenSchema,
  StringEnum,
  schemaId,
  Url,
  Uuidv7,
} from "./common.js";
import { AgentRefSchema, VerdictSchema } from "./event.js";
import { createValidator, requiredWhenErrors, type ValidationResult } from "./validate.js";

export const REVIEW_ITEM_SCHEMA = "selfhost.review_item/v1";

export const REVIEW_ITEM_KINDS = [
  "pr",
  "approval",
  "question",
  "blocked_action",
  "stuck_run",
  "budget",
  "spend_spike",
  "quality",
  "policy_report",
] as const;

export const REVIEW_ITEM_STATES = ["open", "answered", "dismissed", "expired"] as const;

export type ReviewItemKind = (typeof REVIEW_ITEM_KINDS)[number];
export type ReviewItemState = (typeof REVIEW_ITEM_STATES)[number];

export const REVIEW_ITEM_STATE_REQUIRES = {
  answered: ["answer"],
} as const satisfies Partial<Record<ReviewItemState, readonly string[]>>;

export const RiskSchema = Type.Object(
  {
    score: Type.Integer({
      minimum: 0,
      maximum: 100,
      description: "0 is safe to skim, 100 needs a careful human read. Drives the ranking.",
    }),
    reasons: Type.Array(Type.String(), {
      description: "Plain-language reasons behind the score, most important first.",
    }),
  },
  { additionalProperties: false, description: "Risk score and why." },
);

export const ReviewAnswerSchema = Type.Object(
  {
    by: NonEmpty({ description: "Person who answered." }),
    verdict: VerdictSchema,
    reason: Type.Optional(Type.String({ description: "Why. For a question, the answer text." })),
    at: DateTime({ description: "When the answer was recorded." }),
    decision_event_id: Uuidv7({
      description: "The decision.recorded ledger event that holds this answer.",
    }),
  },
  { additionalProperties: false, description: "The human answer that closed the item." },
);

export const ReviewItemSchema = Type.Object(
  {
    id: Uuidv7({ description: "Review item id." }),
    schema: Type.Literal(REVIEW_ITEM_SCHEMA, { description: "Schema version tag." }),
    kind: StringEnum(REVIEW_ITEM_KINDS, {
      description:
        "pr (agent pull request), approval (an agent waits for permission), question (an agent asks a person), blocked_action (a rule blocked something), stuck_run, budget, spend_spike, quality, or policy_report (what an observed rule would have blocked).",
    }),
    title: NonEmpty({ description: "One line shown in the list." }),
    created_at: DateTime(),
    updated_at: DateTime(),
    state: StringEnum(REVIEW_ITEM_STATES, { description: "Lifecycle state." }),
    blocking: Type.Boolean({ description: "true when an agent is waiting on this answer." }),
    risk: RiskSchema,
    repo: Type.Optional(RepoSlug({ description: "Repository as owner/name." })),
    url: Type.Optional(Url({ description: "Where to act, for example the PR URL." })),
    owners: Type.Array(NonEmpty(), {
      description: "People who should answer, from [review.owners] or the session owner.",
    }),
    agent: Type.Optional(AgentRefSchema),
    session_id: Type.Optional(Type.String({ description: "Vendor session id." })),
    run_id: Type.Optional(Type.String({ description: "Run id." })),
    brief: Type.Optional(
      Type.String({
        description: "Markdown summary of what the reviewer needs to know to decide quickly.",
      }),
    ),
    source_event_ids: Type.Array(Uuidv7(), {
      description: "Ledger events this item was built from.",
    }),
    answer: Type.Optional(ReviewAnswerSchema),
  },
  {
    $id: schemaId("review-item.schema.json"),
    title: "ReviewItem",
    description:
      "One entry in the review list: something that needs a human, ranked by risk and whether an agent is blocked.",
    additionalProperties: false,
    allOf: requiredWhenSchema("state", REVIEW_ITEM_STATE_REQUIRES),
  },
);

export type ReviewItem = Static<typeof ReviewItemSchema>;
export type ReviewAnswer = Static<typeof ReviewAnswerSchema>;

export const reviewItemValidator = createValidator(ReviewItemSchema, (item) =>
  requiredWhenErrors(item, "state", REVIEW_ITEM_STATE_REQUIRES),
);

export function validateReviewItem(value: unknown): ValidationResult<ReviewItem> {
  return reviewItemValidator.validate(value);
}
