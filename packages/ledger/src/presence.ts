import {
  derivePresence,
  HANDOFF_EVENT_KIND,
  type LedgerEvent,
  type OwnershipConfig,
  type PresenceInput,
  type PresenceResponse,
} from "@selfhost/schema";
import type { Queryable } from "./db.js";

/**
 * Presence from the ledger (selfhost who, GET /v1/presence, the MCP tool who): the runs with an
 * event inside the idle window that have not ended, grouped by session (or background run id).
 * Nothing is captured for it beyond the events themselves.
 */

export interface PresenceOptions {
  now: Date;
  idleMinutes: number;
  /** The teams to read (events.team). null: every event, with a team or none (a laptop, admin). */
  teams: readonly string[] | null;
  /** Only runs in this repository, as owner/name. */
  repo?: string;
  /** selfhost.toml of a team (null: events with no team), for each run's owner. */
  configFor?: (team: string | null) => Promise<OwnershipConfig | undefined>;
}

/** Most events presence reads from the window, newest first: enough for a busy team's half hour. */
export const PRESENCE_EVENTS_MAX = 20_000;

const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

/** The team most of a run's events belong to, or null when none has one. */
function teamOf(teams: readonly (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const team of teams) if (team) counts.set(team, (counts.get(team) ?? 0) + 1);
  let best: string | null = null;
  for (const [team, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = team;
  return best;
}

interface Group {
  id: string;
  kind: PresenceInput["kind"];
  events: LedgerEvent[];
  teams: (string | null)[];
}

export async function readPresence(
  db: Queryable,
  options: PresenceOptions,
): Promise<PresenceResponse> {
  const from = new Date(options.now.getTime() - options.idleMinutes * 60_000).toISOString();
  const params: unknown[] = [from, options.now.toISOString()];
  let where = "ts > $1 AND ts <= $2 AND (session_id IS NOT NULL OR body->>'run_id' IS NOT NULL)";
  if (options.teams !== null) {
    params.push(JSON.stringify(options.teams));
    where += ` AND team IN (SELECT jsonb_array_elements_text($${params.length}::text::jsonb))`;
  }
  const rows = await db.query<{ body: unknown; team: string | null }>(
    `SELECT body, team FROM events WHERE ${where} ORDER BY ts DESC, id DESC LIMIT ${PRESENCE_EVENTS_MAX}`,
    params,
  );

  // Background runs by run id; sessions by session id, folded into their run when they carry one.
  const groups = new Map<string, Group>();
  const add = (
    key: string,
    id: string,
    kind: Group["kind"],
    event: LedgerEvent,
    team: string | null,
  ) => {
    const group = groups.get(key) ?? { id, kind, events: [], teams: [] };
    group.events.push(event);
    group.teams.push(team);
    groups.set(key, group);
  };
  const events = rows.map((row) => ({ event: json<LedgerEvent>(row.body), team: row.team }));
  const runIds = new Set(
    events.flatMap(({ event }) => (event.session_id ? [] : event.run_id ? [event.run_id] : [])),
  );
  for (const { event, team } of events) {
    if (event.run_id && (!event.session_id || runIds.has(event.run_id))) {
      add(`r:${event.run_id}`, event.run_id, "background", event, team);
    } else if (event.session_id) {
      add(`s:${event.session_id}`, event.session_id, "session", event, team);
    }
  }
  if (options.repo) {
    const wanted = options.repo.toLowerCase();
    for (const [key, group] of groups) {
      if (!group.events.some((e) => e.repo?.toLowerCase() === wanted)) groups.delete(key);
    }
  }

  const sessions = [...groups.values()].filter((g) => g.kind === "session").map((g) => g.id);
  const runs = [...groups.values()].filter((g) => g.kind === "background").map((g) => g.id);
  const started = new Map<string, string>();
  const history = new Map<string, LedgerEvent[]>();
  if (sessions.length > 0) {
    const list = JSON.stringify(sessions);
    for (const row of await db.query<{ key: string; first: unknown }>(
      `SELECT session_id AS key, min(ts) AS first FROM events
       WHERE session_id IN (SELECT jsonb_array_elements_text($1::text::jsonb))
       GROUP BY session_id`,
      [list],
    )) {
      started.set(`s:${row.key}`, iso(row.first));
    }
    for (const row of await db.query<{ key: string; body: unknown }>(
      `SELECT session_id AS key, body FROM events
       WHERE session_id IN (SELECT jsonb_array_elements_text($1::text::jsonb))
         AND kind = '${HANDOFF_EVENT_KIND}' AND ts <= $2`,
      [list, from],
    )) {
      const key = `s:${row.key}`;
      history.set(key, [...(history.get(key) ?? []), json<LedgerEvent>(row.body)]);
    }
  }
  if (runs.length > 0) {
    const list = JSON.stringify(runs);
    for (const row of await db.query<{ key: string; first: unknown }>(
      `SELECT body->>'run_id' AS key, min(ts) AS first FROM events
       WHERE body->>'run_id' IN (SELECT jsonb_array_elements_text($1::text::jsonb))
       GROUP BY body->>'run_id'`,
      [list],
    )) {
      started.set(`r:${row.key}`, iso(row.first));
    }
    for (const row of await db.query<{ key: string; body: unknown }>(
      `SELECT body->>'run_id' AS key, body FROM events
       WHERE body->>'run_id' IN (SELECT jsonb_array_elements_text($1::text::jsonb))
         AND kind IN ('run.triggered', '${HANDOFF_EVENT_KIND}') AND ts <= $2`,
      [list, from],
    )) {
      const key = `r:${row.key}`;
      history.set(key, [...(history.get(key) ?? []), json<LedgerEvent>(row.body)]);
    }
  }

  const configs = new Map<string | null, OwnershipConfig | undefined>();
  const inputs: PresenceInput[] = [];
  for (const [key, group] of groups) {
    const team = teamOf(group.teams);
    if (!configs.has(team)) configs.set(team, await options.configFor?.(team));
    const config = configs.get(team);
    const first = started.get(key);
    inputs.push({
      id: group.id,
      kind: group.kind,
      events: group.events,
      history: history.get(key) ?? [],
      ...(first ? { started_at: first } : {}),
      team: team ?? group.events.find((e) => e.team)?.team ?? null,
      ...(config ? { config } : {}),
    });
  }
  return derivePresence(inputs, { now: options.now, idleMinutes: options.idleMinutes });
}
