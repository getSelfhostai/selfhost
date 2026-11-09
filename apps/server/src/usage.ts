import { databaseOf, type Ledger } from "@selfhost/ledger";
import {
  createValidator,
  DEFAULT_ORG_ID,
  parseGroupBy,
  USAGE_DEFAULT_DAYS,
  USAGE_METRICS,
  USAGE_UNKNOWN,
  type UsageDimension,
  UsageQuerySchema,
  type UsageResponse,
  type UsageRow,
} from "@selfhost/schema";
import type { Context } from "hono";
import { apiError, authorize, type Caller, type Router } from "./access.js";
import { invalidQuery } from "./http.js";
import { queryUsage, type UsageFilters, type UsageScope } from "./usage-query.js";

const usageQuery = createValidator(UsageQuerySchema);

const DAY_MS = 86_400_000;

export interface UsageRouteOptions {
  now?: () => Date;
}

interface ResolvedQuery {
  org: string;
  from: Date;
  to: Date;
  groupBy: UsageDimension[];
  filters: UsageFilters;
  scope: UsageScope;
  teams: string[] | null;
}

/**
 * GET /v1/usage and /v1/usage.csv, for both kinds of token: tokens, cost, sessions and pull
 * requests grouped by team, person, agent, model or day, with the same filters on every row.
 * The admin token sees every team of the org and events with no team; a person token sees the
 * teams of its org it is in, as GET /v1/teams/{team}/overview does.
 */
export function usageRoutes(router: Router, ledger: Ledger, options: UsageRouteOptions = {}) {
  const now = options.now ?? (() => new Date());

  async function resolve(c: Context, caller: Caller): Promise<ResolvedQuery | Response> {
    const checked = usageQuery.validate(c.req.query());
    if (!checked.ok) return invalidQuery(c, checked.errors);
    const query = checked.value;
    const to = query.to ? new Date(query.to) : now();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - USAGE_DEFAULT_DAYS * DAY_MS);
    if (from >= to)
      return c.json(apiError("invalid_query", "from: Expected a time before to"), 400);
    const filters: UsageFilters = {
      ...(query.team !== undefined ? { team: query.team } : {}),
      ...(query.person !== undefined ? { person: query.person } : {}),
      ...(query.agent !== undefined ? { agent: query.agent } : {}),
      ...(query.model !== undefined ? { model: query.model } : {}),
    };
    const base = { from, to, groupBy: parseGroupBy(query.group_by), filters };

    if (caller.kind === "admin") {
      const org = query.org ?? DEFAULT_ORG_ID;
      if (!(await ledger.orgs.getOrg(org))) {
        return c.json(apiError("not_found", `No org ${org}`), 404);
      }
      return { ...base, org, scope: { kind: "org" }, teams: null };
    }
    const { org, memberships } = await caller.scope();
    if (query.org !== undefined && query.org !== org) {
      return c.json(apiError("forbidden", `You are not in org ${query.org}.`), 403);
    }
    if (query.team !== undefined && query.team !== USAGE_UNKNOWN) {
      const refused = await authorize(c, caller, query.team, "read");
      if (refused) return refused;
    }
    const teams = memberships.map((m) => m.team);
    return { ...base, org, scope: { kind: "teams", teams }, teams };
  }

  async function usage(query: ResolvedQuery) {
    return queryUsage(databaseOf(ledger), {
      org: query.org,
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      groupBy: query.groupBy,
      filters: query.filters,
      scope: query.scope,
    });
  }

  router.on("GET", "/v1/usage", async (c, caller) => {
    const query = await resolve(c, caller);
    if (query instanceof Response) return query;
    const { rows, total } = await usage(query);
    return c.json({
      org: query.org,
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      group_by: query.groupBy,
      filters: query.filters,
      teams: query.teams,
      rows,
      total,
    } satisfies UsageResponse);
  });

  router.on("GET", "/v1/usage.csv", async (c, caller) => {
    const query = await resolve(c, caller);
    if (query instanceof Response) return query;
    const { rows } = await usage(query);
    const day = (date: Date) => date.toISOString().slice(0, 10);
    const name = `selfhost-usage-${day(query.from)}-to-${day(query.to)}.csv`;
    return c.body(usageCsv(query.groupBy, rows), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
    });
  });
}

/** A spreadsheet runs text that starts with one of these as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvField(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The rows as CSV: the grouped dimensions, then every metric, with a header line. */
export function usageCsv(groupBy: UsageDimension[], rows: UsageRow[]): string {
  const lines = [[...groupBy, ...USAGE_METRICS].join(",")];
  for (const row of rows) {
    lines.push(
      [
        ...groupBy.map((dimension) => csvField(row.group[dimension] ?? "")),
        ...USAGE_METRICS.map((metric) => csvField(row[metric])),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
