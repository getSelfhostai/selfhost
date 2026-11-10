import {
  type BudgetLimit,
  budgetMode,
  GatewayError,
  keySettings,
  teamLimits,
} from "@selfhost/gateway";
import type { Ledger, TeamCost } from "@selfhost/ledger";
import {
  AddRepoRequestSchema,
  BUDGET_PERIODS,
  type BudgetLine,
  type BudgetPeriod,
  BudgetQuerySchema,
  type BudgetResponse,
  CreateOrgRequestSchema,
  createValidator,
  type GatewayBudget,
  type LedgerEvent,
  type OrgInfo,
  type OrgOverview,
  OverviewQuerySchema,
  parseConfig,
  parseRemote,
  type ResolvedSelfhostConfig,
  roleAllows,
  type SpendTotals,
  type TeamInfo,
  type TeamOverview,
  type TeamRepo,
  type TeamReposResponse,
} from "@selfhost/schema";
import {
  BUDGET_KEY,
  budgetLine,
  budgetResponse,
  dimensionValue,
  oneSourcePerSession,
  periodRange,
  type SpendDimension,
  sortBudgetLines,
} from "@selfhost/spend";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { apiError, authorize, type Caller, orgOf, type Router } from "./access.js";
import type { Gateway } from "./gateway.js";
import { invalidQuery, limit, readBody, SMALL_BODY_BYTES } from "./http.js";
import { teamId } from "./ids.js";

const createOrgBody = createValidator(CreateOrgRequestSchema);
const addRepoBody = createValidator(AddRepoRequestSchema);
const overviewQuery = createValidator(OverviewQuerySchema);
const budgetQuery = createValidator(BudgetQuerySchema);

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

function emptyTotals(): SpendTotals {
  return { usd: 0, tokens: 0, requests: 0 };
}

function addCost(totals: SpendTotals, event: LedgerEvent): void {
  const cost = event.cost;
  if (!cost) return;
  totals.usd += cost.usd;
  totals.tokens +=
    cost.input_tokens + cost.output_tokens + cost.cache_read_tokens + cost.cache_write_tokens;
  totals.requests += 1;
}

const rounded = (totals: SpendTotals): SpendTotals => ({ ...totals, usd: round(totals.usd) });

function breakdown(events: LedgerEvent[], dimension: SpendDimension) {
  const groups = new Map<string, SpendTotals>();
  for (const event of events) {
    const key = dimensionValue(event, dimension);
    let totals = groups.get(key);
    if (!totals) {
      totals = emptyTotals();
      groups.set(key, totals);
    }
    addCost(totals, event);
  }
  return [...groups]
    .map(([key, totals]) => ({ key, ...rounded(totals) }))
    .sort((a, b) => b.usd - a.usd || a.key.localeCompare(b.key));
}

/** Each session's spend from one source only, as selfhost spend counts it. */
export function costsOf(costs: TeamCost[], team: string): LedgerEvent[] {
  return oneSourcePerSession(costs.filter((c) => c.team === team).map((c) => c.event));
}

export function totalOf(events: LedgerEvent[]): SpendTotals {
  const totals = emptyTotals();
  for (const event of events) addCost(totals, event);
  return rounded(totals);
}

export interface OrgRouteOptions {
  now?: () => Date;
  /** The AI gateway, which holds the hard budgets and counts the spend against them. */
  gateway?: Gateway;
}

/**
 * Repos per team, the per-team overview and budget, and the cross-team overview of an org, for
 * both kinds of token. Spend counts every run assigned to a team: runs in its repos, and runs in
 * no mapped repo written with its people's tokens.
 */
