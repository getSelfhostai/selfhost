import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, RepoSlug, StringEnum } from "./common.js";
import { AGENT_VENDORS } from "./event.js";
import { TEAM_ID_PATTERN } from "./team.js";

/**
 * Agent-written code share and revert rate: the body of `selfhost provenance --json`, the
 * provenance section of `selfhost scan --json` and the /v1/teams/{team}/provenance routes.
 * Every number comes from git and the ledger; vendor stats only add a column next to them.
 */

export const PROVENANCE_SCHEMA = "selfhost.provenance/v1";

/** Who wrote a line: an agent vendor, or unattributed when no signal names one. */
export const PROVENANCE_AUTHORS = [...AGENT_VENDORS, "unattributed"] as const;

export type ProvenanceAuthor = (typeof PROVENANCE_AUTHORS)[number];

const Count = (description?: string) =>
  Type.Integer({ minimum: 0, ...(description ? { description } : {}) });

const MaybeCount = (description: string) =>
  Type.Union([Count(), Type.Null()], {
    description: `${description} null when only the ledger was read.`,
  });

const Share = (description: string) => Type.Number({ minimum: 0, maximum: 1, description });

const Rate = (description: string) =>
  Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()], {
    description: `${description} null with no lines to measure, or when only the ledger was read.`,
  });

const Vendor = StringEnum(PROVENANCE_AUTHORS, {
  description: "Agent vendor, or unattributed when no signal names one.",
});

const Model = Type.Union([Type.String(), Type.Null()], {
  description: "Model id, or null when not known.",
});

const RevertFields = {
  reverted_lines: MaybeCount(
    "Lines taken out within the window by a revert: a commit that says it reverts the change, or one that removes every line of it that was left and adds back no more than a tenth as many.",
  ),
  reworked_lines: MaybeCount(
    "Lines changed or deleted within the window by any other later commit. Fix-forward edits count here.",
  ),
  open_lines: MaybeCount("Lines merged less than the window ago, so their count can still grow."),
  revert_rate: Rate("reverted_lines over lines."),
  rework_rate: Rate("reworked_lines over lines."),
  revert_rework_rate: Rate(
    "reverted_lines plus reworked_lines over lines: the rate [review] revert_rate_threshold is checked against.",
  ),
};

export const ProvenanceAgentRowSchema = Type.Object(
  {
    vendor: Vendor,
    model: Model,
    lines: Count(
      "Non-blank lines this agent and model wrote that landed on the main branch in the window.",
    ),
    share: Share("lines over every line that landed."),
    landings: Count("Merged pull requests and direct commits that brought at least one line."),
    runs: Count("Agent sessions in the ledger behind the lines."),
    ...RevertFields,
  },
  { additionalProperties: false, title: "ProvenanceAgentRow" },
);

const AgentLines = Type.Object(
  {
    vendor: Vendor,
    model: Model,
    lines: Count(),
  },
  { additionalProperties: false },
);

export const ProvenancePersonRowSchema = Type.Object(
  {
    person: NonEmpty({
      description:
        "Git author email for lines read from git, or the GitHub login or person id the ledger records for a merged pull request.",
    }),
    lines: Count("Lines that landed under this person's name."),
    agent_lines: Count("Those an agent wrote."),
    agent_share: Share("agent_lines over lines."),
    by_agent: Type.Array(AgentLines, { description: "Lines by agent and model, most first." }),
  },
  { additionalProperties: false, title: "ProvenancePersonRow" },
);

const moduleFields = {
  module: NonEmpty({
    description:
      "A [review] modules name, else the file's top folder (module_depth deep), or (root).",
  }),
  lines: Count("Lines that landed in the module."),
  agent_lines: Count("Those an agent wrote."),
  agent_share: Share("agent_lines over lines."),
  agent_reverted_lines: MaybeCount("Agent-written lines reverted within the window."),
  agent_reworked_lines: MaybeCount("Agent-written lines reworked within the window."),
  agent_revert_rework_rate: Rate(
    "agent_reverted_lines plus agent_reworked_lines over agent_lines.",
  ),
  above_threshold: Type.Boolean({
    description:
      "true when agent_revert_rework_rate is above [review] revert_rate_threshold with at least min_module_lines agent lines. New pull requests that touch the module score higher risk.",
  }),
  by_agent: Type.Array(
    Type.Object(
      {
        vendor: Vendor,
        model: Model,
        lines: Count(),
        revert_rework_rate: Rate("Reverted plus reworked over lines, for this agent here."),
      },
      { additionalProperties: false },
    ),
    { description: "Lines by agent and model, most first." },
  ),
};

export const ProvenanceModuleRowSchema = Type.Object(
  {
    ...moduleFields,
    rank: Type.Integer({ minimum: 1, description: "1 holds the most agent-written lines." }),
  },
  { additionalProperties: false, title: "ProvenanceModuleRow" },
);

export const VendorReportedRowSchema = Type.Object(
  {
    vendor: StringEnum(AGENT_VENDORS),
    lines_added: Count("What the vendor says its agent added in the window."),
    lines_removed: Count(),
  },
  { additionalProperties: false, title: "VendorReportedRow" },
);

