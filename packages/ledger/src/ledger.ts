import {
  createValidator,
  EventQuerySchema,
  type LedgerEvent,
  MAX_EVENT_BATCH,
  PAGE_LIMIT_DEFAULT,
  validateEvent,
} from "@selfhost/schema";
import { type ConnectOptions, connect, type Database, migrate } from "./db.js";
import { type LedgerFieldError, LedgerQueryError, LedgerValidationError } from "./errors.js";

export interface EventFilter {
  /** actor.id */
  person?: string;
  /** agent.vendor */
  agent?: string;
  model?: string;
  /** session_id */
  session?: string;
  kind?: string;
  /** Events at or after this time. */
  from?: string;
  /** Events before this time. */
  to?: string;
  /** 1 to 1000, default 100. */
  limit?: number;
  /** nextCursor from the previous page. */
  cursor?: string;
}

export interface AppendResult {
  /** Ids written by this call, in batch order. */
  accepted: string[];
  /** Ids skipped because an event with the same id was already stored. */
  duplicates: string[];
}

export interface EventPage {
  /** Newest first, ordered by (ts, id). */
  events: LedgerEvent[];
  /** Pass as cursor to get the next page. Absent on the last page. */
  nextCursor?: string;
}

export interface Ledger {
  /**
   * Validates every event, then writes them in one transaction. If any event is invalid, nothing
   * is written and LedgerValidationError lists every error. Ids are idempotency keys: an id that
   * is already stored is reported under duplicates and the stored event is left as it was.
   */
  append(events: unknown[]): Promise<AppendResult>;
  query(filter: EventFilter): Promise<EventPage>;
  close(): Promise<void>;
}

export type OpenLedgerOptions = ConnectOptions;

/**
 * Opens the ledger and applies pending migrations. A postgres:// or postgresql:// url uses that
 * Postgres server; otherwise the embedded PGlite database in dataDir (default
 * SELFHOST_DATA_DIR or ~/.selfhost/data). dataDir "memory://" keeps everything in memory.
 */
export async function openLedger(options: OpenLedgerOptions = {}): Promise<Ledger> {
  const db = await connect(options);
  try {
    await migrate(db);
  } catch (error) {
    await db.close();
    throw error;
  }
  return createLedger(db);
}

const INSERT_SQL = `
INSERT INTO events (id, ts, source, kind, actor_kind, actor_id, agent, model, session_id, body)
SELECT (e->>'id')::uuid, (e->>'ts')::timestamptz, e->>'source', e->>'kind',
  e#>>'{actor,kind}', e#>>'{actor,id}', e#>>'{agent,vendor}', e->>'model', e->>'session_id', e
FROM jsonb_array_elements($1::text::jsonb) WITH ORDINALITY AS batch(e, n)
ORDER BY n
ON CONFLICT (id) DO NOTHING
RETURNING id::text AS id`;

const TS_KEY = `to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function createLedger(db: Database): Ledger {
  return {
    async append(events) {
      const valid = validateForAppend(events);
      if (valid.length === 0) return { accepted: [], duplicates: [] };
      const inserted = new Set<string>();
      await db.transaction(async (tx) => {
        for (let start = 0; start < valid.length; start += MAX_EVENT_BATCH) {
          const chunk = valid.slice(start, start + MAX_EVENT_BATCH);
          const rows = await tx.query<{ id: string }>(INSERT_SQL, [JSON.stringify(chunk)]);
          for (const row of rows) inserted.add(row.id);
        }
      });
      const result: AppendResult = { accepted: [], duplicates: [] };
      for (const event of valid) {
        const key = event.id.toLowerCase();
        if (inserted.delete(key)) result.accepted.push(event.id);
        else result.duplicates.push(event.id);
      }
      return result;
    },

    async query(filter) {
      const { limit, conditions, params } = buildQuery(filter);
      params.push(limit + 1);
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = await db.query<{ body: unknown; ts_key: string; id: string }>(
        `SELECT body, ${TS_KEY} AS ts_key, id::text AS id FROM events ${where}
         ORDER BY ts DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      const page = rows.slice(0, limit);
      const events = page.map(
        (row) => (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as LedgerEvent,
      );
      const last = page.at(-1);
      if (rows.length > limit && last) {
        return { events, nextCursor: encodeCursor(last.ts_key, last.id) };
      }
      return { events };
    },

    close: () => db.close(),
  };
}

