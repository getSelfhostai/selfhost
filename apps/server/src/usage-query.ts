import type { Queryable } from "@selfhost/ledger";
import {
  USAGE_UNKNOWN,
  type UsageDimension,
  type UsageGroup,
  type UsageRow,
  type UsageTotals,
} from "@selfhost/schema";
import { countedCostsSql, sourceRankSql } from "@selfhost/spend";

/**
 * Usage, cost and outcomes in SQL over the ledger's events table. Nothing here knows which source
 * wrote an event: OpenTelemetry, local logs, hooks, the gateway and vendor admin data all land as
 * the same event kinds, so one query reads them all.
 *
 * - Spend: cost.recorded events, counted as `selfhost spend` and the team overview count them
 *   (oneSourcePerSession in @selfhost/spend): a request that went through the model gateway once,
 *   as the gateway's event (countedCostsSql), then for the rest one source per session (agent
 *   vendor and session_id), in the order of COST_SOURCE_PREFERENCE.
 * - Sessions: distinct sessions with a session, prompt or cost event in the range.
 * - Pull requests: distinct pull request URLs of pr.opened and pr.merged events in the range.
 * - Cache hit rate: cache reads over cache reads, uncached input and cache writes of the cost
 *   events of sessions that reported any cache read or write in the range; a session that
 *   reported none is unknown and left out, as cacheStats in @selfhost/spend does.
 *
 * An event's team is the team it was stored with: the writer's team, or the repo's team when the
 * writer is in it (OrgStore.assignTeams). Repo ownership read now only labels an event stored with
 * no team (written with the admin token), with the team that owns its repo, or its run's repo, in
 * this org. It never moves spend from the team that wrote it to another team or org.
 */

export interface UsageFilters {
  team?: string;
  person?: string;
  agent?: string;
  model?: string;
}

/** Which events the caller may see: every team of the org and events with no team, or these teams. */
export type UsageScope = { kind: "org" } | { kind: "teams"; teams: string[] };

export interface UsageQueryInput {
  org: string;
  from: string;
  to: string;
  groupBy: UsageDimension[];
  filters: UsageFilters;
  scope: UsageScope;
}

const SESSION_KINDS = ["session.started", "session.ended", "prompt.submitted", "cost.recorded"];
const PR_KINDS = ["pr.opened", "pr.merged"];

/** Column of the scoped events for each dimension, and the raw column that may be null. */
const DIMENSION_SQL: Record<UsageDimension, { value: string; raw?: string }> = {
  team: { value: "team", raw: "team_id" },
  person: { value: "person", raw: "person_id" },
  agent: { value: "agent", raw: "vendor" },
  model: { value: "model", raw: "model_id" },
  day: { value: "day" },
};

const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
const list = (values: readonly string[]) => values.map(literal).join(", ");

const SOURCE_RANK = sourceRankSql();

const METRIC_COLUMNS = `
  coalesce(c.usd, 0)::float8 AS usd,
  coalesce(c.input_tokens, 0)::float8 AS input_tokens,
  coalesce(c.output_tokens, 0)::float8 AS output_tokens,
  coalesce(c.cache_read_tokens, 0)::float8 AS cache_read_tokens,
  coalesce(c.cache_write_tokens, 0)::float8 AS cache_write_tokens,
  c.cache_hit_read::float8 AS cache_hit_read,
  c.cache_hit_fresh::float8 AS cache_hit_fresh,
  coalesce(c.requests, 0)::int AS requests,
  coalesce(s.sessions, 0)::int AS sessions,
  coalesce(p.prs_opened, 0)::int AS prs_opened,
  coalesce(p.prs_merged, 0)::int AS prs_merged`;