export const ProvenanceReportSchema = Type.Object(
  {
    schema: Type.Literal(PROVENANCE_SCHEMA),
    repo: Type.Union([Type.String(), Type.Null()], {
      description: "owner/name, else the folder name.",
    }),
    status: StringEnum(["computed", "ledger_only"] as const, {
      description:
        "computed: line by line from git and the ledger. ledger_only: no clone to read, so lines come from the ledger's merged pull requests, with no modules and no revert or rework rate.",
    }),
    note: Type.Union([Type.String(), Type.Null()], {
      description: "Why the report is ledger_only, or what it could not read.",
    }),
    from: DateTime({ description: "Merges at or after this time." }),
    to: DateTime({ description: "Merges before this time." }),
    branch: Type.Union([Type.String(), Type.Null()], {
      description: "The main branch read, such as origin/main.",
    }),
    head: Type.Union([Type.String(), Type.Null()], { description: "Its commit." }),
    window_days: Type.Integer({ minimum: 1, description: "[review] revert_window_days." }),
    threshold: Share("[review] revert_rate_threshold."),
    min_module_lines: Count("Agent lines a module needs before its rate can flag it."),
    totals: Type.Object(
      {
        lines: Count(),
        agent_lines: Count(),
        agent_share: Share("agent_lines over lines."),
        landings: Count(),
        agent_reverted_lines: MaybeCount("Agent-written lines reverted."),
        agent_reworked_lines: MaybeCount("Agent-written lines reworked."),
        agent_revert_rework_rate: Rate("Reverted plus reworked over agent_lines."),
      },
      { additionalProperties: false },
    ),
    by_agent: Type.Array(ProvenanceAgentRowSchema, {
      description: "By vendor, then model, unattributed last.",
    }),
    by_person: Type.Array(ProvenancePersonRowSchema, { description: "Most lines first." }),
    modules: Type.Array(ProvenanceModuleRowSchema, {
      description: "Ranked by agent-written lines, most first.",
    }),
    vendor_reported: Type.Array(VendorReportedRowSchema, {
      description:
        "Lines the vendors' own stats report for the window, when they were given. Shown next to the git numbers, never used in their place.",
    }),
  },
  {
    additionalProperties: false,
    title: "ProvenanceReport",
    description:
      "Lines of merged code by agent, model, person and module, and how much of it was reverted or reworked within the window after merge.",
  },
);

/** One vendor-reported line count, from Cursor AI Code Tracking or Claude Code Analytics. */
export const VendorLineStatSchema = Type.Object(
  {
    vendor: StringEnum(AGENT_VENDORS),
    commit: Type.Optional(
      Type.String({
        pattern: "^[0-9a-fA-F]{7,40}$",
        description: "The commit the lines are in, when the vendor reports per commit.",
      }),
    ),
    day: Type.Optional(
      Type.String({
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "The UTC day, when the vendor reports per day.",
      }),
    ),
    person: Type.Optional(NonEmpty({ description: "Email of the person the vendor counts." })),
    model: Type.Optional(NonEmpty()),
    lines_added: Count("Lines the vendor says its agent added."),
    lines_removed: Type.Optional(Count()),
  },
  { additionalProperties: false, title: "VendorLineStat" },
);

export const VendorLineStatsSchema = Type.Object(
  {
    stats: Type.Array(VendorLineStatSchema),
  },
  { additionalProperties: false, title: "VendorLineStats" },
);

export const ProvenanceQuerySchema = Type.Object(
  {
    from: Type.Optional(
      DateTime({ description: "Merges at or after this time. Default: 30 days before to." }),
    ),
    to: Type.Optional(DateTime({ description: "Merges before this time. Default: now." })),
    repo: Type.Optional(RepoSlug({ description: "Only this repo of the team, as owner/name." })),
  },
  { additionalProperties: false, title: "ProvenanceQuery" },
);

const TeamId = Type.String({ pattern: TEAM_ID_PATTERN, description: "Team id." });

export const TeamProvenanceSchema = Type.Object(
  {
    team: TeamId,
    from: DateTime(),
    to: DateTime(),
    repos: Type.Array(ProvenanceReportSchema, { description: "One report per repo, by repo." }),
  },
  { additionalProperties: false, title: "TeamProvenance" },
);

export const TeamProvenanceModulesSchema = Type.Object(
  {
    team: TeamId,
    from: DateTime(),
    to: DateTime(),
    threshold: Share("[review] revert_rate_threshold of the team's policy."),
    modules: Type.Array(
      Type.Object(
        {
          repo: Type.String({ description: "owner/name." }),
          ...moduleFields,
          rank: Type.Integer({
            minimum: 1,
            description: "Across every repo of the team; 1 holds the most agent-written lines.",
          }),
        },
        { additionalProperties: false },
      ),
      {
        description:
          "Every module of the team's computed repos, ranked by agent-written lines. Ledger-only repos have none.",
      },
    ),
  },
  { additionalProperties: false, title: "TeamProvenanceModules" },
);

export type ProvenanceAgentRow = Static<typeof ProvenanceAgentRowSchema>;
export type ProvenancePersonRow = Static<typeof ProvenancePersonRowSchema>;
export type ProvenanceModuleRow = Static<typeof ProvenanceModuleRowSchema>;
export type VendorReportedRow = Static<typeof VendorReportedRowSchema>;
export type ProvenanceReport = Static<typeof ProvenanceReportSchema>;
export type VendorLineStat = Static<typeof VendorLineStatSchema>;
export type VendorLineStats = Static<typeof VendorLineStatsSchema>;
export type ProvenanceQuery = Static<typeof ProvenanceQuerySchema>;
export type TeamProvenance = Static<typeof TeamProvenanceSchema>;
export type TeamProvenanceModules = Static<typeof TeamProvenanceModulesSchema>;
