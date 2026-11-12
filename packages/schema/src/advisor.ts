import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, StringEnum } from "./common.js";
import { AGENT_VENDORS } from "./event.js";

/**
 * The weekly agent advisor (F58): what happened with a team's agents in a week and what to change,
 * the body of GET /v1/advisor, of `selfhost advisor --json` and of the Monday note. Every number
 * comes from the ledger events and review items that already exist; nothing is captured for it.
 * The recommendations are picked by fixed rules from those numbers, so the advisor works with no
 * model key.
 */

export const ADVISOR_SCHEMA = "selfhost.advisor/v1";

/** Length of the week the advisor reads, back from to. */
export const ADVISOR_DAYS = 7;

/** Most recommendations a note carries. */
export const ADVISOR_MAX_RECOMMENDATIONS = 3;

/** Days of the week [notify] advisor_day takes. */
export const ADVISOR_DAYS_OF_WEEK = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type AdvisorDayOfWeek = (typeof ADVISOR_DAYS_OF_WEEK)[number];

/** Who gets the weekly note: a team's owners and admins, or also each member about themselves. */
export const ADVISOR_AUDIENCES = ["admins", "everyone", "off"] as const;
export type AdvisorAudience = (typeof ADVISOR_AUDIENCES)[number];

/**
 * What a report covers. team: everything in the teams read, for owners, admins and the admin
 * token. self: only the reader's own sessions, pull requests and spend, for members.
 */
export const ADVISOR_SCOPES = ["team", "self"] as const;
export type AdvisorScope = (typeof ADVISOR_SCOPES)[number];

/** What a recommendation asks for. */
export const ADVISOR_ACTIONS = [
  "review_learned_signal",
  "check_repeated_blocks",
  "enforce_rule",
  "switch_billing",
  "trim_idle_sandboxes",
] as const;
export type AdvisorAction = (typeof ADVISOR_ACTIONS)[number];

const Usd = (description: string) => Type.Number({ minimum: 0, description });
const Count = (description?: string) =>
  Type.Integer({ minimum: 0, ...(description ? { description } : {}) });
const Rate = (description: string) =>
  Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()], { description });
const RunId = Type.Union([Type.String(), Type.Null()], {
  description:
    "A run (agent session or background run) behind the row, for the console's run view and its trace; null when no event named one.",
});

export const AdvisorQuerySchema = Type.Object(
  {
    team: Type.Optional(
      Type.String({
        description:
          "Only this team. Default: every team the caller reads; the admin token reads every team and events with no team.",
      }),
    ),
    to: Type.Optional(
      DateTime({
        description: `End of the week read. Default: now. It starts ${ADVISOR_DAYS} days before.`,
      }),
    ),
  },
  { additionalProperties: false, title: "AdvisorQuery" },
);

export const AdvisorShippedRowSchema = Type.Object(
  {
    person: Type.String({ description: "Whose sessions the pull requests came from, or unknown." }),
    agent: StringEnum(AGENT_VENDORS),
    opened: Count("Agent pull requests opened in the week."),
    merged: Count("Agent pull requests merged in the week."),
  },
  { additionalProperties: false, title: "AdvisorShippedRow" },
);

export const AdvisorRuleRowSchema = Type.Object(
  {
    rule_id: NonEmpty({ description: "The rule or guardrail." }),
    blocked: Count("Calls it blocked."),
    asked: Count("Calls it sent to a person."),
    would_block: Count("Calls it would have blocked while recording only (observe mode)."),
    would_ask: Count("Calls it would have sent to a person while recording only."),
    likely_false_positives: Count("Of the recorded hits, those that look like false positives."),
    top_person: Type.Union([Type.String(), Type.Null()], {
      description: "Whose agents it stopped most, when it stopped anyone's.",
    }),
    top_person_hits: Count("How often it stopped top_person's agents."),
    run: RunId,
  },
  { additionalProperties: false, title: "AdvisorRuleRow" },
);

