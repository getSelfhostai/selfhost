import { type Static, Type } from "@sinclair/typebox";
import { DateTime, StringEnum } from "./common.js";
import { TEAM_ID_PATTERN } from "./team.js";

/**
 * Usage, cost and outcomes: the bodies of /v1/usage and /v1/usage.csv. One query over the
 * ledger's events, whatever source wrote them (OpenTelemetry, local logs, hooks, the gateway,
 * vendor admin data, GitHub), grouped and filtered by team, person, agent, model and day.
 */

/** What usage rows group by. day is the UTC day of the event. */
export const USAGE_DIMENSIONS = ["team", "person", "agent", "model", "day"] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

/** Rows group by at most this many dimensions at once, such as day,team for a chart. */
export const USAGE_MAX_GROUP_BY = 2;

/** The value a row and a filter use when the event has none (no team, not a person, ...). */
export const USAGE_UNKNOWN = "unknown";

/** Default length of the date range, back from to. */
export const USAGE_DEFAULT_DAYS = 30;

/** The metrics of every row and of the total, in the order the CSV lists them. */
export const USAGE_METRICS = [
  "usd",
  "tokens",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "requests",
  "sessions",
  "prs_opened",
  "prs_merged",
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

const DIMENSION_LIST = `(?:${USAGE_DIMENSIONS.join("|")})`;

const Filter = (description: string) =>
  Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 256,
      description: `${description} ${USAGE_UNKNOWN} matches events with none.`,
    }),
  );

export const UsageQuerySchema = Type.Object(
  {
    group_by: Type.Optional(
      Type.String({
        pattern: `^${DIMENSION_LIST}(?:,${DIMENSION_LIST})?$`,
        description:
          "One or two of team, person, agent, model and day, comma separated, such as person or day,model. Without it, rows holds one row with the total.",
      }),
    ),
    from: Type.Optional(
      DateTime({
        description: `Events at or after this time. Default: ${USAGE_DEFAULT_DAYS} days before to.`,
      }),
    ),
    to: Type.Optional(DateTime({ description: "Events before this time. Default: now." })),
    team: Filter("Only this team: the team that owns the run's repo, else the team that wrote it."),
    person: Filter("Only this person (actor.id of a person)."),
    agent: Filter("Only this agent (agent.vendor), such as claude_code or codex."),
    model: Filter("Only this model, as the vendor reports it."),
    org: Type.Optional(
      Type.String({
        pattern: TEAM_ID_PATTERN,
        description:
          "Org whose repos assign runs to teams. Default: the person token's org, or default with the admin token.",
      }),
    ),
  },
  { additionalProperties: false, title: "UsageQuery" },
);

const Count = (description: string) => Type.Integer({ minimum: 0, description });

const METRIC_FIELDS = {
  usd: Type.Number({
    minimum: 0,
    description: "Cost in US dollars of the cost.recorded events, rounded to 6 decimals.",
  }),
  tokens: Count("The four token counts added up."),
  input_tokens: Count("Uncached input tokens."),
  output_tokens: Count("Output tokens, including reasoning tokens."),
  cache_read_tokens: Count("Input tokens read from the prompt cache."),
  cache_write_tokens: Count("Input tokens written to the prompt cache."),
  requests: Count("cost.recorded events, one per model request."),
  sessions: Count(
    "Distinct agent sessions (agent and session_id) with a session, prompt or cost event in the range.",
  ),
  prs_opened: Count("Distinct pull requests with a pr.opened event in the range."),
  prs_merged: Count("Distinct pull requests with a pr.merged event in the range."),
};

export const UsageTotalsSchema = Type.Object(METRIC_FIELDS, {
  additionalProperties: false,
  title: "UsageTotals",
});

export const UsageGroupSchema = Type.Object(
  {
    team: Type.Optional(Type.String({ description: `Team id, or ${USAGE_UNKNOWN} for none.` })),
    person: Type.Optional(
      Type.String({ description: `actor.id when the actor is a person, else ${USAGE_UNKNOWN}.` }),
    ),
    agent: Type.Optional(Type.String({ description: `agent.vendor, or ${USAGE_UNKNOWN}.` })),
    model: Type.Optional(Type.String({ description: `Model id, or ${USAGE_UNKNOWN}.` })),
    day: Type.Optional(
      Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "UTC day, YYYY-MM-DD." }),
    ),
  },
  {
    additionalProperties: false,
    title: "UsageGroup",
    description: "The value of each grouped dimension.",
  },
);

export const UsageRowSchema = Type.Object(
  { group: UsageGroupSchema, ...METRIC_FIELDS },
  { additionalProperties: false, title: "UsageRow" },
);

export const UsageResponseSchema = Type.Object(
  {
    org: Type.String({ description: "Org whose repos assigned runs to teams." }),
    from: DateTime(),
    to: DateTime(),
    group_by: Type.Array(StringEnum(USAGE_DIMENSIONS), { description: "As asked, in order." }),
    filters: Type.Object(
      {
        team: Type.Optional(Type.String()),
        person: Type.Optional(Type.String()),
        agent: Type.Optional(Type.String()),
        model: Type.Optional(Type.String()),
      },
      { additionalProperties: false, description: "The filters applied to every row." },
    ),
    teams: Type.Union([Type.Array(Type.String()), Type.Null()], {
      description:
        "Teams the caller sees: every team of the org they are in with a person token, or null with the admin token, which also sees events with no team.",
    }),
    rows: Type.Array(UsageRowSchema, {
      description:
        "One per group with any usage: by day (oldest first) when grouped by day, then by usd (highest first), then by group. A session is distinct, so it counts once in every group its events fall in and the rows can add up to more sessions than the total.",
    }),
    total: UsageTotalsSchema,
  },
  {
    additionalProperties: false,
    title: "UsageResponse",
    description:
      "Tokens, cost, sessions and pull requests from the ledger alone. A session reported by more than one source counts its spend from one: otel, then local_log, hook, gateway, vendor_api.",
  },
);

export type UsageQuery = Static<typeof UsageQuerySchema>;
export type UsageTotals = Static<typeof UsageTotalsSchema>;
export type UsageGroup = Static<typeof UsageGroupSchema>;
export type UsageRow = Static<typeof UsageRowSchema>;
export type UsageResponse = Static<typeof UsageResponseSchema>;

/** The group_by query value as a list: "day,team" is ["day", "team"]. */
export function parseGroupBy(value: string | undefined): UsageDimension[] {
  if (!value) return [];
  return [...new Set(value.split(","))].filter((part): part is UsageDimension =>
    (USAGE_DIMENSIONS as readonly string[]).includes(part),
  );
}
