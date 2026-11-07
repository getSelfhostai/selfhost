import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, StringEnum } from "./common.js";
import { RuleSchema, SelfhostConfigSchema } from "./config.js";
import {
  AGENT_VENDORS,
  EVENT_KINDS,
  LedgerEventSchema,
  MAX_EVENT_BATCH,
  PERSON_VERDICTS,
  VERDICTS,
} from "./event.js";
import { REVIEW_ITEM_STATES, ReviewItemSchema } from "./review-item.js";

/** Request and response bodies for the HTTP API (openapi.yaml) and the MCP tools. */

export const PAGE_LIMIT_DEFAULT = 100;
export const PAGE_LIMIT_MAX = 1000;

const Limit = Type.Integer({
  minimum: 1,
  maximum: PAGE_LIMIT_MAX,
  default: PAGE_LIMIT_DEFAULT,
  description: "Maximum number of results.",
});

const Cursor = Type.String({ description: "Opaque cursor from next_cursor of the previous page." });

const NextCursor = Type.Union([Type.String(), Type.Null()], {
  description: "Pass as cursor to get the next page. null on the last page.",
});

export const HealthResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    version: Type.String({ description: "Server version." }),
  },
  { additionalProperties: false, title: "HealthResponse" },
);

export const ApiErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({ description: "Stable machine-readable code, for example not_found." }),
        message: Type.String({ description: "Human-readable message." }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, title: "ApiError" },
);

export const IngestEventsRequestSchema = Type.Object(
  {
    events: Type.Array(LedgerEventSchema, { minItems: 1, maxItems: MAX_EVENT_BATCH }),
  },
  { additionalProperties: false, title: "IngestEventsRequest" },
);

export const IngestEventsResponseSchema = Type.Object(
  {
    accepted: Type.Integer({ minimum: 0, description: "Events written by this request." }),
    duplicates: Type.Integer({
      minimum: 0,
      description: "Events skipped because an event with the same id was already stored.",
    }),
  },
  { additionalProperties: false, title: "IngestEventsResponse" },
);

