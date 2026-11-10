import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, RepoSlug, StringEnum, Url, Uuidv7 } from "./common.js";
import { COMPILE_VENDORS, PolicyCoverageSchema } from "./compile.js";
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
    event_schemas: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Event schema versions POST /v1/events accepts, newest first. Older ones are upgraded at ingest. Absent on servers older than event schema versioning, which accept selfhost.event/v1 only.",
      }),
    ),
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
    team: Type.Optional(
      Type.String({
        description:
          "Team id on a team server: events written with that team's person tokens. A person token reads only its own team.",
      }),
    ),
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
    team: Type.Optional(
      Type.String({
        description:
          "Team id on a team server: items built from that team's events. A person token reads only its own team.",
      }),
    ),
    limit: Type.Optional(Limit),
    cursor: Type.Optional(Cursor),
  },
  { additionalProperties: false, title: "ReviewItemQuery" },
);

export const ReviewItemsPageSchema = Type.Object(
  {
    items: Type.Array(ReviewItemSchema, {
      description:
        "Ranked: blocking first, then by risk score, then oldest first, then by id. Snoozed items come after the rest until their snooze ends.",
    }),
    next_cursor: NextCursor,
  },
  { additionalProperties: false, title: "ReviewItemsPage" },
);

export const DecisionRequestSchema = Type.Object(
  {
    verdict: StringEnum(PERSON_VERDICTS),
    reason: Type.Optional(Type.String({ description: "Why. For a question, the answer text." })),
    by: Type.Optional(
      NonEmpty({
        description:
          "Person who decided. Required with the admin token; a person token always decides as its own person.",
      }),
    ),
  },
  { additionalProperties: false, title: "DecisionRequest" },
);

export const SnoozeRequestSchema = Type.Object(
  {
    until: DateTime({
      description:
        "Rank the item after the rest until this time. A time in the past ends a snooze.",
    }),
    by: Type.Optional(
      NonEmpty({
        description:
          "Person who snoozed. Required with the admin token; a person token always snoozes as its own person.",
      }),
    ),
  },
  { additionalProperties: false, title: "SnoozeRequest" },
);

export const ReviewItemConflictSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.Literal("not_open"),
        message: Type.String({ description: "Human-readable message." }),
      },
      { additionalProperties: false },
    ),
    item: ReviewItemSchema,
  },
  {
    additionalProperties: false,
    title: "ReviewItemConflict",
    description: "The item is no longer open: someone answered it, it expired or was closed.",
  },
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
    team: Type.Optional(
      Type.String({
        description:
          "Team id on a team server. Needed with the admin token; a person token reads its own team by default, or another team it is in.",
      }),
    ),
    repo: Type.Optional(
      RepoSlug({
        description:
          "A repo the team owns, as owner/name: the policy with the repo's own rules on top.",
      }),
    ),
  },
  { additionalProperties: false, title: "PolicyQuery" },
);

export const POLICY_LAYER_KINDS = ["org", "team", "repo"] as const;