export const AdvisorSpendRowSchema = Type.Object(
  {
    person: Type.String(),
    agent: Type.String(),
    usd: Usd("Spend in the week, counted as GET /v1/usage counts it."),
    vendor_usd: Usd("Of usd, the part only a vendor admin API reported (daily totals)."),
  },
  { additionalProperties: false, title: "AdvisorSpendRow" },
);

export const AdvisorBillingRowSchema = Type.Object(
  {
    person: Type.String(),
    agent: StringEnum(AGENT_VENDORS),
    verdict: StringEnum(["seat", "api"] as const, {
      description: "What costs less for this use: a subscription seat, or an API key.",
    }),
    tier: Type.Union([Type.String(), Type.Null()], { description: "The seat tier, for seat." }),
    monthly_api_usd: Usd("The week's use at API rates, scaled to 30 days."),
    saving_usd: Usd("What the cheaper option saves a month."),
  },
  { additionalProperties: false, title: "AdvisorBillingRow" },
);

export const AdvisorSignalSchema = Type.Object(
  {
    repo: Type.String(),
    agent: StringEnum(AGENT_VENDORS),
    model: Type.Union([Type.String(), Type.Null()]),
    module: Type.String({ description: "The module whose pull requests keep being reverted." }),
    pulls: Count("Merged pull requests the rate is over."),
    reverted: Count(),
    reworked: Count(),
    rate: Type.Number({ minimum: 0, maximum: 1 }),
    state: StringEnum(["open", "approved", "denied", "cleared"] as const, {
      description:
        "open: its review item waits for a person. approved or denied: answered. cleared: the rate fell back under the threshold.",
    }),
    item_id: Type.Union([Type.String(), Type.Null()], { description: "Its review item." }),
    suggestion: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false, title: "AdvisorSignal" },
);

export const AdvisorRevertSchema = Type.Object(
  {
    kind: StringEnum(["revert", "rework"] as const),
    pr_url: Type.String(),
    repo: Type.Union([Type.String(), Type.Null()]),
    agent: Type.Union([StringEnum(AGENT_VENDORS), Type.Null()]),
    run: RunId,
  },
  { additionalProperties: false, title: "AdvisorRevert" },
);

export const AdvisorWorkSchema = Type.Object(
  {
    person: Type.String(),
    repos: Type.Array(
      Type.Object(
        { repo: Type.String(), sessions: Count("Agent sessions in the repo in the week.") },
        { additionalProperties: false },
      ),
      { description: "Busiest first." },
    ),
  },
  { additionalProperties: false, title: "AdvisorWork" },
);

export const AdvisorOverlapSchema = Type.Object(
  {
    repo: Type.String(),
    file: Type.String(),
    owners: Type.Array(Type.String()),
    times: Count("How many overlap alerts the file raised in the week."),
    run: RunId,
  },
  { additionalProperties: false, title: "AdvisorOverlap" },
);

export const AdvisorRecommendationSchema = Type.Object(
  {
    action: StringEnum(ADVISOR_ACTIONS),
    title: NonEmpty({ description: "What to change, in one line." }),
    why: NonEmpty({ description: "The numbers behind it." }),
    saving_usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()], {
      description: "Estimated saving a month, when the data states one.",
    }),
    screen: StringEnum(["review", "rules", "spend", "runs", "code"] as const, {
      description: "The console screen to act on it in.",
    }),
    item_id: Type.Union([Type.String(), Type.Null()], {
      description: "The review item to answer, when there is one.",
    }),
    run: RunId,
  },
  { additionalProperties: false, title: "AdvisorRecommendation" },
);