/** The SQL and parameters for one usage query: one row per group, or one row without groups. */
export function usageSql(input: UsageQueryInput): { text: string; params: unknown[] } {
  const params: unknown[] = [input.from, input.to, input.org];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const scope =
    input.scope.kind === "org"
      ? "(team_id IS NULL OR team_id IN (SELECT id FROM teams WHERE org_id = $3))"
      : `team_id IN (SELECT jsonb_array_elements_text(${param(JSON.stringify(input.scope.teams))}::text::jsonb))`;
  const teamFilter =
    input.filters.team === undefined
      ? ""
      : ` AND coalesce(team_id, ${literal(USAGE_UNKNOWN)}) = ${param(input.filters.team)}`;
  const dimensionFilters = (["person", "agent", "model"] as const)
    .flatMap((name) => {
      const value = input.filters[name];
      return value === undefined ? [] : [`${name} = ${param(value)}`];
    })
    .join(" AND ");
  const where = (extra: string) =>
    [extra, dimensionFilters].filter((part) => part !== "").join(" AND ") || "true";

  const dims = input.groupBy.map((dimension) => DIMENSION_SQL[dimension].value);
  const select = dims.join(", ");
  const groupBy = dims.length > 0 ? `GROUP BY ${select}` : "";
  const leading = dims.length > 0 ? `${select}, ` : "";
  // A session counts in a group its events fall in. An event that carries no team, person, agent
  // or model (hook events name no model) does not put the session in that dimension's unknown
  // group when its other events name one. This is judged on all of the session's events in the
  // range, before the person, agent and model filters.
  const NULLABLE = Object.values(DIMENSION_SQL).flatMap((sql) => (sql.raw ? [sql.raw] : []));
  const sessionHas = NULLABLE.map(
    (raw) => `, bool_or(${raw} IS NOT NULL) OVER (PARTITION BY session_key) AS has_${raw}`,
  ).join("");
  const sessionKeep = NULLABLE.map((raw) => `(${raw} IS NOT NULL OR NOT has_${raw})`).join(" AND ");

  const join =
    dims.length > 0
      ? `FROM cost_agg c FULL JOIN session_agg s USING (${select}) FULL JOIN pr_agg p USING (${select})`
      : "FROM cost_agg c CROSS JOIN session_agg s CROSS JOIN pr_agg p";

  const text = `
WITH base AS (
  SELECT e.id, e.ts, e.source, e.kind, e.session_id, e.body,
    coalesce(e.team, tr.team_id) AS team_id,
    e.agent AS vendor,
    CASE WHEN e.actor_kind = 'person' THEN e.actor_id END AS person_id,
    e.model AS model_id
  FROM events e
  LEFT JOIN run_repos rr ON rr.session_id = e.session_id
  LEFT JOIN team_repos tr
    ON tr.org_id = $3 AND tr.repo = coalesce(lower(e.body->>'repo'), rr.repo)
  WHERE e.kind IN (${list([...new Set([...SESSION_KINDS, ...PR_KINDS])])})
    AND e.ts >= $1::timestamptz AND e.ts < $2::timestamptz
),
scoped AS (
  SELECT *,
    coalesce(team_id, ${literal(USAGE_UNKNOWN)}) AS team,
    coalesce(person_id, ${literal(USAGE_UNKNOWN)}) AS person,
    coalesce(vendor, ${literal(USAGE_UNKNOWN)}) AS agent,
    coalesce(model_id, ${literal(USAGE_UNKNOWN)}) AS model,
    to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
    coalesce(vendor, '') || chr(10) || session_id AS session_key
  FROM base
  WHERE ${scope}${teamFilter}
),
cost_rows AS (
  SELECT * FROM scoped WHERE kind = 'cost.recorded'
),
${countedCostsSql("cost_rows", "usage")},
costs AS (
  SELECT *, bool_or(
      coalesce((body#>>'{cost,cache_read_tokens}')::numeric, 0) > 0
      OR coalesce((body#>>'{cost,cache_write_tokens}')::numeric, 0) > 0
    ) OVER (
      PARTITION BY CASE WHEN coalesce(counted_session, '') = '' THEN id::text
        ELSE coalesce(vendor, '') || chr(10) || counted_session END
    ) AS cache_known
  FROM (
    SELECT *, first_value(source) OVER (
      PARTITION BY session_key ORDER BY paired, ${SOURCE_RANK}, source
    ) AS chosen_source
    FROM usage_counted
  ) ranked
  WHERE (coalesce(session_id, '') = '' OR paired OR source = chosen_source)
),
cost_agg AS (
  SELECT ${leading}
    round(sum((body#>>'{cost,usd}')::numeric), 6) AS usd,
    sum((body#>>'{cost,input_tokens}')::numeric) AS input_tokens,
    sum((body#>>'{cost,output_tokens}')::numeric) AS output_tokens,
    sum((body#>>'{cost,cache_read_tokens}')::numeric) AS cache_read_tokens,
    sum((body#>>'{cost,cache_write_tokens}')::numeric) AS cache_write_tokens,
    sum((body#>>'{cost,cache_read_tokens}')::numeric) FILTER (WHERE cache_known) AS cache_hit_read,
    sum((body#>>'{cost,input_tokens}')::numeric + (body#>>'{cost,cache_write_tokens}')::numeric)
      FILTER (WHERE cache_known) AS cache_hit_fresh,
    count(*) AS requests
  FROM costs WHERE ${where("")} ${groupBy}
),
session_events AS (
  SELECT *${sessionHas}
  FROM scoped
  WHERE kind IN (${list(SESSION_KINDS)}) AND coalesce(session_id, '') <> ''
),
session_agg AS (
  SELECT ${leading} count(DISTINCT session_key) AS sessions
  FROM session_events WHERE ${where(sessionKeep)} ${groupBy}
),
pr_agg AS (
  SELECT ${leading}
    count(DISTINCT pr) FILTER (WHERE kind = 'pr.opened') AS prs_opened,
    count(DISTINCT pr) FILTER (WHERE kind = 'pr.merged') AS prs_merged
  FROM (
    SELECT *, coalesce(body#>>'{links,pr_url}', body#>>'{target,value}', id::text) AS pr
    FROM scoped WHERE kind IN (${list(PR_KINDS)})
  ) prs
  WHERE ${where("")} ${groupBy}
)
SELECT ${leading}${METRIC_COLUMNS}
${join}`;
  return { text, params };
}

