import { type Static, Type } from "@sinclair/typebox";
import { DateTime, StringEnum } from "./common.js";

/**
 * Cost per merged pull request, before and after: the body of GET /v1/teams/{team}/roi and of
 * `selfhost roi --json`. Read ROI_RULES for what counts; every number comes from the ledger.
 */

export const ROI_SCHEMA = "selfhost.roi/v1";

/**
 * The metric definition a value was computed with. A frozen baseline keeps the definition it
 * was computed with, so a reader can tell when the two no longer compare.
 */
export const ROI_DEFINITION = "cost_per_merged_agent_pr/v1";

/** Default length of the range, back from to: one week. */
export const ROI_DEFAULT_DAYS = 7;

/** Length of the default baseline: the first days of data. */
export const ROI_BASELINE_DAYS = 7;

/** How the baseline period was picked: the first week of data, or [roi] in selfhost.toml. */
export const ROI_BASELINE_PERIODS = ["first_week", "configured"] as const;
export type RoiBaselinePeriod = (typeof ROI_BASELINE_PERIODS)[number];

/** The value an agent or model takes when no event names one. */
export const ROI_UNKNOWN = "unknown";

/** The definition, in words: what counts as a merged PR, its cost and the shared spend. */
export const ROI_RULES = [
  "Merged PRs: distinct pull requests with a pr.merged event in the range. Agent PRs have a joined agent session or an agent named on the pull request; the rest are human PRs and cost nothing.",
  "A session joins a pull request through a commit.created or pr.* event that carries both; a session joined to several splits its spend equally.",
  "Spend is cost.recorded, one source per session (otel, local_log, hook, gateway, vendor_api). A joined session's spend counts whenever it was spent.",
  "Agent spend in the range joined to no pull request, and the spend of pull requests closed unmerged in the range, is split equally across the merged agent PRs of the same repo; with no repo, across all of them. With none to take it, it is unallocated and left out of cost.",
  "cost per merged PR = (attributed + shared) / merged agent PRs; none when no agent PR merged.",
] as const;

const Usd = (description: string) => Type.Number({ minimum: 0, description });
const Count = (description: string) => Type.Integer({ minimum: 0, description });
const PerPr = Type.Union([Type.Number({ minimum: 0 }), Type.Null()], {
  description: "cost_usd / merged_prs, rounded to 6 decimals; null when merged_prs is 0.",
});

export const RoiQuerySchema = Type.Object(
  {
    from: Type.Optional(
      DateTime({
        description: `Merges at or after this time. Default: ${ROI_DEFAULT_DAYS} days before to.`,
      }),
    ),
    to: Type.Optional(DateTime({ description: "Merges before this time. Default: now." })),
  },
  { additionalProperties: false, title: "RoiQuery" },
);

export const RoiAgentRowSchema = Type.Object(
  {
    agent: Type.String({
      description: `agent.vendor named on the pull request, else of the joined sessions with the most spend, else ${ROI_UNKNOWN}.`,
    }),
    model: Type.String({
      description: `Model named on the pull request, else of the joined spend with the most cost, else ${ROI_UNKNOWN}.`,
    }),
    merged_prs: Count("Merged agent PRs of this agent and model."),
    cost_usd: Usd("Their attributed and shared spend."),
    cost_per_merged_pr: PerPr,
  },
  { additionalProperties: false, title: "RoiAgentRow" },
);

export const RoiBaselineSchema = Type.Object(
  {
    from: DateTime(),
    to: DateTime(),
    merged_prs: Count("Merged agent PRs in the baseline period."),
    cost_usd: Usd("Their cost, by the same definition."),
    cost_per_merged_pr: PerPr,
    human_prs: Count("Merged human PRs in the baseline period."),
    period: StringEnum(ROI_BASELINE_PERIODS, {
      description:
        "first_week: the first 7 UTC days from the day of the team's first cost or pull request event. configured: [roi] baseline_from and baseline_to.",
    }),
    definition: Type.String({ description: "The definition the numbers were computed with." }),
    computed_at: DateTime({
      description: "When the numbers were computed and frozen. Later data never changes them.",
    }),
  },
  {
    additionalProperties: false,
    title: "RoiBaseline",
    description: "Computed once, the first time it is read after its period ended, then frozen.",
  },
);

export const RoiResponseSchema = Type.Object(
  {
    schema: Type.Literal(ROI_SCHEMA),
    definition: Type.Literal(ROI_DEFINITION),
    team: Type.Union([Type.String(), Type.Null()], {
      description: "Team id; null for the whole ledger of a laptop.",
    }),
    from: DateTime(),
    to: DateTime(),
    merged_prs: Count("Merged agent PRs in the range."),
    cost_usd: Usd("attributed_usd + shared_usd, rounded to 6 decimals."),
    cost_per_merged_pr: PerPr,
    human_prs: Count("Merged PRs with no joined agent session and no agent named: no cost."),
    closed_prs: Count("Agent PRs closed without merging in the range."),
    attributed_usd: Usd("Spend of the sessions joined to the merged agent PRs."),
    shared_usd: Usd("The part of unattributed_usd and closed_usd split across them."),
    unattributed_usd: Usd("Agent spend in the range of sessions joined to no pull request."),
    closed_usd: Usd("Spend of the sessions joined to pull requests closed unmerged in the range."),
    unallocated_usd: Usd(
      "unattributed_usd and closed_usd in repos with no merged agent PR in the range: left out of cost_usd.",
    ),
    baseline: Type.Union([RoiBaselineSchema, Type.Null()], {
      description: "null until the baseline period has ended, or when there is no data yet.",
    }),
    by_agent: Type.Array(RoiAgentRowSchema, {
      description: "Merged agent PRs by agent and model, highest cost_usd first.",
    }),
  },
  {
    additionalProperties: false,
    title: "RoiResponse",
    description: `What each merged pull request cost. ${ROI_RULES.join(" ")}`,
  },
);

export type RoiQuery = Static<typeof RoiQuerySchema>;
export type RoiAgentRow = Static<typeof RoiAgentRowSchema>;
export type RoiBaseline = Static<typeof RoiBaselineSchema>;
export type RoiResponse = Static<typeof RoiResponseSchema>;
