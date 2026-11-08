import type { Ledger, TeamCost } from "@selfhost/ledger";
import {
  AddRepoRequestSchema,
  type BudgetPeriod,
  BudgetQuerySchema,
  type BudgetResponse,
  CreateOrgRequestSchema,
  createValidator,
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
import { dimensionValue, oneSourcePerSession, type SpendDimension } from "@selfhost/spend";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { apiError, authorize, type Caller, orgOf, type Router } from "./access.js";
import { invalidQuery, limit, readBody, SMALL_BODY_BYTES } from "./http.js";
import { teamId } from "./ids.js";

const createOrgBody = createValidator(CreateOrgRequestSchema);
const addRepoBody = createValidator(AddRepoRequestSchema);
const overviewQuery = createValidator(OverviewQuerySchema);
const budgetQuery = createValidator(BudgetQuerySchema);

const DAY_MS = 86_400_000;
/** A forecast needs this share of the period behind it. */
const FORECAST_MIN_SHARE = 0.1;

/** Start and end (exclusive) of the UTC day, week from Monday, or calendar month holding `now`. */
export function periodRange(period: BudgetPeriod, now: Date): { from: Date; to: Date } {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (period === "day") return { from: new Date(day), to: new Date(day + DAY_MS) };
  if (period === "week") {
    const monday = day - ((now.getUTCDay() + 6) % 7) * DAY_MS;
    return { from: new Date(monday), to: new Date(monday + 7 * DAY_MS) };
  }
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

const BUDGET_KEY = { day: "daily_usd", week: "weekly_usd", month: "monthly_usd" } as const;

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** Spend against a budget in the period holding `now`. No chargeback: this only shows it. */
export function budgetResponse(
  period: BudgetPeriod,
  now: Date,
  spent: number,
  limitUsd: number | undefined,
): BudgetResponse {
  const { from, to } = periodRange(period, now);
  const elapsed = (now.getTime() - from.getTime()) / (to.getTime() - from.getTime());
  const forecast = elapsed >= FORECAST_MIN_SHARE && spent > 0 ? spent / elapsed : null;
  return {
    period,
    from: from.toISOString(),
    to: to.toISOString(),
    spent_usd: round(spent),
    limit_usd: limitUsd ?? null,
    remaining_usd: limitUsd === undefined ? null : round(Math.max(limitUsd - spent, 0)),
    forecast_usd: forecast === null ? null : round(forecast),
  };
}

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
function costsOf(costs: TeamCost[], team: string): LedgerEvent[] {
  return oneSourcePerSession(costs.filter((c) => c.team === team).map((c) => c.event));
}

function totalOf(events: LedgerEvent[]): SpendTotals {
  const totals = emptyTotals();
  for (const event of events) addCost(totals, event);
  return rounded(totals);
}

export interface OrgRouteOptions {
  now?: () => Date;
}

/**
 * Repos per team, the per-team overview and budget, and the cross-team overview of an org, for
 * both kinds of token. Spend counts every run assigned to a team: runs in its repos, and runs in
 * no mapped repo written with its people's tokens.
 */
export function orgRoutes(router: Router, ledger: Ledger, options: OrgRouteOptions = {}): void {
  const { teams, orgs } = ledger;
  const now = options.now ?? (() => new Date());
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
    const period = query.value.period ?? "month";
    const at = now();
    const { from } = periodRange(period, at);
    const costs = await orgs.teamCosts(
      info.org ?? "",
      [team],
      from.toISOString(),
      at.toISOString(),
    );
    const { person } = query.value;
    const events = costsOf(costs, team).filter(
      (event) => person === undefined || dimensionValue(event, "person") === person,
    );
    const budget = person === undefined ? (await configOf(team))?.budget : undefined;
    return c.json(
      budgetResponse(
        period,
        at,
        totalOf(events).usd,
        budget?.[BUDGET_KEY[period]],
      ) satisfies BudgetResponse,
    );
  });

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
