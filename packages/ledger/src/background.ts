import { randomUUID } from "node:crypto";
import {
  type BackgroundRun,
  type BackgroundRunState,
  FINAL_RUN_STATES,
  type KillScope,
} from "@selfhost/schema";
import type { Database } from "./db.js";

/** A kill switch in force, or one that was cleared. */
export interface KillSwitch {
  scope: KillScope;
  target: string;
  by: string;
  at: string;
  reason?: string;
  cleared_by?: string;
  cleared_at?: string;
}

export interface BackgroundRunFilter {
  /** Runs of these teams; all teams when absent. */
  teams?: readonly string[];
  /** Only these states. */
  states?: readonly BackgroundRunState[];
  limit?: number;
}

/** Background runs and the team and org kill switches (see migrations/0012_background_runs.sql). */
export interface BackgroundRunStore {
  /** Stores a new run. false when the id is taken. */
  create(run: BackgroundRun): Promise<boolean>;
  get(id: string): Promise<BackgroundRun | undefined>;
  /**
   * Writes the run as it is now. A cancel recorded since the caller read the run is kept, so a
   * cancel from the API is never lost to the run's own next write.
   */
  save(run: BackgroundRun): Promise<BackgroundRun>;
  /** Records who stopped the run, once: false when it was already stopped or is final. */
  requestCancel(id: string, cancel: NonNullable<BackgroundRun["cancel"]>): Promise<boolean>;
  /** Newest first. */
  list(filter?: BackgroundRunFilter): Promise<BackgroundRun[]>;
  /** Runs of a team created at or after `since`, for the hourly rate limit. */
  countSince(team: string, since: Date): Promise<number>;
  /** Runs of a team not yet in a final state. */
  countActive(team: string): Promise<number>;
  /** Turns a switch on. false when it already was. */
  kill(switchOn: Omit<KillSwitch, "cleared_by" | "cleared_at">): Promise<boolean>;
  /** Turns a switch off. false when it was not on. */
  clearKill(scope: KillScope, target: string, by: string, at: Date): Promise<boolean>;
  /** Switches in force over these teams and orgs. */
  activeKills(scope: {
    teams?: readonly string[];
    orgs?: readonly string[];
  }): Promise<KillSwitch[]>;
}

interface RunRow {
  body: unknown;
}

interface KillRow {
  scope: KillScope;
  target: string;
  killed_by: string;
  reason: string | null;
  killed_at: unknown;
  cleared_by: string | null;
  cleared_at: unknown;
}

const iso = (value: unknown) => new Date(value as string | Date).toISOString();

const parse = (row: RunRow): BackgroundRun =>
  (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as BackgroundRun;

const killOf = (row: KillRow): KillSwitch => ({
  scope: row.scope,
  target: row.target,
  by: row.killed_by,
  at: iso(row.killed_at),
  ...(row.reason ? { reason: row.reason } : {}),
  ...(row.cleared_by ? { cleared_by: row.cleared_by } : {}),
  ...(row.cleared_at ? { cleared_at: iso(row.cleared_at) } : {}),
});

const FINAL = FINAL_RUN_STATES.map((state) => `'${state}'`).join(", ");

export function createBackgroundRunStore(db: Database): BackgroundRunStore {
  const columns = (run: BackgroundRun) => [
    run.id,
    run.team,
    run.org ?? null,
    run.repo,
    run.state,
    run.person,
    run.created_at,
    run.updated_at,
    JSON.stringify(run),
  ];
  return {
    async create(run) {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO background_runs (id, team, org, repo, state, person, created_at, updated_at, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        columns(run),
      );
      return rows.length === 1;
    },
    async get(id) {
      const [row] = await db.query<RunRow>("SELECT body FROM background_runs WHERE id = $1", [id]);
      return row ? parse(row) : undefined;
    },
    async save(run) {
      const [row] = await db.query<RunRow>(
        `UPDATE background_runs SET team = $2, org = $3, repo = $4, state = $5, person = $6,
           created_at = $7, updated_at = $8,
           body = CASE
             WHEN $9::text::jsonb -> 'cancel' = 'null'::jsonb
               AND background_runs.body -> 'cancel' IS NOT NULL
               AND background_runs.body -> 'cancel' <> 'null'::jsonb
             THEN jsonb_set($9::text::jsonb, '{cancel}', background_runs.body -> 'cancel')
             ELSE $9::text::jsonb
           END
         WHERE id = $1 RETURNING body`,
        columns(run),
      );
      if (!row) throw new Error(`No background run ${run.id}`);
      return parse(row);
    },
    async requestCancel(id, cancel) {
      const rows = await db.query<{ id: string }>(
        `UPDATE background_runs SET body = jsonb_set(body, '{cancel}', $2::text::jsonb)
         WHERE id = $1 AND state NOT IN (${FINAL})
           AND (body -> 'cancel' IS NULL OR body -> 'cancel' = 'null'::jsonb)
         RETURNING id`,
        [id, JSON.stringify(cancel)],
      );
      return rows.length === 1;
    },
    async list({ teams, states, limit = 50 } = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (teams) {
        params.push([...teams]);
        where.push(`team = ANY($${params.length}::text[])`);
      }
      if (states) {
        params.push([...states]);
        where.push(`state = ANY($${params.length}::text[])`);
      }
      params.push(Math.min(Math.max(limit, 1), 500));
      const rows = await db.query<RunRow>(
        `SELECT body FROM background_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(parse);
    },
    async countSince(team, since) {
      const [row] = await db.query<{ n: number | string }>(
        "SELECT count(*) AS n FROM background_runs WHERE team = $1 AND created_at >= $2",
        [team, since.toISOString()],
      );
      return Number(row?.n ?? 0);
    },
    async countActive(team) {
      const [row] = await db.query<{ n: number | string }>(
        `SELECT count(*) AS n FROM background_runs WHERE team = $1 AND state NOT IN (${FINAL})`,
        [team],
      );
      return Number(row?.n ?? 0);
    },
    async kill({ scope, target, by, at, reason }) {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO background_kills (id, scope, target, killed_by, reason, killed_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (scope, target) WHERE cleared_at IS NULL DO NOTHING RETURNING id`,
        [randomUUID(), scope, target, by, reason ?? null, at],
      );
      return rows.length === 1;
    },
    async clearKill(scope, target, by, at) {
      const rows = await db.query<{ id: string }>(
        `UPDATE background_kills SET cleared_by = $3, cleared_at = $4
         WHERE scope = $1 AND target = $2 AND cleared_at IS NULL RETURNING id::text AS id`,
        [scope, target, by, at.toISOString()],
      );
      return rows.length > 0;
    },
    async activeKills({ teams = [], orgs = [] }) {
      const rows = await db.query<KillRow>(
        `SELECT scope, target, killed_by, reason, killed_at, cleared_by, cleared_at
         FROM background_kills WHERE cleared_at IS NULL
           AND ((scope = 'team' AND target = ANY($1::text[]))
             OR (scope = 'org' AND target = ANY($2::text[])))
         ORDER BY killed_at`,
        [[...teams], [...orgs]],
      );
      return rows.map(killOf);
    },
  };
}
