import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, StringEnum } from "./common.js";
import { BUDGET_MODES, ROUTER_TOOLS } from "./config.js";

/**
 * The AI gateway as the selfhost server sees it: GET /v1/gateway, the virtual keys it issued and
 * the budgets it set. The gateway (Bifrost or LiteLLM) holds the provider keys and enforces the
 * budgets; selfhost writes its settings and reads its usage into the ledger.
 */

export const GATEWAY_KEY_KINDS = ["person", "team", "run"] as const;
export type GatewayKeyKind = (typeof GATEWAY_KEY_KINDS)[number];

/** day, week and month as in [budget]; run for the whole life of a run's key. */
export const GATEWAY_BUDGET_PERIODS = ["day", "week", "month", "run"] as const;
export type GatewayBudgetPeriod = (typeof GATEWAY_BUDGET_PERIODS)[number];

export const GatewayBudgetSchema = Type.Object(
  {
    period: StringEnum(GATEWAY_BUDGET_PERIODS),
    limit_usd: Type.Number({ minimum: 0 }),
    spent_usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()], {
      description: "Spend the gateway counted in the current period, or null when it reports none.",
    }),
  },
  { additionalProperties: false, title: "GatewayBudget" },
);

export const GatewayKeySchema = Type.Object(
  {
    id: NonEmpty({ description: "The gateway's id for the key. Never the key itself." }),
    name: NonEmpty({ description: "selfhost:<kind>:<team>[:<person or run>]." }),
    kind: StringEnum(GATEWAY_KEY_KINDS),
    team: NonEmpty({ description: "Team the key's spend counts against." }),
    person: Type.Optional(Type.String({ description: "Owner of a person key." })),
    run_id: Type.Optional(Type.String({ description: "Run of a run key." })),
    active: Type.Boolean({ description: "false once its person left the team or it was revoked." }),
    budgets: Type.Array(GatewayBudgetSchema, {
      description: "Hard limits the gateway enforces on this key. Empty with [budget] mode alert.",
    }),
  },
  { additionalProperties: false, title: "GatewayKey" },
);

export const GatewaySyncReportSchema = Type.Object(
  {
    at: DateTime(),
    teams: Type.Integer({ minimum: 0 }),
    created: Type.Integer({ minimum: 0, description: "Gateway teams created." }),
    updated: Type.Integer({ minimum: 0, description: "Teams and keys whose settings changed." }),
    unchanged: Type.Integer({ minimum: 0 }),
    deactivated: Type.Integer({
      minimum: 0,
      description: "Keys turned off: their person left the team.",
    }),
    alerts: Type.Integer({ minimum: 0, description: "New budget-spent alerts written." }),
    errors: Type.Array(Type.String(), { description: "What failed, without secrets." }),
  },
  { additionalProperties: false, title: "GatewaySyncReport" },
);

export const GatewayUsageReportSchema = Type.Object(
  {
    at: DateTime(),
    from: DateTime({ description: "Start of the window read from the gateway's request logs." }),
    events: Type.Integer({ minimum: 0, description: "New ledger events written." }),
    duplicates: Type.Integer({ minimum: 0, description: "Requests already in the ledger." }),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false, title: "GatewayUsageReport" },
);

const Nullable = <T extends ReturnType<typeof Type.Object>>(schema: T) =>
  Type.Union([schema, Type.Null()]);

export const GatewayStatusSchema = Type.Object(
  {
    tool: Type.Union([StringEnum(ROUTER_TOOLS), Type.Null()], {
      description: "The gateway in use, or null when none is configured.",
    }),
    base_url: Type.Union([Type.String(), Type.Null()], {
      description:
        "Where agents send model traffic. Claude Code: <base_url>/anthropic on Bifrost; Codex and OpenAI SDKs: <base_url>/openai/v1 on Bifrost, <base_url>/v1 on LiteLLM.",
    }),
    healthy: Type.Boolean(),
    detail: Type.Optional(Type.String({ description: "Why the gateway is not healthy." })),
    team: NonEmpty(),
    mode: StringEnum(BUDGET_MODES, { description: "[budget] mode of the team." }),
    team_budgets: Type.Array(GatewayBudgetSchema, {
      description: "The team's hard limits on the gateway, with what it counted so far.",
    }),
    key: Type.Union([GatewayKeySchema, Type.Null()], {
      description: "The caller's own person key, or null when they have none yet.",
    }),
    last_sync: Nullable(GatewaySyncReportSchema),
    last_usage: Nullable(GatewayUsageReportSchema),
    notes: Type.Array(Type.String(), {
      description:
        "What the gateway cannot do here, such as stopping subscription logins, which never pass through it.",
    }),
  },
  { additionalProperties: false, title: "GatewayStatus" },
);

export const GatewayKeysResponseSchema = Type.Object(
  {
    team: NonEmpty(),
    keys: Type.Array(GatewayKeySchema, { description: "The team's keys. Never their values." }),
  },
  { additionalProperties: false, title: "GatewayKeysResponse" },
);

export const IssueGatewayKeyRequestSchema = Type.Object(
  {
    kind: Type.Optional(
      StringEnum(GATEWAY_KEY_KINDS, {
        default: "person",
        description:
          "person: the caller's own key (person tokens only). team: a shared key for the team (owner or admin). run: a key for one background run, which expires after 24 hours.",
      }),
    ),
    team: Type.Optional(
      Type.String({
        description: "Team id. Needed with the admin token; a person token uses its own team.",
      }),
    ),
    run_id: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, description: "The run, for kind run." }),
    ),
    rotate: Type.Optional(
      Type.Boolean({
        description:
          "Replace an existing person or team key with a new value. Without it, asking again for one that exists answers 409.",
      }),
    ),
  },
  { additionalProperties: false, title: "IssueGatewayKeyRequest" },
);

export const IssueGatewayKeyResponseSchema = Type.Object(
  {
    key: GatewayKeySchema,
    value: NonEmpty({
      description:
        "The virtual key. Shown once, to whoever asked for it; selfhost keeps no copy. It is not a provider key: those stay on the gateway.",
    }),
    base_url: Type.String({ description: "Where agents send model traffic with it." }),
    tool: StringEnum(ROUTER_TOOLS),
  },
  { additionalProperties: false, title: "IssueGatewayKeyResponse" },
);

export type GatewayBudget = Static<typeof GatewayBudgetSchema>;
export type GatewayKey = Static<typeof GatewayKeySchema>;
export type GatewaySyncReport = Static<typeof GatewaySyncReportSchema>;
export type GatewayUsageReport = Static<typeof GatewayUsageReportSchema>;
export type GatewayStatus = Static<typeof GatewayStatusSchema>;
export type GatewayKeysResponse = Static<typeof GatewayKeysResponseSchema>;
export type IssueGatewayKeyRequest = Static<typeof IssueGatewayKeyRequestSchema>;
export type IssueGatewayKeyResponse = Static<typeof IssueGatewayKeyResponseSchema>;
