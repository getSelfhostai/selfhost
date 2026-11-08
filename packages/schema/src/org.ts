import { type Static, Type } from "@sinclair/typebox";
import { BudgetResponseSchema } from "./api.js";
import { DateTime, NonEmpty, RepoSlug } from "./common.js";
import { SelfhostConfigSchema } from "./config.js";
import { TEAM_ID_PATTERN, TeamInfoSchema } from "./team.js";

/**
 * Orgs, the repos each team owns, and the per-team and cross-team overviews: the bodies of
 * /v1/orgs, /v1/teams/{team}/repos and the overview routes.
 */

/** The org every team belongs to until it is created in another one. */
export const DEFAULT_ORG_ID = "default";

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * A repo from its remote URL (https://github.com/acme/api.git, git@github.com:acme/api.git,
 * ssh://git@host:22/acme/api) or owner/name: repo is owner/name in lower case, the last two
 * path parts, as events carry it; remote is host/owner/name. undefined when it is neither.
 */
export function parseRemote(input: string): { repo: string; remote: string } | undefined {
  const value = input.trim();
  let host = "";
  let path = value;
  const scp = /^[^/@\s]+@([^:/\s]+):(.+)$/.exec(value);
  if (scp) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    host = url.hostname;
    path = url.pathname;
  }
  const parts = path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter((part) => part !== "");
  const owner = parts.at(-2);
  const name = parts.at(-1);
  if (!owner || !name || !SEGMENT.test(owner) || !SEGMENT.test(name)) return undefined;
  if (!host && parts.length !== 2) return undefined;
  const repo = `${owner}/${name}`.toLowerCase();
  const remote = (host ? `${host}/${parts.join("/")}` : repo).toLowerCase();
  return { repo, remote };
}

const OrgId = (description: string) => Type.String({ pattern: TEAM_ID_PATTERN, description });
const TeamId = (description: string) => Type.String({ pattern: TEAM_ID_PATTERN, description });

export const OrgInfoSchema = Type.Object(
  {
    id: OrgId("Org id, derived from the name."),
    name: NonEmpty({ description: "Org name as given." }),
    created_at: DateTime(),
  },
  { additionalProperties: false, title: "OrgInfo" },
);

export const CreateOrgRequestSchema = Type.Object(
  {
    name: NonEmpty({ maxLength: 100, description: "Org name. Its id is the name in kebab case." }),
  },
  { additionalProperties: false, title: "CreateOrgRequest" },
);

export const TeamRepoSchema = Type.Object(
  {
    repo: RepoSlug({
      description:
        "owner/name in lower case: what events carry as repo, and how runs are assigned to the team.",
    }),
    remote: NonEmpty({ description: "The remote as host/owner/name, without scheme or user." }),
    team: TeamId("Team that owns the repo. Every run in it is the team's."),
    org: OrgId("Org of the team. A repo belongs to one team per org."),
    has_policy: Type.Boolean({ description: "true when the repo has rules of its own." }),
    created_at: DateTime(),
  },
  { additionalProperties: false, title: "TeamRepo" },
);

export const AddRepoRequestSchema = Type.Object(
  {
    remote: NonEmpty({
      maxLength: 500,
      description:
        "The repo's remote URL (https://github.com/acme/api.git, git@github.com:acme/api.git) or owner/name.",
    }),
  },
  { additionalProperties: false, title: "AddRepoRequest" },
);

export const TeamReposResponseSchema = Type.Object(
  {
    team: TeamId("Team id."),
    repos: Type.Array(TeamRepoSchema, { description: "By repo." }),
  },
  { additionalProperties: false, title: "TeamReposResponse" },
);

export const FloorConflictSchema = Type.Object(
  {
    team: TeamId("Team whose rules relax the org floor."),
    repo: Type.Optional(RepoSlug({ description: "The repo, for a repo's own rules." })),
    field: Type.String({ description: "Field path in that team's or repo's selfhost.toml." }),
    message: Type.String(),
    org_rule: Type.String({ description: "The org rule or setting it relaxes." }),
  },
  { additionalProperties: false, title: "FloorConflict" },
);