export const PolicyResponseSchema = Type.Object(
  {
    hash: Type.String({ description: "sha256 of the selfhost.toml text in use." }),
    team: Type.Optional(Type.String({ description: "Team id, when the policy is a team's." })),
    repo: Type.Optional(RepoSlug({ description: "The repo, when its own rules are included." })),
    layers: Type.Optional(
      Type.Array(
        Type.Object(
          { kind: StringEnum(POLICY_LAYER_KINDS), name: Type.String() },
          { additionalProperties: false },
        ),
        {
          description:
            "What text is made of, in order: the org floor, the team's selfhost.toml, the repo's. With one layer text is that layer's own.",
        },
      ),
    ),
    text: Type.Optional(Type.String({ description: "The selfhost.toml text in use." })),
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

export const PolicyCoverageQuerySchema = Type.Object(
  {
    team: Type.Optional(
      Type.String({
        description:
          "Team id on a team server. Needed with the admin token; a person token reads its own team by default, or another team it is in.",
      }),
    ),
    vendor: Type.Optional(
      StringEnum(COMPILE_VENDORS, { description: "Only this vendor's coverage." }),
    ),
  },
  { additionalProperties: false, title: "PolicyCoverageQuery" },
);

export const PolicyCoverageResponseSchema = Type.Object(
  {
    hash: Type.String({ description: "sha256 of the selfhost.toml text compiled." }),
    team: Type.String({ description: "Team id." }),
    coverage: PolicyCoverageSchema,
  },
  {
    additionalProperties: false,
    title: "PolicyCoverageResponse",
    description:
      "What selfhost policy compile would write for the team's selfhost.toml: per rule and vendor, whether the vendor's native controls express it and whether the selfhost hook covers the rest.",
  },
);

export const INTEGRATION_STATUSES = ["connected", "not_configured", "error"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];
export const INTEGRATIONS_SCHEMA = "selfhost.integrations/v1";

const TeamQuery = Type.Optional(
  Type.String({
    description:
      "Team id on a team server. Needed with the admin token; a person token uses its own team by default, or another team it is in.",
  }),
);

export const IntegrationsQuerySchema = Type.Object(
  { team: TeamQuery },
  { additionalProperties: false, title: "IntegrationsQuery" },
);

/** Where an integration's tool is set: the team's policy, or the server's own environment. */
export const INTEGRATION_SOURCES = ["policy", "server_environment"] as const;
export type IntegrationSource = (typeof INTEGRATION_SOURCES)[number];

export const IntegrationStateSchema = Type.Object(
  {
    tool: Type.Union([Type.String(), Type.Null()], {
      description:
        "The tool picked for this job in [integrations.<kind>] ([runtime] default for the runtime), or the one the server's own environment sets up, or null when none is.",
    }),
    status: StringEnum(INTEGRATION_STATUSES, {
      description:
        "connected: the check reached the tool and its credentials work. not_configured: no tool is picked. error: the check failed; detail says what to fix.",
    }),
    detail: Type.String({
      description:
        "One or two plain sentences: what the check found, and on error what to change. Never holds a secret.",
    }),
    settings: Type.Record(Type.String(), Type.Unknown(), {
      description:
        "The tool's settings from [integrations.<kind>] without tool. Secrets are only ever named by environment variable, and credentials in a URL are masked.",
    }),
    checked_at: DateTime({
      description:
        "When this check ran. The server keeps a team's results for 60 seconds while its [integrations] stay the same.",
    }),
    source: Type.Optional(
      StringEnum(INTEGRATION_SOURCES, {
        description:
          "Where the tool comes from: policy, the team's selfhost.toml (the default when absent), or server_environment, the server's own settings (SELFHOST_GATEWAY_TOOL or the server's selfhost.toml) when the team's policy picks none. Changing it there is up to whoever runs the server.",
      }),
    ),
  },
  { additionalProperties: false, title: "IntegrationState" },
);

export const IntegrationsResponseSchema = Type.Object(
  {
    schema: Type.Literal(INTEGRATIONS_SCHEMA),
    team: Type.String({ description: "Team id." }),
    integrations: Type.Object(
      {
        router: IntegrationStateSchema,
        tracer: IntegrationStateSchema,
        runtime: IntegrationStateSchema,
        reviewer: IntegrationStateSchema,
      },
      { additionalProperties: false },
    ),
  },
  {
    additionalProperties: false,
    title: "IntegrationsResponse",
    description:
      "The tool the team picked for each job, from [integrations] in the policy in use (the org's, then the team's), each checked from the server just now.",
  },
);

export const SetIntegrationRequestSchema = Type.Object(
  {
    tool: Type.Union([NonEmpty(), Type.Null()], {
      description: "The tool to use for this job, or null to remove [integrations.<kind>].",
    }),
    settings: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "The rest of [integrations.<kind>], such as url or api_key_env. Secrets go in environment variables on the server and are named here, never sent.",
      }),
    ),
  },
  { additionalProperties: false, title: "SetIntegrationRequest" },
);