interface MetricRow {
  usd: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_tokens: number | string;
  cache_write_tokens: number | string;
  cache_hit_read: number | string | null;
  cache_hit_fresh: number | string | null;
  requests: number | string;
  sessions: number | string;
  prs_opened: number | string;
  prs_merged: number | string;
  [dimension: string]: unknown;
}

function totalsOf(row: MetricRow | undefined): UsageTotals {
  const n = (value: number | string | undefined) => Number(value ?? 0);
  const input = n(row?.input_tokens);
  const output = n(row?.output_tokens);
  const read = n(row?.cache_read_tokens);
  const write = n(row?.cache_write_tokens);
  const hitRead = n(row?.cache_hit_read ?? 0);
  const hitAll = hitRead + n(row?.cache_hit_fresh ?? 0);
  return {
    usd: n(row?.usd),
    tokens: input + output + read + write,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: read,
    cache_write_tokens: write,
    cache_hit_rate: hitAll > 0 ? Math.round((hitRead / hitAll) * 1e6) / 1e6 : null,
    requests: n(row?.requests),
    sessions: n(row?.sessions),
    prs_opened: n(row?.prs_opened),
    prs_merged: n(row?.prs_merged),
  };
}

const isEmpty = (totals: UsageTotals) =>
  Object.values(totals).every((value) => value === 0 || value === null);

/** Day oldest first when grouped by day, then usd highest first, then by group values. */
function compareRows(groupBy: UsageDimension[]) {
  const text = (a: string | undefined, b: string | undefined) =>
    (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;
  return (a: UsageRow, b: UsageRow) => {
    if (groupBy.includes("day")) {
      const byDay = text(a.group.day, b.group.day);
      if (byDay !== 0) return byDay;
    }
    if (a.usd !== b.usd) return b.usd - a.usd;
    for (const dimension of groupBy) {
      const order = text(a.group[dimension], b.group[dimension]);
      if (order !== 0) return order;
    }
    return 0;
  };
}

/** The rows of a usage query and its total, with the same filters. */
export async function queryUsage(
  db: Queryable,
  input: UsageQueryInput,
): Promise<{ rows: UsageRow[]; total: UsageTotals }> {
  const totalSql = usageSql({ ...input, groupBy: [] });
  const [totalRow] = await db.query<MetricRow>(totalSql.text, totalSql.params);
  const total = totalsOf(totalRow);
  if (input.groupBy.length === 0) {
    return { rows: isEmpty(total) ? [] : [{ group: {}, ...total }], total };
  }
  const grouped = usageSql(input);
  const rows = (await db.query<MetricRow>(grouped.text, grouped.params)).map((row) => {
    const group: UsageGroup = {};
    for (const dimension of input.groupBy) group[dimension] = String(row[dimension]);
    return { group, ...totalsOf(row) };
  });
  return { rows: rows.sort(compareRows(input.groupBy)), total };
}