export function orgRoutes(router: Router, ledger: Ledger, options: OrgRouteOptions = {}): void {
  const { teams, orgs } = ledger;
  const now = options.now ?? (() => new Date());
  const { gateway } = options;
  const small = limit(SMALL_BODY_BYTES);

  /** The policy in use for a team; a team with none, or a broken one, has no budget. */
  async function configOf(team: string): Promise<ResolvedSelfhostConfig | undefined> {
    try {
      return (await orgs.effectivePolicy(team))?.config;
    } catch {
      return undefined;
    }
  }

  async function overviews(org: string, list: TeamInfo[], from: Date, to: Date) {
    const ids = list.map((team) => team.id);
    const at = now();
    const month = periodRange("month", at);
    const [costs, monthCosts, people, reviews] = await Promise.all([
      orgs.teamCosts(org, ids, from.toISOString(), to.toISOString()),
      orgs.teamCosts(org, ids, month.from.toISOString(), at.toISOString()),
      orgs.peopleCounts(ids),
      orgs.reviewCounts(ids),
    ]);
    const rows: TeamOverview[] = [];
    for (const team of list) {
      const events = costsOf(costs, team.id);
      const budget = (await configOf(team.id))?.budget?.monthly_usd;
      rows.push({
        team,
        people: people.get(team.id) ?? 0,
        repos: (await orgs.listRepos(team.id)).map((repo) => repo.repo),
        spend: totalOf(events),
        by_person: breakdown(events, "person"),
        by_agent: breakdown(events, "agent"),
        by_model: breakdown(events, "model"),
        budget:
          budget === undefined
            ? null
            : budgetResponse("month", at, totalOf(costsOf(monthCosts, team.id)).usd, budget),
        review: reviews.get(team.id) ?? { open: 0, blocking: 0, unowned: 0 },
      });
    }
    return { rows, monthCosts };
  }

  function range(c: Context): { from: Date; to: Date } | Response {
    const query = overviewQuery.validate(c.req.query());
    if (!query.ok) return invalidQuery(c, query.errors);
    const to = query.value.to ? new Date(query.value.to) : now();
    const from = query.value.from ? new Date(query.value.from) : periodRange("month", to).from;
    if (from >= to)
      return c.json(apiError("invalid_query", "from: Expected a time before to"), 400);
    return { from, to };
  }

  router.on("GET", "/v1/teams/:team/repos", async (c, caller) => {
    const team = c.req.param("team") ?? "";
    const refused = await authorize(c, caller, team, "read");
    if (refused) return refused;
    if (!(await teams.getTeam(team))) return c.json(apiError("not_found", `No team ${team}`), 404);
    return c.json({ team, repos: await orgs.listRepos(team) } satisfies TeamReposResponse);
  });

  router.on(
    "POST",
    "/v1/teams/:team/repos",
    async (c, caller) => {
      const team = c.req.param("team") ?? "";
      const refused = await authorize(c, caller, team, "settings.write");
      if (refused) return refused;
      const body = await readBody(c, addRepoBody);
      if (body instanceof Response) return body;
      const parsed = parseRemote(body.remote);
      if (!parsed) {
        return c.json(
          apiError(
            "invalid_request",
            "remote: Expected a remote URL such as https://github.com/acme/api.git or owner/name",
          ),
          400,
        );
      }
      const added = await orgs.addRepo(team, parsed);
      if (!added) return c.json(apiError("not_found", `No team ${team}`), 404);
      if ("taken" in added) {
        return c.json(
          apiError(
            "repo_taken",
            `${parsed.repo} belongs to team ${added.taken}. A repo belongs to one team; remove it there first.`,
          ),
          409,
        );
      }
      return c.json(added satisfies TeamRepo, 201);
    },
    small,
  );

  router.on("DELETE", "/v1/teams/:team/repos/:owner/:name", async (c, caller) => {
    const team = c.req.param("team") ?? "";
    const refused = await authorize(c, caller, team, "settings.write");
    if (refused) return refused;
    const repo = `${c.req.param("owner")}/${c.req.param("name")}`.toLowerCase();
    if (!(await orgs.removeRepo(team, repo))) {
      return c.json(apiError("not_found", `Team ${team} does not own repo ${repo}`), 404);
    }
    return c.json({ team, repos: await orgs.listRepos(team) } satisfies TeamReposResponse);
  });

  router.on("GET", "/v1/teams/:team/overview", async (c, caller) => {
    const team = c.req.param("team") ?? "";
    const refused = await authorize(c, caller, team, "read");
    if (refused) return refused;
    const window = range(c);
    if (window instanceof Response) return window;
    const info = await teams.getTeam(team);
    if (!info) return c.json(apiError("not_found", `No team ${team}`), 404);
    const { rows } = await overviews(info.org ?? "", [info], window.from, window.to);
    const [overview] = rows;
    if (!overview) throw new Error(`no overview for team ${team}`);
    return c.json(overview satisfies TeamOverview);
  });

  router.on("GET", "/v1/budget", async (c, caller) => {
    const query = budgetQuery.validate(c.req.query());
    if (!query.ok) return invalidQuery(c, query.errors);
    const team = query.value.team ?? (caller.kind === "person" ? caller.person.team : undefined);
    if (team === undefined) {
      return c.json(apiError("invalid_query", "team: Required with the admin token"), 400);
    }
    const refused = await authorize(c, caller, team, "read");
    if (refused) return refused;
    const info = await teams.getTeam(team);
    if (!info) return c.json(apiError("not_found", `No team ${team}`), 404);
    const org = info.org ?? "";
    const period = query.value.period ?? "month";
    const at = now();
    const costs = costsOf(
      await orgs.teamCosts(org, [team], earliestStart(at).toISOString(), at.toISOString()),
      team,
    );
    const { person } = query.value;
    const config = await configOf(team);
    const budget = config?.budget;
    const key = BUDGET_KEY[period];
    const limitUsd = person === undefined ? budget?.[key] : budget?.person?.[key];
    const response = budgetResponse(period, at, spentIn(costs, period, at, person), limitUsd);
    const lines = await budgetLines({
      caller,
      org,
      team,
      config,
      costs,
      at,
      // A person token's own budget applies to it whatever it asks about.
      person: person ?? (caller.kind === "person" ? caller.person.id : undefined),
    });
    if (lines.length > 0) response.budgets = lines;
    return c.json(response satisfies BudgetResponse);
  });

  /**
   * Every budget that applies: the person's [budget.person], the team's [budget] and the org's,
   * in each period that has one. The gateway holds a person's and a team's when [budget] mode is
   * hard; its own count of the spend is used for those when it answers, since that count is what
   * makes it refuse requests. The org's total is shown only to whoever sees every team.
   */
  async function budgetLines(input: {
    caller: Caller;
    org: string;
    team: string;
    config: ResolvedSelfhostConfig | undefined;
    costs: LedgerEvent[];
    at: Date;
    person: string | undefined;
  }): Promise<BudgetLine[]> {
    const { org, team, config, costs, at, person } = input;
    const budget = config?.budget;
    const hard = budgetMode(budget) === "hard" && gateway !== undefined;
    const held = (limits: BudgetLimit[]) =>
      new Set((hard && gateway ? gateway.client.held(limits) : []).map((l) => l.period));
    const personHeld =
      person === undefined
        ? new Set<string>()
        : held(keySettings({ kind: "person", team, person }, config).budgets);
    const teamHeld = held(teamLimits(config));
    const counted = await gatewayCounts(team, person, personHeld.size + teamHeld.size > 0);
    const teamRaise = (field: string) =>
      `An owner or admin of team ${team} can raise it: ${field} in the team's selfhost.toml (selfhost team policy push).`;
    const lines: BudgetLine[] = [];
    for (const period of BUDGET_PERIODS) {
      const key = BUDGET_KEY[period];
      const personLimit = budget?.person?.[key];
      if (person !== undefined && personLimit !== undefined) {
        const gatewaySpent = personHeld.has(period) ? counted.person.get(period) : undefined;
        lines.push(
          budgetLine({
            scope: "person",
            owner: person,
            period,
            now: at,
            limitUsd: personLimit,
            spentUsd: gatewaySpent ?? spentIn(costs, period, at, person),
            enforcement: personHeld.has(period) ? "gateway" : "alert",
            raise: teamRaise(`[budget.person] ${key}`),
          }),
        );
      }
      const teamLimit = budget?.[key];
      if (teamLimit !== undefined) {
        const gatewaySpent = teamHeld.has(period) ? counted.team.get(period) : undefined;
        lines.push(
          budgetLine({
            scope: "team",
            owner: team,
            period,
            now: at,
            limitUsd: teamLimit,
            spentUsd: gatewaySpent ?? spentIn(costs, period, at),
            enforcement: teamHeld.has(period) ? "gateway" : "alert",
            raise: teamRaise(`[budget] ${key}`),
          }),
        );
      }
    }
    lines.push(...(await orgBudgetLines(input.caller, org, at)));
    return sortBudgetLines(lines);
  }

  /** The gateway's own count of the person's key and the team's spend, by period, when it answers. */
  async function gatewayCounts(team: string, person: string | undefined, wanted: boolean) {
    const counts = { person: new Map<string, number>(), team: new Map<string, number>() };
    if (!wanted || !gateway) return counts;
    const fill = (into: Map<string, number>, budgets: GatewayBudget[] | undefined) => {
      for (const b of budgets ?? []) if (b.spent_usd !== null) into.set(b.period, b.spent_usd);
    };
    try {
      const [keys, gatewayTeams] = await Promise.all([
        person === undefined ? Promise.resolve([]) : gateway.client.keys(),
        gateway.client.teams(),
      ]);
      fill(
        counts.person,
        keys.find((k) => k.kind === "person" && k.team === team && k.person === person)?.budgets,
      );
      fill(counts.team, gatewayTeams.find((t) => t.team === team)?.budgets);
    } catch (error) {
      // The ledger's count stands in; the gateway's status says why it did not answer.
      if (!(error instanceof GatewayError)) throw error;
    }
    return counts;
  }

  /** The org's [budget] lines; its spend only for a caller who sees every team of the org. */
  async function orgBudgetLines(caller: Caller, org: string, at: Date): Promise<BudgetLine[]> {
    const policy = org ? await orgs.getOrgPolicy(org) : undefined;
    if (!policy) return [];
    const parsed = parseConfig(policy.text);
    const budget = parsed.ok ? parsed.config.budget : undefined;
    const periods = BUDGET_PERIODS.filter((period) => budget?.[BUDGET_KEY[period]] !== undefined);
    if (periods.length === 0) return [];
    const all = await teams.listTeams(org);
    const sees = (await ledTeams(caller, all)).length === all.length;
    let costs: TeamCost[] = [];
    if (sees) {
      costs = await orgs.teamCosts(
        org,
        all.map((team) => team.id),
        earliestStart(at).toISOString(),
        at.toISOString(),
      );
    }
    const events = all.flatMap((team) => costsOf(costs, team.id));
    return periods.map((period) =>
      budgetLine({
        scope: "org",
        owner: org,
        period,
        now: at,
        limitUsd: budget?.[BUDGET_KEY[period]] ?? 0,
        spentUsd: sees ? spentIn(events, period, at) : null,
        enforcement: "alert",
        raise: `The server's admin can raise it: [budget] ${BUDGET_KEY[period]} in org ${org}'s selfhost.toml.`,
      }),
    );
  }

  router.on("GET", "/v1/orgs/:org/overview", async (c, caller) => {
    const org = c.req.param("org") ?? "";
    const own = await orgOf(caller);
    if (own !== undefined && own !== org) {
      return c.json(apiError("forbidden", `You are not in org ${org}.`), 403);
    }
    const info = await orgs.getOrg(org);
    if (!info) return c.json(apiError("not_found", `No org ${org}`), 404);
    const window = range(c);
    if (window instanceof Response) return window;
    const all = await teams.listTeams(org);
    const led = await ledTeams(caller, all);
    if (led.length === 0) {
      return c.json(
        apiError(
          "forbidden",
          "The cross-team view needs the owner or admin role in at least one team of the org.",
        ),
        403,
      );
    }
    const { rows, monthCosts } = await overviews(org, led, window.from, window.to);
    const total = emptyTotals();
    for (const row of rows) {
      total.usd += row.spend.usd;
      total.tokens += row.spend.tokens;
      total.requests += row.spend.requests;
    }
    // The org's budget is shown only to whoever sees every team, the spend it covers.
    const orgBudget =
      led.length === all.length ? await orgBudgetOf(org, monthCosts, led) : undefined;
    return c.json({
      org: info,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      teams: rows,
      total: rounded(total),
      budget: orgBudget ?? null,
    } satisfies OrgOverview);
  });

  async function orgBudgetOf(org: string, monthCosts: TeamCost[], led: TeamInfo[]) {
    const policy = await orgs.getOrgPolicy(org);
    if (!policy) return undefined;
    const parsed = parseConfig(policy.text);
    const monthly = parsed.ok ? parsed.config.budget?.monthly_usd : undefined;
    if (monthly === undefined) return undefined;
    const spent = led.reduce((sum, team) => sum + totalOf(costsOf(monthCosts, team.id)).usd, 0);
    return budgetResponse("month", now(), spent, monthly);
  }
}

