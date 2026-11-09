import { EVENT_KINDS, type LedgerEvent } from "@selfhost/schema";
import { decodeCursor, encodeCursor } from "./cursor.js";
import type { Queryable } from "./db.js";
import { LedgerQueryError } from "./errors.js";

/**
 * The ledger's events in the order they reached it (ingested_at, then id), for `selfhost tail`
 * and GET /v1/events/tail. Reads only: it never takes a lock or writes progress anywhere, so
 * any number of tails can follow the same ledger.
 */

export interface TailFilter {
  /** Event kinds, or their first part: tool matches tool.called and tool.result. */
  kinds?: readonly string[];
  /** actor.id */
  person?: string;
  /** agent.vendor */
  agent?: string;
  /** owner/name: the event's repo, else the repo its run recorded. */
  repo?: string;
  session?: string;
  /** The teams to read (events.team). null or absent: every event, with a team or none. */
  teams?: readonly string[] | null;
  /** Only events that happened at or after this time; it keeps every query on the ts index. */
  from: string;
}

export interface TailOptions extends TailFilter {
  /** Cursor of the previous page. Absent: start now, unless `backfill` reads from `from`. */
  after?: string;
  /** Without after: the events since `from` first, instead of starting now. */
  backfill?: boolean;
  /** 1 to 1000, default 200. */
  limit?: number;
  /**
   * Leaves out rows ingested in the last settleMs milliseconds, and starts "now" that far back,
   * so a write whose transaction began earlier but committed later is still read. Postgres
   * needs it for concurrent writers; the embedded ledger has one writer and uses 0.
   */
  settleMs?: number;
}

export interface TailRow {
  event: LedgerEvent;
  /** events.team, null on a laptop ledger and for events the admin token wrote. */
  team: string | null;
  /** The event's repo, else its run's, lower case; null when neither is known. */
  repo: string | null;
}

export interface TailPage {
  /** Oldest ingested first. */
  rows: TailRow[];
  /** Pass as after for the next page. */
  cursor: string;
}

const KEY = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const ZERO_ID = "00000000-0000-0000-0000-000000000000";
const EPOCH_KEY = "1970-01-01T00:00:00.000000Z";
const GROUPS = new Set(EVENT_KINDS.map((kind) => kind.split(".")[0]));

export async function tailEvents(db: Queryable, options: TailOptions): Promise<TailPage> {
  const limit = options.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new LedgerQueryError("limit", "Expected an integer from 1 to 1000");
  }
  if (Number.isNaN(Date.parse(options.from))) {
    throw new LedgerQueryError("from", "Expected a date-time");
  }
  for (const kind of options.kinds ?? []) {
    if (!(EVENT_KINDS as readonly string[]).includes(kind) && !GROUPS.has(kind)) {
      throw new LedgerQueryError("kind", `Unknown event kind "${kind}"`);
    }
  }
  const settle = Math.max(0, Math.round(options.settleMs ?? 0));
  const params: unknown[] = [];
  const param = (value: unknown, cast = "") => {
    params.push(value);
    return `$${params.length}${cast}`;
  };
  const settled = () => `(now() - ${param(settle)}::int * interval '1 millisecond')`;
  let after = options.after === undefined ? undefined : decodeCursor(options.after);
  if (after === undefined && !options.backfill) {
    // Start now: nothing yet, and the cursor of this moment.
    const [row] = await db.query<{ key: string }>(`SELECT ${KEY(settled())} AS key`, params);
    return { rows: [], cursor: encodeCursor(row?.key ?? EPOCH_KEY, ZERO_ID) };
  }

  const conditions = [`e.ts >= ${param(options.from, "::timestamptz")}`];
  if (settle > 0) conditions.push(`e.ingested_at <= ${settled()}`);
  if (after) {
    conditions.push(
      `(e.ingested_at, e.id) > (${param(after.ts, "::timestamptz")}, ${param(after.id, "::uuid")})`,
    );
  }
  if (options.kinds && options.kinds.length > 0) {
    const kinds = param(JSON.stringify(options.kinds), "::text::jsonb");
    conditions.push(
      `(e.kind IN (SELECT jsonb_array_elements_text(${kinds}))
        OR split_part(e.kind, '.', 1) IN (SELECT jsonb_array_elements_text(${kinds})))`,
    );
  }
  if (options.person !== undefined) conditions.push(`e.actor_id = ${param(options.person)}`);
  if (options.agent !== undefined) conditions.push(`e.agent = ${param(options.agent)}`);
  if (options.session !== undefined) conditions.push(`e.session_id = ${param(options.session)}`);
  if (options.repo !== undefined) {
    conditions.push(`coalesce(lower(e.body->>'repo'), rr.repo) = lower(${param(options.repo)})`);
  }
  if (options.teams) {
    conditions.push(
      `e.team IN (SELECT jsonb_array_elements_text(${param(JSON.stringify(options.teams), "::text::jsonb")}))`,
    );
  }
  const rows = await db.query<{
    body: unknown;
    team: string | null;
    repo: string | null;
    key: string;
    id: string;
  }>(
    `SELECT e.body, e.team, coalesce(lower(e.body->>'repo'), rr.repo) AS repo,
       ${KEY("e.ingested_at")} AS key, e.id::text AS id
     FROM events e LEFT JOIN run_repos rr ON rr.session_id = e.session_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY e.ingested_at, e.id
     LIMIT ${param(limit)}`,
    params,
  );
  const last = rows.at(-1);
  if (last) after = { ts: last.key, id: last.id };
  return {
    rows: rows.map((row) => ({
      event: (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as LedgerEvent,
      team: row.team,
      repo: row.repo,
    })),
    cursor: after
      ? encodeCursor(after.ts, after.id)
      : // A backfill that found nothing reads the whole window again next time.
        encodeCursor(EPOCH_KEY, ZERO_ID),
  };
}