function validateForAppend(events: unknown): LedgerEvent[] {
  if (!Array.isArray(events)) {
    throw new LedgerValidationError([{ index: -1, path: "events", message: "Expected an array" }]);
  }
  const errors: LedgerFieldError[] = [];
  const firstIndexById = new Map<string, number>();
  events.forEach((value, index) => {
    const result = validateEvent(value);
    if (!result.ok) {
      for (const error of result.errors)
        errors.push({ index, path: error.field, message: error.message });
      return;
    }
    const key = result.value.id.toLowerCase();
    const earlier = firstIndexById.get(key);
    if (earlier !== undefined) {
      errors.push({
        index,
        path: "id",
        message: `Duplicate id, also used by the event at index ${earlier}`,
      });
      return;
    }
    firstIndexById.set(key, index);
    for (const problem of unstorable(result.value)) errors.push({ index, ...problem });
  });
  if (errors.length > 0) throw new LedgerValidationError(errors);
  return events as LedgerEvent[];
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Postgres jsonb cannot hold NUL characters or unpaired UTF-16 surrogates. */
function storableText(text: string): boolean {
  return !text.includes("\0") && !LONE_SURROGATE.test(text);
}

/** Values that pass the schema but that Postgres would refuse, reported like schema errors. */
function unstorable(event: LedgerEvent): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  if (Number(event.ts.slice(0, 4)) < 1) {
    problems.push({ path: "ts", message: "Expected a year from 0001 to 9999" });
  }
  const visit = (value: unknown, path: string) => {
    if (typeof value === "string") {
      if (!storableText(value)) {
        problems.push({ path, message: "Contains a NUL character or invalid UTF-16" });
      }
    } else if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) visit(item, `${path}[${i}]`);
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        const child = /^[A-Za-z0-9_-]+$/.test(key)
          ? `${path}.${key}`
          : `${path}[${JSON.stringify(key)}]`;
        if (!storableText(key)) {
          problems.push({ path: child, message: "Key contains a NUL character or invalid UTF-16" });
        }
        visit(item, child);
      }
    }
  };
  for (const [key, value] of Object.entries(event)) visit(value, key);
  return problems;
}

const queryValidator = createValidator(EventQuerySchema);

function buildQuery(filter: EventFilter) {
  const defined = Object.fromEntries(
    Object.entries(filter ?? {}).filter(([, value]) => value !== undefined),
  );
  const checked = queryValidator.validate(defined);
  if (!checked.ok) {
    const [first] = checked.errors;
    throw new LedgerQueryError(first?.field ?? "filter", first?.message ?? "Invalid filter");
  }
  const conditions: string[] = [];
  const params: unknown[] = [];
  const where = (column: string, op: string, value: unknown, cast = "") => {
    params.push(value);
    conditions.push(`${column} ${op} $${params.length}${cast}`);
  };
  if (filter.person !== undefined) where("actor_id", "=", filter.person);
  if (filter.agent !== undefined) where("agent", "=", filter.agent);
  if (filter.model !== undefined) where("model", "=", filter.model);
  if (filter.session !== undefined) where("session_id", "=", filter.session);
  if (filter.kind !== undefined) where("kind", "=", filter.kind);
  if (filter.from !== undefined) where("ts", ">=", filter.from, "::timestamptz");
  if (filter.to !== undefined) where("ts", "<", filter.to, "::timestamptz");
  if (filter.cursor !== undefined) {
    const cursor = decodeCursor(filter.cursor);
    params.push(cursor.ts, cursor.id);
    conditions.push(`(ts, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  return { limit: filter.limit ?? PAGE_LIMIT_DEFAULT, conditions, params };
}

const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { ts: string; id: string } {
  const [ts = "", id = "", ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (rest.length > 0 || !CURSOR_TS.test(ts) || !CURSOR_ID.test(id)) {
    throw new LedgerQueryError("cursor", "Expected a cursor returned by a previous page");
  }
  return { ts, id };
}
