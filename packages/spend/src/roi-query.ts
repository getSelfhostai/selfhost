import {
  DEFAULT_ORG_ID,
  ROI_BASELINE_DAYS,
  ROI_DEFINITION,
  type RoiBaseline,
  type RoiResponse,
} from "@selfhost/schema";
import {
  costPerMergedPr,
  type RoiCost,
  type RoiInput,
  type RoiLink,
  type RoiPullEvent,
  type RoiReport,
} from "./roi.js";
import { countedCostsSql, vendorRollupCountsSql } from "./sources.js";

/**
 * The ROI input from the ledger's tables, and the frozen baseline in roi_baselines. An event's
 * team is the team it was stored with; one stored with no team goes to the team that owns its
 * repo in the org, or its run's repo, as GET /v1/usage reads it.
 */

/** What the readers need of a ledger: `databaseOf(ledger)` from @selfhost/ledger. */
export interface RoiDatabase {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface RoiScope {
  /** Org whose repos assign events to teams. Default: the default org. */
  org?: string;
  /** null for every event of the ledger, as on a laptop. */
  team: string | null;
}

const DAY_MS = 86_400_000;
const FIRST_WEEK = "first_week";

const TS = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const PR = `coalesce(e.body#>>'{links,pr_url}',
  CASE WHEN e.body#>>'{target,type}' = 'pr' THEN e.body#>>'{target,value}' END)`;
/** Events with their repo and team; `org` is the parameter that holds the org. */
const teamed = (org: string) => `events e
  LEFT JOIN run_repos rr ON rr.session_id = e.session_id
  LEFT JOIN team_repos tr
    ON tr.org_id = ${org} AND tr.repo = coalesce(lower(e.body->>'repo'), rr.repo)`;
const REPO = "coalesce(lower(e.body->>'repo'), rr.repo)";
const TEAM = "coalesce(e.team, tr.team_id)";
/** A vendor-reported daily total counts only for a person-day no other source reported. */
const ROLLUP_COUNTS = vendorRollupCountsSql({
  source: "e.source",
  body: "e.body",
  person: "e.actor_id",
  agent: "e.agent",
  ts: "e.ts",
});

type Nullable<T> = { [K in keyof T]: T[K] | null };
const defined = <T extends object>(row: Nullable<T>): T =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as T;

/** Pull requests merged or closed in the range, their joins and the spend they need. */
export async function readRoiInput(
  db: RoiDatabase,
  scope: RoiScope & { from: Date; to: Date },
): Promise<RoiInput> {
  const range = [scope.from.toISOString(), scope.to.toISOString(), scope.org ?? DEFAULT_ORG_ID];
  const pulls = await db.query<Nullable<RoiPullEvent>>(
    `WITH pr_events AS (
       SELECT e.kind, e.ts, ${PR} AS pr, ${REPO} AS repo, ${TEAM} AS team, e.agent,
         CASE WHEN e.agent IS NOT NULL THEN e.model END AS model
       FROM ${teamed("$3")}
       WHERE e.kind IN ('pr.opened', 'pr.merged', 'pr.closed')
     )
     SELECT pr AS url, kind, ${TS("ts")} AS ts, repo, team, agent, model
     FROM pr_events
     WHERE pr IN (
       SELECT pr FROM pr_events
       WHERE kind IN ('pr.merged', 'pr.closed')
         AND ts >= $1::timestamptz AND ts < $2::timestamptz
         AND ($4::text IS NULL OR team = $4::text)
     )`,
    [...range, scope.team],
  );
  const urls = [...new Set(pulls.map((pull) => pull.url))];
  const links = await db.query<RoiLink>(
    `WITH links AS (
       SELECT DISTINCT e.session_id AS session, ${PR} AS pr
       FROM events e
       WHERE e.kind IN ('commit.created', 'pr.opened', 'pr.merged', 'pr.closed')
         AND coalesce(e.session_id, '') <> ''
     ),
     wanted AS (
       SELECT session FROM links
       WHERE pr IN (SELECT jsonb_array_elements_text($1::text::jsonb))
       UNION
       SELECT session_id FROM events
       WHERE kind = 'cost.recorded' AND ts >= $2::timestamptz AND ts < $3::timestamptz
     )
     SELECT session, pr FROM links
     WHERE pr IS NOT NULL AND session IN (SELECT session FROM wanted)`,
    [JSON.stringify(urls), range[0], range[1]],
  );
  const wanted = new Set(urls);
  const joined = [...new Set(links.filter((l) => wanted.has(l.pr)).map((l) => l.session))];
  // A gateway request counts once, under its agent-side copy's session (rule 1 in sources.ts);
  // costPerMergedPr applies rule 2 to the rows.
  const costs = await db.query<Nullable<RoiCost>>(
    `WITH cost_rows AS (
       SELECT e.id, e.ts, e.source, e.session_id, e.agent, e.model, e.body,
         ${REPO} AS repo, ${TEAM} AS team
       FROM ${teamed("$3")}
       WHERE e.kind = 'cost.recorded' AND ${ROLLUP_COUNTS}
         AND ((e.ts >= $1::timestamptz AND e.ts < $2::timestamptz)
           OR e.session_id IN (SELECT jsonb_array_elements_text($4::text::jsonb)))
     ),
     ${countedCostsSql("cost_rows", "roi")}
     SELECT counted_session AS session, agent, model, source,
       coalesce(repo, lower(counted_repo)) AS repo, team, paired,
       (ts >= $1::timestamptz AND ts < $2::timestamptz) AS in_window,
       sum((body#>>'{cost,usd}')::numeric)::float8 AS usd
     FROM roi_counted
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`,
    [...range, JSON.stringify(joined)],
  );
  return {
    team: scope.team,
    from: scope.from,
    to: scope.to,
    pulls: pulls.map(defined),
    links,
    costs: costs.map((row) => ({ ...defined(row), usd: Number(row.usd ?? 0) })),
  };
}

/** Time of the scope's first cost or pull request event, or undefined with none. */
export async function firstActivity(db: RoiDatabase, scope: RoiScope): Promise<Date | undefined> {
  const [row] = await db.query<{ first: string | null }>(
    `SELECT ${TS("min(e.ts)")} AS first
     FROM ${teamed("$1")}
     WHERE e.kind IN ('cost.recorded', 'pr.opened', 'pr.merged', 'pr.closed')
       AND ($2::text IS NULL OR ${TEAM} = $2::text)`,
    [scope.org ?? DEFAULT_ORG_ID, scope.team],
  );
  return row?.first ? new Date(row.first) : undefined;
}

interface BaselineRow {
  from_ts: string;
  to_ts: string;
  definition: string;
  computed_at: string;
  body: RoiReport | string;
}

export interface BaselineOptions extends RoiScope {
  now: Date;
  /** The period [roi] sets; default: the first 7 UTC days of data. */
  period?: { from: Date; to: Date };
}

/**
 * The frozen baseline: read from roi_baselines, else computed and stored once its period has
 * ended. null while the period runs, or with no data to start the first week from.
 */
export async function roiBaseline(
  db: RoiDatabase,
  options: BaselineOptions,
): Promise<RoiBaseline | null> {
  const team = options.team ?? "";
  const key = options.period
    ? `${options.period.from.toISOString()}/${options.period.to.toISOString()}`
    : FIRST_WEEK;
  const read = async () => {
    const [row] = await db.query<BaselineRow>(
      `SELECT ${TS("from_ts")} AS from_ts, ${TS("to_ts")} AS to_ts, definition,
         ${TS("computed_at")} AS computed_at, body
       FROM roi_baselines WHERE team = $1 AND period = $2`,
      [team, key],
    );
    return row;
  };
  let row = await read();
  if (!row) {
    let period = options.period;
    if (!period) {
      const first = await firstActivity(db, options);
      if (!first) return null;
      const from = new Date(Math.floor(first.getTime() / DAY_MS) * DAY_MS);
      period = { from, to: new Date(from.getTime() + ROI_BASELINE_DAYS * DAY_MS) };
    }
    if (period.to > options.now) return null;
    const report = costPerMergedPr(await readRoiInput(db, { ...options, ...period }));
    await db.query(
      `INSERT INTO roi_baselines (team, period, from_ts, to_ts, definition, computed_at, body)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6::timestamptz, $7::text::jsonb)
       ON CONFLICT (team, period) DO NOTHING`,
      [
        team,
        key,
        period.from.toISOString(),
        period.to.toISOString(),
        ROI_DEFINITION,
        options.now.toISOString(),
        JSON.stringify(report),
      ],
    );
    row = await read();
    if (!row) throw new Error(`roi_baselines: no row for ${team}/${key} after writing it`);
  }
  const body: RoiReport = typeof row.body === "string" ? JSON.parse(row.body) : row.body;
  return {
    from: row.from_ts,
    to: row.to_ts,
    merged_prs: body.merged_prs,
    cost_usd: body.cost_usd,
    cost_per_merged_pr: body.cost_per_merged_pr,
    human_prs: body.human_prs,
    period: key === FIRST_WEEK ? "first_week" : "configured",
    definition: row.definition,
    computed_at: row.computed_at,
  };
}

/** The report for a range with its baseline, as GET /v1/teams/{team}/roi answers. */
export async function roiReport(
  db: RoiDatabase,
  options: BaselineOptions & { from: Date; to: Date },
): Promise<RoiResponse> {
  const { by_agent, ...report } = costPerMergedPr(await readRoiInput(db, options));
  return { ...report, baseline: await roiBaseline(db, options), by_agent };
}