export const BUDGET_PERIODS = ["day", "week", "month"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const BudgetQuerySchema = Type.Object(
  {
    person: Type.Optional(
      Type.String({
        description:
          "Only this person's spend in the team, against their [budget.person] limit. A person token's own budgets are in budgets either way.",
      }),
    ),
    team: Type.Optional(
      Type.String({
        description:
          "Team id. Needed with the admin token; a person token reads its own team by default, or another team it is in.",
      }),
    ),
    period: Type.Optional(
      StringEnum(BUDGET_PERIODS, {
        default: "month",
        description:
          "The UTC day, the week from Monday, or the calendar month, now, for the top-level fields. budgets lists every period that has a budget.",
      }),
    ),
  },
  { additionalProperties: false, title: "BudgetQuery" },
);

const NullableUsd = (description: string) =>
  Type.Union([Type.Number({ minimum: 0 }), Type.Null()], { description });

export const BUDGET_SCOPES = ["person", "team", "org"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/** Who or what stops spend at a budget: the AI gateway, or nothing (an alert only). */
export const BUDGET_ENFORCEMENTS = ["gateway", "alert"] as const;
export type BudgetEnforcement = (typeof BUDGET_ENFORCEMENTS)[number];

export const BudgetLineSchema = Type.Object(
  {
    scope: StringEnum(BUDGET_SCOPES, {
      description:
        "person: [budget.person] of the team's selfhost.toml, each person's own. team: [budget] of the team's. org: [budget] of the org's, the total of every team.",
    }),
    owner: Type.String({ description: "The person, team or org id the budget is for." }),
    period: StringEnum(BUDGET_PERIODS),
    from: DateTime(),
    to: DateTime({ description: "When the period ends and the budget starts again." }),
    limit_usd: Type.Number({ minimum: 0 }),
    spent_usd: NullableUsd(
      "Spend in the period: the gateway's own count for a gateway budget when it answered, else the ledger's. null when the caller may not see it (the org's total needs every team).",
    ),
    remaining_usd: NullableUsd("limit_usd minus spent_usd, never below 0; null with spent_usd."),
    enforcement: StringEnum(BUDGET_ENFORCEMENTS, {
      description:
        "gateway: [budget] mode = hard and the AI gateway holds this limit, so it refuses requests through it once spent. alert: spend is shown and alerts are raised; nothing is stopped.",
    }),
    cut_off: Type.Boolean({
      description:
        "true when the gateway refuses these requests now: a gateway budget whose spend reached its limit, until `to`.",
    }),
    raise: Type.String({
      description: "Who can raise the budget and where: the selfhost.toml that sets it.",
    }),
  },
  {
    additionalProperties: false,
    title: "BudgetLine",
    description: "One budget that applies to the caller, with spend against it.",
  },
);

export const BudgetResponseSchema = Type.Object(
  {
    period: StringEnum(BUDGET_PERIODS),
    from: DateTime(),
    to: DateTime(),
    spent_usd: Type.Number({ minimum: 0 }),
    limit_usd: NullableUsd(
      "Budget for the period, or null when none is set: the person's with person, else the team's.",
    ),
    remaining_usd: NullableUsd("limit_usd minus spent_usd, or null when no budget is set."),
    forecast_usd: NullableUsd("Projected spend for the whole period, or null without enough data."),
    budgets: Type.Optional(
      Type.Array(BudgetLineSchema, {
        description:
          "Every budget that applies to the caller, in every period that has one: the person's own (or the one asked about), the team's and the org's, each gateway-enforced or alert-only, cut-off ones first.",
      }),
    ),
  },
  { additionalProperties: false, title: "BudgetResponse" },
);

export const DecisionQuerySchema = Type.Object(
  {
    path: Type.Optional(
      NonEmpty({
        description:
          "File or folder path relative to the repository root. Matches decisions on that file, on files under that folder, and on folders that hold it.",
      }),
    ),
    topic: Type.Optional(
      NonEmpty({
        description:
          "Words to match in the decision's question and reason. Every word must appear; case is ignored.",
      }),
    ),
    text: Type.Optional(Type.String({ description: "Words to match in the decision reason." })),
    rule_id: Type.Optional(Type.String()),
    verdict: Type.Optional(StringEnum(VERDICTS)),
    repo: Type.Optional(Type.String()),
    target: Type.Optional(
      Type.String({ description: "Substring of the target value: file path, command or URL." }),
    ),
    person: Type.Optional(Type.String({ description: "Who decided." })),
    team: Type.Optional(
      Type.String({
        description:
          "Team id on a team server: decisions and verdicts stored with that team's events. The MCP tool reads every team of the person's by default.",
      }),
    ),
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

/**
 * Where a decision was made. Every surface records it through POST /v1/decisions or the
 * recordDecision call behind it. Two decisions no person makes: timeout is the review list
 * denying an approval nobody answered in time, and auto_approve is the GitHub App approving a
 * low-risk agent pull request under [review.auto_approve].
 */
export const DECISION_SURFACES = [
  "cli",
  "rule_promotion",
  "exception_approval",
  "github_review",
  "github_comment",
  "slack",
  "telegram",
  "mcp",
  "api",
  "timeout",
  "auto_approve",
] as const;

export type DecisionSurface = (typeof DECISION_SURFACES)[number];

export const CreateDecisionRequestSchema = Type.Object(
  {
    verdict: StringEnum(PERSON_VERDICTS),
    by: NonEmpty({ description: "Person who decided, such as a git email or GitHub login." }),
    name: Type.Optional(Type.String({ description: "Display name of the person." })),
    reason: Type.Optional(
      Type.String({ description: "Why, in the person's own words. For a question, the answer." }),
    ),
    question: Type.Optional(
      Type.String({
        description:
          "What was decided, in one line: the review item title, the pull request title or the rule change. Topic search matches it along with the reason.",
      }),
    ),
    item_id: Type.Optional(Uuidv7({ description: "Review item this decision answers." })),
    run_id: Type.Optional(NonEmpty({ description: "Run this decision answers." })),
    rule_id: Type.Optional(NonEmpty({ description: "Rule from selfhost.toml it is about." })),
    repo: Type.Optional(RepoSlug({ description: "Repository as owner/name." })),
    paths: Type.Optional(
      Type.Array(NonEmpty(), {
        maxItems: 1000,
        description:
          "Files or folders the decision is about, relative to the repository root. Path search matches them.",
      }),
    ),
    pr_url: Type.Optional(Url({ description: "Pull request URL." })),
    run_url: Type.Optional(Url({ description: "CI run or agent run URL." })),
    commit_sha: Type.Optional(
      Type.String({ pattern: "^[0-9a-f]{7,64}$", description: "Git commit SHA." }),
    ),
    replaces_event_id: Type.Optional(
      Uuidv7({
        description:
          "Decision this one corrects or overturns. The earlier event stays as it was; item, run, rule, question, paths and links not given here are carried over from it.",
      }),
    ),
    surface: Type.Optional(
      StringEnum(DECISION_SURFACES, { default: "api", description: "Where the person decided." }),
    ),
    key: Type.Optional(
      NonEmpty({
        maxLength: 256,
        description:
          "Idempotency key: the surface's own id for this action, such as a GitHub review id or a Slack action id. Sent again with the same ts, it writes nothing new.",
      }),
    ),
    ts: Type.Optional(
      DateTime({ description: "When the person decided. Default: now. Required with key." }),
    ),
  },
  { additionalProperties: false, title: "CreateDecisionRequest" },
);

export const CreateDecisionResponseSchema = Type.Object(
  {
    decision_event: LedgerEventSchema,
    duplicate: Type.Boolean({
      description: "true when this action was already recorded, so nothing new was written.",
    }),
  },
  { additionalProperties: false, title: "CreateDecisionResponse" },
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
export type SnoozeRequest = Static<typeof SnoozeRequestSchema>;
export type ReviewItemConflict = Static<typeof ReviewItemConflictSchema>;
export type PolicyQuery = Static<typeof PolicyQuerySchema>;
export type PolicyResponse = Static<typeof PolicyResponseSchema>;
export type PolicyCoverageQuery = Static<typeof PolicyCoverageQuerySchema>;
export type PolicyCoverageResponse = Static<typeof PolicyCoverageResponseSchema>;
export type BudgetQuery = Static<typeof BudgetQuerySchema>;
export type BudgetResponse = Static<typeof BudgetResponseSchema>;
export type BudgetLine = Static<typeof BudgetLineSchema>;
export type DecisionQuery = Static<typeof DecisionQuerySchema>;
export type DecisionsPage = Static<typeof DecisionsPageSchema>;
export type RecordDecisionInput = Static<typeof RecordDecisionInputSchema>;
export type CreateDecisionRequest = Static<typeof CreateDecisionRequestSchema>;
export type CreateDecisionResponse = Static<typeof CreateDecisionResponseSchema>;
export type IntegrationsQuery = Static<typeof IntegrationsQuerySchema>;
export type IntegrationState = Static<typeof IntegrationStateSchema>;
export type IntegrationsResponse = Static<typeof IntegrationsResponseSchema>;
export type SetIntegrationRequest = Static<typeof SetIntegrationRequestSchema>;