/** The earliest start of this day, week and month: the month holds the rest, but a week may begin before it. */
function earliestStart(at: Date): Date {
  return new Date(
    Math.min(periodRange("week", at).from.getTime(), periodRange("month", at).from.getTime()),
  );
}

/** Spend in the period holding `at`, of one person or of everyone. */
function spentIn(costs: LedgerEvent[], period: BudgetPeriod, at: Date, person?: string): number {
  const start = periodRange(period, at).from.getTime();
  return totalOf(
    costs.filter(
      (event) =>
        Date.parse(event.ts) >= start &&
        (person === undefined || dimensionValue(event, "person") === person),
    ),
  ).usd;
}

/** Teams of the org whose overview the caller sees: all with the admin token, else the ones it leads. */
async function ledTeams(caller: Caller, all: TeamInfo[]): Promise<TeamInfo[]> {
  if (caller.kind === "admin") return all;
  const { memberships } = await caller.scope();
  const leads = new Set(
    memberships.filter((m) => roleAllows(m.role, "org.overview")).map((m) => m.team),
  );
  return all.filter((team) => leads.has(team.id));
}

/** POST /v1/orgs: a new org, for the admin token only. Teams go in it with POST /v1/teams. */
export function createOrgRoute(app: Hono, ledger: Ledger, adminOnly: MiddlewareHandler) {
  app.post("/v1/orgs", adminOnly, limit(SMALL_BODY_BYTES), async (c) => {
    const body = await readBody(c, createOrgBody);
    if (body instanceof Response) return body;
    const name = body.name.trim();
    const id = teamId(name);
    if (!id) {
      return c.json(
        apiError("invalid_request", "name: Expected at least one letter or digit"),
        400,
      );
    }
    const created = await ledger.orgs.createOrg({ id, name });
    if (!created) return c.json(apiError("org_exists", `An org with id ${id} already exists`), 409);
    return c.json(created satisfies OrgInfo, 201);
  });
}
