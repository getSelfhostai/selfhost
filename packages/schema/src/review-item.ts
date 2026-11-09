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
  "exception",
  "stuck_run",
  "budget",
  "spend_spike",
  "quality",
  "policy_report",
] as const;

export const REVIEW_ITEM_STATES = ["open", "answered", "dismissed", "expired"] as const;

/** What a person can do with an item. answer replies to a question; open follows its url. */
export const REVIEW_ACTIONS = ["approve", "deny", "answer", "snooze", "open"] as const;

/** instant: push now, because an agent is blocked or risk is high. digest: the next digest. */
export const REVIEW_DELIVERIES = ["instant", "digest"] as const;

/** Which routing step found the owners: the owner, the team, the fallback, or none of them. */
export const REVIEW_ROUTE_STEPS = ["owner", "team", "fallback", "none"] as const;

export type ReviewItemKind = (typeof REVIEW_ITEM_KINDS)[number];
export type ReviewItemState = (typeof REVIEW_ITEM_STATES)[number];
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
export type ReviewDelivery = (typeof REVIEW_DELIVERIES)[number];
export type ReviewRouteStep = (typeof REVIEW_ROUTE_STEPS)[number];

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

export const ReviewWhySchema = Type.Object(
  {
    signal: NonEmpty({
      description:
        "The ledger signal behind the item: an event kind such as approval.requested, policy.evaluated or pr.opened, or alert.raised:<alert> for an alert.",
    }),
    rule_id: Type.Optional(
      Type.String({ description: "Rule from selfhost.toml, when a rule raised the item." }),
    ),
    text: NonEmpty({ description: "Why a person is needed, in plain language." }),
  },
  { additionalProperties: false, description: "Why the item exists: the rule or signal." },
);

export const ReviewRouteSchema = Type.Object(
  {
    step: StringEnum(REVIEW_ROUTE_STEPS, {
      description:
        "owner ([review.owners] path globs, else the session's person), team (members of the item's team in [teams]), fallback ([review] fallback), or none when selfhost.toml names nobody.",
    }),
    from: Type.String({
      description:
        'Where the owners came from, for example [review.owners] "db/**", the session\'s person, [teams.platform] or [review] fallback.',
    }),
  },
  { additionalProperties: false, description: "How the owners were chosen." },
);

export const ReviewItemSchema = Type.Object(
  {
    id: Uuidv7({ description: "Review item id." }),
    schema: Type.Literal(REVIEW_ITEM_SCHEMA, { description: "Schema version tag." }),
    kind: StringEnum(REVIEW_ITEM_KINDS, {
      description:
        "pr (agent pull request), approval (an agent waits for permission), question (an agent asks a person), blocked_action (a rule blocked something), exception (a rule blocked a tool call and approving allows that exact call once), stuck_run, budget, spend_spike, quality, or policy_report (what an observed rule would have blocked).",
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
    requested_by: Type.Optional(
      NonEmpty({
        description:
          "For an exception: the person whose agent was blocked. On a team server they cannot approve it unless [review] self_approve_exceptions is true.",
      }),
    ),
    session_id: Type.Optional(Type.String({ description: "Vendor session id." })),
    run_id: Type.Optional(Type.String({ description: "Run id." })),
    run_url: Type.Optional(
      Url({
        description:
          "The run this item came from in the console's run view, <SELFHOST_PUBLIC_URL>/runs/<session_id>. Added by the team server when the item names a session.",
      }),
    ),
    trace_url: Type.Optional(
      Type.String({
        description:
          "The same run in the team's tracer, from [integrations.tracer] run_url, once the run has been sent there.",
      }),
    ),
    brief: Type.Optional(
      Type.String({
        description: "Markdown summary of what the reviewer needs to know to decide quickly.",
      }),
    ),
    source_event_ids: Type.Array(Uuidv7(), {
      description: "Ledger events this item was built from.",
    }),
    answer: Type.Optional(ReviewAnswerSchema),
    why: Type.Optional(ReviewWhySchema),
    deadline: Type.Optional(
      DateTime({
        description:
          "When the item times out. A blocking approval with no answer by then is denied, and the deny is written to the decision log.",
      }),
    ),
    actions: Type.Optional(
      Type.Array(StringEnum(REVIEW_ACTIONS), {
        description: "What a person can do with this item. open needs url.",
      }),
    ),
    delivery: Type.Optional(
      StringEnum(REVIEW_DELIVERIES, {
        description:
          "instant when an agent is blocked or risk is at or above [review] high_risk_threshold, else digest.",
      }),
    ),
    group: Type.Optional(
      Type.String({
        description:
          "Items from the same run or session share this value: run:<run_id>, else session:<session_id>.",
      }),
    ),
    route: Type.Optional(ReviewRouteSchema),
    snoozed_until: Type.Optional(
      DateTime({ description: "Snoozed: ranked after every other item until this time." }),
    ),
    snoozed_by: Type.Optional(Type.String({ description: "Person who snoozed the item." })),
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
export type ReviewWhy = Static<typeof ReviewWhySchema>;
export type ReviewRoute = Static<typeof ReviewRouteSchema>;

export const reviewItemValidator = createValidator(ReviewItemSchema, (item) =>
  requiredWhenErrors(item, "state", REVIEW_ITEM_STATE_REQUIRES),
);

export function validateReviewItem(value: unknown): ValidationResult<ReviewItem> {
  return reviewItemValidator.validate(value);
}