export const AdvisorReportSchema = Type.Object(
  {
    schema: Type.Literal(ADVISOR_SCHEMA),
    from: DateTime(),
    to: DateTime(),
    scope: StringEnum(ADVISOR_SCOPES),
    person: Type.Union([Type.String(), Type.Null()], {
      description: "Whose report a self report is; null for a team report.",
    }),
    teams: Type.Union([Type.Array(Type.String()), Type.Null()], {
      description: "Teams read; null for every team and events with no team (the admin token).",
    }),
    shipped: Type.Object(
      {
        opened: Count("Agent pull requests opened."),
        merged: Count("Agent pull requests merged."),
        by: Type.Array(AdvisorShippedRowSchema, { description: "Most merged first." }),
      },
      { additionalProperties: false },
    ),
    blocked: Type.Object(
      {
        blocked: Count(),
        asked: Count(),
        would_block: Count(),
        would_ask: Count(),
        rules: Type.Array(AdvisorRuleRowSchema, { description: "Busiest first, at most 10." }),
        exceptions: Type.Object(
          {
            requested: Count("One-time exceptions agents asked for."),
            approved: Count(),
            denied: Count(),
            used: Count("Signed grants a laptop reported used."),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    spend: Type.Object(
      {
        usd: Usd("Model spend in the week."),
        vendor_usd: Usd("Of usd, the part only a vendor admin API reported."),
        cache_hit_rate: Rate(
          "Cache reads over all prompt input, of sessions that report cache tokens; null when none do.",
        ),
        by: Type.Array(AdvisorSpendRowSchema, { description: "Most first, at most 10." }),
        billing: Type.Array(AdvisorBillingRowSchema, {
          description:
            "Seat or API key per person and agent, as GET /v1/usage/break-even prices it, where the cheaper option saves something.",
        }),
        sandbox: Type.Union(
          [
            Type.Object(
              {
                billed_usd: Usd("Background run sandbox cost in the week."),
                idle_usd: Usd("Of it, paid while no command ran."),
                idle_share: Type.Number({ minimum: 0, maximum: 1 }),
                monthly_saving_usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()], {
                  description: "What a cheaper billing model saves a month, when one is suggested.",
                }),
                suggestion: Type.Union([Type.String(), Type.Null()]),
              },
              { additionalProperties: false },
            ),
            Type.Null(),
          ],
          { description: "null when no background run used a sandbox." },
        ),
      },
      { additionalProperties: false },
    ),
    quality: Type.Object(
      {
        merged: Count("Agent pull requests merged."),
        reverted: Count("Merged agent pull requests found reverted in the week."),
        reworked: Count("Found reworked (lines changed again) in the week."),
        reverts: Type.Array(AdvisorRevertSchema, { description: "At most 10." }),
        signals: Type.Array(AdvisorSignalSchema, {
          description: "Learned risk signals recorded in the week, newest state of each.",
        }),
      },
      { additionalProperties: false },
    ),
    presence: Type.Object(
      {
        work: Type.Array(AdvisorWorkSchema, { description: "Busiest person first, at most 10." }),
        overlaps: Type.Array(AdvisorOverlapSchema, {
          description: "Files two runs edited at once in the week, at most 10.",
        }),
      },
      { additionalProperties: false },
    ),
    recommendations: Type.Array(AdvisorRecommendationSchema, {
      maxItems: ADVISOR_MAX_RECOMMENDATIONS,
      description: `At most ${ADVISOR_MAX_RECOMMENDATIONS}, most pressing first. Picked by fixed rules from the numbers above.`,
    }),
  },
  { additionalProperties: false, title: "AdvisorReport" },
);

export type AdvisorQuery = Static<typeof AdvisorQuerySchema>;
export type AdvisorShippedRow = Static<typeof AdvisorShippedRowSchema>;
export type AdvisorRuleRow = Static<typeof AdvisorRuleRowSchema>;
export type AdvisorSpendRow = Static<typeof AdvisorSpendRowSchema>;
export type AdvisorBillingRow = Static<typeof AdvisorBillingRowSchema>;
export type AdvisorSignal = Static<typeof AdvisorSignalSchema>;
export type AdvisorRevert = Static<typeof AdvisorRevertSchema>;
export type AdvisorWork = Static<typeof AdvisorWorkSchema>;
export type AdvisorOverlap = Static<typeof AdvisorOverlapSchema>;
export type AdvisorRecommendation = Static<typeof AdvisorRecommendationSchema>;
export type AdvisorReport = Static<typeof AdvisorReportSchema>;