export const IngestEventsErrorSchema = Type.Object(
  {
    error: Type.Object({ code: Type.Literal("invalid_events"), message: Type.String() }),
    errors: Type.Array(
      Type.Object(
        {
          index: Type.Integer({
            minimum: -1,
            description: "Position of the failing event, or -1 when the batch itself is wrong.",
          }),
          field: Type.String({ description: "Field path, for example actor.kind." }),
          message: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, title: "IngestEventsError" },
);

export const EventQuerySchema = Type.Object(
  {
    person: Type.Optional(Type.String({ description: "actor.id of a person." })),
    agent: Type.Optional(StringEnum(AGENT_VENDORS, { description: "agent.vendor." })),
    model: Type.Optional(Type.String()),
    session: Type.Optional(Type.String({ description: "session_id." })),
    kind: Type.Optional(StringEnum(EVENT_KINDS)),
    from: Type.Optional(DateTime({ description: "Events at or after this time." })),
    to: Type.Optional(DateTime({ description: "Events before this time." })),
    limit: Type.Optional(Limit),
    cursor: Type.Optional(Cursor),
  },
  { additionalProperties: false, title: "EventQuery" },
);

export const EventsPageSchema = Type.Object(
  {
    events: Type.Array(LedgerEventSchema, { description: "Newest first." }),
    next_cursor: NextCursor,
  },
  { additionalProperties: false, title: "EventsPage" },
);

export const ReviewItemQuerySchema = Type.Object(
  {
    state: Type.Optional(StringEnum(REVIEW_ITEM_STATES, { default: "open" })),
    owner: Type.Optional(Type.String({ description: "Only items this person owns." })),
    limit: Type.Optional(Limit),
    cursor: Type.Optional(Cursor),
  },
  { additionalProperties: false, title: "ReviewItemQuery" },
);

export const ReviewItemsPageSchema = Type.Object(
  {
    items: Type.Array(ReviewItemSchema, {
      description: "Ranked: blocking first, then by risk score, then oldest first.",
    }),
    next_cursor: NextCursor,
  },
  { additionalProperties: false, title: "ReviewItemsPage" },
);

export const DecisionRequestSchema = Type.Object(
  {
    verdict: StringEnum(PERSON_VERDICTS),
    reason: Type.Optional(Type.String({ description: "Why. For a question, the answer text." })),
  },
  { additionalProperties: false, title: "DecisionRequest" },
);

export const DecisionResponseSchema = Type.Object(
  {
    item: ReviewItemSchema,
    decision_event: LedgerEventSchema,
  },
  { additionalProperties: false, title: "DecisionResponse" },
);

export const PolicyQuerySchema = Type.Object(
  {
    person: Type.Optional(Type.String({ description: "Resolve team overrides for this person." })),
    agent: Type.Optional(StringEnum(AGENT_VENDORS, { description: "Only rules for this agent." })),
  },
  { additionalProperties: false, title: "PolicyQuery" },
);

export const PolicyResponseSchema = Type.Object(
  {
    hash: Type.String({ description: "sha256 of the selfhost.toml text in use." }),
    commit_sha: Type.Optional(
      Type.String({ description: "Git commit of selfhost.toml, when it is read from a repo." }),
    ),
    loaded_at: DateTime(),
    config: SelfhostConfigSchema,
    effective_rules: Type.Array(RuleSchema, {
      description:
        "Rules after team overrides for the given person and agent, with defaults applied. Rules in mode off are left out.",
    }),
  },
  { additionalProperties: false, title: "PolicyResponse" },
);

export const BudgetQuerySchema = Type.Object(
  {
    person: Type.Optional(Type.String()),
    team: Type.Optional(Type.String()),
    period: Type.Optional(StringEnum(["day", "week", "month"] as const, { default: "month" })),
  },
  { additionalProperties: false, title: "BudgetQuery" },
);

const NullableUsd = (description: string) =>
  Type.Union([Type.Number({ minimum: 0 }), Type.Null()], { description });

export const BudgetResponseSchema = Type.Object(
  {
    period: StringEnum(["day", "week", "month"] as const),
    from: DateTime(),
    to: DateTime(),
    spent_usd: Type.Number({ minimum: 0 }),
    limit_usd: NullableUsd("Budget for the period, or null when none is set."),
    remaining_usd: NullableUsd("limit_usd minus spent_usd, or null when no budget is set."),
    forecast_usd: NullableUsd("Projected spend for the whole period, or null without enough data."),
  },
  { additionalProperties: false, title: "BudgetResponse" },
);

export const DecisionQuerySchema = Type.Object(
  {
    text: Type.Optional(Type.String({ description: "Words to match in the decision reason." })),
    rule_id: Type.Optional(Type.String()),
    verdict: Type.Optional(StringEnum(VERDICTS)),
    repo: Type.Optional(Type.String()),
    target: Type.Optional(
      Type.String({ description: "Substring of the target value: file path, command or URL." }),
    ),
    person: Type.Optional(Type.String({ description: "Who decided." })),
    item_id: Type.Optional(Type.String()),
    from: Type.Optional(DateTime()),
    to: Type.Optional(DateTime()),
    limit: Type.Optional(Limit),
    cursor: Type.Optional(Cursor),
  },
  { additionalProperties: false, title: "DecisionQuery" },
);

export const DecisionsPageSchema = Type.Object(
  {
    decisions: Type.Array(LedgerEventSchema, {
      description: "decision.recorded and policy.evaluated events, newest first.",
    }),
    next_cursor: NextCursor,
  },
  { additionalProperties: false, title: "DecisionsPage" },
);

export const RecordDecisionInputSchema = Type.Object(
  {
    item_id: NonEmpty({ description: "Review item to answer." }),
    verdict: StringEnum(PERSON_VERDICTS),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false, title: "RecordDecisionInput" },
);

export type HealthResponse = Static<typeof HealthResponseSchema>;
export type ApiError = Static<typeof ApiErrorSchema>;
export type IngestEventsRequest = Static<typeof IngestEventsRequestSchema>;
export type IngestEventsResponse = Static<typeof IngestEventsResponseSchema>;
export type IngestEventsError = Static<typeof IngestEventsErrorSchema>;
export type EventQuery = Static<typeof EventQuerySchema>;
export type EventsPage = Static<typeof EventsPageSchema>;
export type ReviewItemQuery = Static<typeof ReviewItemQuerySchema>;
export type ReviewItemsPage = Static<typeof ReviewItemsPageSchema>;
export type DecisionRequest = Static<typeof DecisionRequestSchema>;
export type DecisionResponse = Static<typeof DecisionResponseSchema>;
export type PolicyQuery = Static<typeof PolicyQuerySchema>;
export type PolicyResponse = Static<typeof PolicyResponseSchema>;
export type BudgetQuery = Static<typeof BudgetQuerySchema>;
export type BudgetResponse = Static<typeof BudgetResponseSchema>;
export type DecisionQuery = Static<typeof DecisionQuerySchema>;
export type DecisionsPage = Static<typeof DecisionsPageSchema>;
export type RecordDecisionInput = Static<typeof RecordDecisionInputSchema>;