export const OrgPolicyResponseSchema = Type.Object(
  {
    org: OrgId("Org id."),
    hash: Type.String({ description: "sha256 of the org's selfhost.toml." }),
    text: Type.String({ description: "The org's selfhost.toml: the floor every team builds on." }),
    loaded_at: DateTime(),
    config: SelfhostConfigSchema,
    conflicts: Type.Array(FloorConflictSchema, {
      description:
        "Stored team and repo rules that relax this floor. The org's value applies to them until they are changed.",
    }),
  },
  { additionalProperties: false, title: "OrgPolicyResponse" },
);

export const OverviewQuerySchema = Type.Object(
  {
    from: Type.Optional(
      DateTime({ description: "Spend at or after this time. Default: month start." }),
    ),
    to: Type.Optional(DateTime({ description: "Spend before this time. Default: now." })),
  },
  { additionalProperties: false, title: "OverviewQuery" },
);

const Usd = Type.Number({ minimum: 0 });
const Count = Type.Integer({ minimum: 0 });

export const SpendTotalsSchema = Type.Object(
  {
    usd: Usd,
    tokens: Count,
    requests: Type.Integer({ minimum: 0, description: "cost.recorded events, one per request." }),
  },
  { additionalProperties: false, title: "SpendTotals" },
);

const SpendShare = Type.Object(
  {
    key: Type.String({ description: "The person, agent or model; unknown when not recorded." }),
    usd: Usd,
    tokens: Count,
    requests: Count,
  },
  { additionalProperties: false },
);

const Breakdown = (what: string) =>
  Type.Array(SpendShare, { description: `Spend by ${what}, highest first.` });

export const TeamOverviewSchema = Type.Object(
  {
    team: TeamInfoSchema,
    people: Type.Integer({ minimum: 0, description: "People in the team." }),
    repos: Type.Array(RepoSlug(), { description: "Repos the team owns." }),
    spend: SpendTotalsSchema,
    by_person: Breakdown("person"),
    by_agent: Breakdown("agent"),
    by_model: Breakdown("model"),
    budget: Type.Union([BudgetResponseSchema, Type.Null()], {
      description:
        "This month against [budget] monthly_usd of the team's selfhost.toml, or null when it sets none.",
    }),
    review: Type.Object(
      {
        open: Count,
        blocking: Type.Integer({ minimum: 0, description: "Open items an agent waits on." }),
        unowned: Type.Integer({
          minimum: 0,
          description: "Open items routing gave nobody: the team's policy names no owner for them.",
        }),
      },
      { additionalProperties: false, description: "The team's review list now." },
    ),
  },
  {
    additionalProperties: false,
    title: "TeamOverview",
    description:
      "One team's dashboard. Spend counts every run assigned to the team: runs in the team's repos, and runs in no mapped repo written by its people.",
  },
);

export const OrgOverviewSchema = Type.Object(
  {
    org: OrgInfoSchema,
    from: DateTime(),
    to: DateTime(),
    teams: Type.Array(TeamOverviewSchema, {
      description:
        "Every team the caller leads (owner or admin), or every team with the admin token, by team id.",
    }),
    total: SpendTotalsSchema,
    budget: Type.Union([BudgetResponseSchema, Type.Null()], {
      description: "This month across the org against the org policy's [budget], or null.",
    }),
  },
  {
    additionalProperties: false,
    title: "OrgOverview",
    description: "The cross-team view for the lead. Budgets are shown, nothing is charged back.",
  },
);

export type OrgInfo = Static<typeof OrgInfoSchema>;
export type CreateOrgRequest = Static<typeof CreateOrgRequestSchema>;
export type TeamRepo = Static<typeof TeamRepoSchema>;
export type AddRepoRequest = Static<typeof AddRepoRequestSchema>;
export type TeamReposResponse = Static<typeof TeamReposResponseSchema>;
export type FloorConflict = Static<typeof FloorConflictSchema>;
export type OrgPolicyResponse = Static<typeof OrgPolicyResponseSchema>;
export type OverviewQuery = Static<typeof OverviewQuerySchema>;
export type SpendTotals = Static<typeof SpendTotalsSchema>;
export type TeamOverview = Static<typeof TeamOverviewSchema>;
export type OrgOverview = Static<typeof OrgOverviewSchema>;
