import type { Queryable } from "@selfhost/ledger";
import {
  createValidator,
  PAGE_LIMIT_DEFAULT,
  type ReviewItem,
  type ReviewItemQuery,
  ReviewItemQuerySchema,
  type ReviewItemsPage,
} from "@selfhost/schema";
import { ReviewInputError } from "./errors.js";
import {
  CREATED_KEY,
  decodeRankCursor,
  encodeRankCursor,
  type RankKey,
  rankColumns,
} from "./rank.js";

/** One row of review_items: the item plus what the store needs that the item does not say. */
export interface StoredItem {
  item: ReviewItem;
  /** events.team of the signals: the team scope. null on a laptop or for admin-token events. */
  team: string | null;
  dedupeKey: string;
  /** Time of the newest signal. */
  signalAt: string;
  tool?: string;
  paths: string[];
  /** Bumped on every write; a write based on an older version changes nothing. */
  version: number;
}

/** Which items a list reads and writes: one team's, or every item when team is undefined. */
export interface Scope {
  team?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAIM = "interval '1 minute'";
const COLUMNS = "body, team, dedupe_key, signal_at, tool, paths, version";

const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const json = <T>(value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as T;

interface Row {
  body: unknown;
  team: string | null;
  dedupe_key: string;
  signal_at: unknown;
  tool: string | null;
  paths: unknown;
  version: number;
}

function toStored(row: Row): StoredItem {
  return {
    item: json<ReviewItem>(row.body),
    team: row.team,
    dedupeKey: row.dedupe_key,
    signalAt: iso(row.signal_at),
    ...(row.tool === null ? {} : { tool: row.tool }),
    paths: json<string[]>(row.paths),
    version: Number(row.version),
  };
}

/** The columns every write sets, from the item, in a fixed order. */
function values(stored: Omit<StoredItem, "version">): unknown[] {
  const { item } = stored;
  return [
    item.kind,
    item.state,
    item.blocking,
    item.risk.score,
    item.session_id ?? null,
    stored.tool ?? null,
    JSON.stringify(stored.paths),
    item.created_at,
    item.updated_at,
    stored.signalAt,
    item.deadline ?? null,
    item.snoozed_until ?? null,
    JSON.stringify(item),
  ];
}

const SET = `kind = $2, state = $3, blocking = $4, risk_score = $5, session_id = $6, tool = $7,
  paths = $8::text::jsonb, created_at = $9::timestamptz, updated_at = $10::timestamptz,
  signal_at = $11::timestamptz, deadline = $12::timestamptz, snoozed_until = $13::timestamptz,
  body = $14::text::jsonb, version = version + 1`;

function scoped(scope: Scope, params: unknown[]): string {
  if (scope.team === undefined) return "";
  params.push(scope.team);
  return ` AND team = $${params.length}`;
}

const notClaimed = "(claimed_until IS NULL OR claimed_until < now())";

export async function insertItem(q: Queryable, stored: Omit<StoredItem, "version">) {
  await q.query(
    `INSERT INTO review_items (id, kind, state, blocking, risk_score, session_id, tool, paths,
       created_at, updated_at, signal_at, deadline, snoozed_until, body, team, dedupe_key)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9::timestamptz, $10::timestamptz,
       $11::timestamptz, $12::timestamptz, $13::timestamptz, $14::text::jsonb, $15, $16)`,
    [stored.item.id, ...values(stored), stored.team, stored.dedupeKey],
  );
}

/**
 * Writes the item if nobody changed it since `stored` was read and nobody holds a claim on it.
 * false when it was not written.
 */
export async function updateItem(q: Queryable, stored: StoredItem): Promise<boolean> {
  const rows = await q.query(
    `UPDATE review_items SET ${SET}
     WHERE id = $1::uuid AND version = $15 AND ${notClaimed}
     RETURNING id`,
    [stored.item.id, ...values(stored), stored.version],
  );
  return rows.length > 0;
}

/** Writes the answer of a claim and lets go of it. false when the claim was lost. */
export async function finishClaim(q: Queryable, stored: StoredItem): Promise<boolean> {
  const rows = await q.query(
    `UPDATE review_items SET ${SET}, claimed_until = NULL
     WHERE id = $1::uuid AND version = $15
     RETURNING id`,
    [stored.item.id, ...values(stored), stored.version],
  );
  return rows.length > 0;
}

/**
 * Takes the item for one answer: only an open item nobody else holds. The claim lasts a minute,
 * long enough to write the decision; undefined when the item is not open or is held.
 */
export async function claimItem(
  q: Queryable,
  id: string,
  scope: Scope,
): Promise<StoredItem | undefined> {
  if (!UUID.test(id)) return undefined;
  const params: unknown[] = [id];
  const team = scoped(scope, params);
  const [row] = await q.query<Row>(
    `UPDATE review_items SET claimed_until = now() + ${CLAIM}, version = version + 1
     WHERE id = $1::uuid AND state = 'open' AND ${notClaimed}${team}
     RETURNING ${COLUMNS}`,
    params,
  );
  return row ? toStored(row) : undefined;
}

export async function releaseClaim(q: Queryable, stored: StoredItem): Promise<void> {
  await q.query(
    "UPDATE review_items SET claimed_until = NULL, version = version + 1 WHERE id = $1::uuid AND version = $2",
    [stored.item.id, stored.version],
  );
}

export async function getItem(
  q: Queryable,
  id: string,
  scope: Scope,
): Promise<StoredItem | undefined> {
  if (!UUID.test(id)) return undefined;
  const params: unknown[] = [id];
  const team = scoped(scope, params);
  const [row] = await q.query<Row>(
    `SELECT ${COLUMNS} FROM review_items WHERE id = $1::uuid${team}`,
    params,
  );
  return row ? toStored(row) : undefined;
}

/** The open item with this key in a team scope. */
export async function openItemByKey(
  q: Queryable,
  team: string | null,
  key: string,
): Promise<StoredItem | undefined> {
  const [row] = await q.query<Row>(
    `SELECT ${COLUMNS} FROM review_items
     WHERE coalesce(team, '') = $1 AND dedupe_key = $2 AND state = 'open'`,
    [team ?? "", key],
  );
  return row ? toStored(row) : undefined;
}

/** The item with this key in the scope: the open one, else the one opened last. */
export async function latestItemByKey(
  q: Queryable,
  scope: Scope,
  key: string,
): Promise<StoredItem | undefined> {
  const params: unknown[] = [key];
  const team = scoped(scope, params);
  const [row] = await q.query<Row>(
    `SELECT ${COLUMNS} FROM review_items WHERE dedupe_key = $1${team}
     ORDER BY state = 'open' DESC, created_at DESC, id DESC LIMIT 1`,
    params,
  );
  return row ? toStored(row) : undefined;
}

/** Open approvals and questions an agent waits on, with the session that can end the wait. */
export async function openWaitingItems(q: Queryable): Promise<StoredItem[]> {
  const rows = await q.query<Row>(
    `SELECT ${COLUMNS} FROM review_items
     WHERE state = 'open' AND blocking AND kind IN ('approval', 'question')
       AND session_id IS NOT NULL
     ORDER BY created_at, id`,
  );
  return rows.map(toStored);
}

/**
 * Open items of these sessions or runs that an agent waits on, or that are exceptions, in the
 * scope. Auto-approve reads them: a pull request whose run has one waits for a person.
 */
export async function openWaitsOf(
  q: Queryable,
  scope: Scope,
  runs: { sessions: readonly string[]; runIds: readonly string[] },
): Promise<ReviewItem[]> {
  if (runs.sessions.length === 0 && runs.runIds.length === 0) return [];
  const params: unknown[] = [JSON.stringify(runs.sessions), JSON.stringify(runs.runIds)];
  const team = scoped(scope, params);
  const rows = await q.query<{ body: unknown }>(
    `SELECT body FROM review_items
     WHERE state = 'open' AND (blocking OR kind = 'exception')
       AND (session_id IN (SELECT jsonb_array_elements_text($1::text::jsonb))
         OR body->>'run_id' IN (SELECT jsonb_array_elements_text($2::text::jsonb)))${team}
     ORDER BY created_at, id`,
    params,
  );
  return rows.map((row) => json<ReviewItem>(row.body));
}

/** true when any item, in any state, has this key in a team scope. */
export async function hasItemWithKey(q: Queryable, team: string | null, key: string) {
  const rows = await q.query(
    "SELECT 1 FROM review_items WHERE coalesce(team, '') = $1 AND dedupe_key = $2 LIMIT 1",
    [team ?? "", key],
  );
  return rows.length > 0;
}

/**
 * Sets or ends a snooze in one statement, so it never undoes an answer written meanwhile.
 * undefined when the item is not open, is held by an answer in flight, or is not in the scope.
 */
export async function snoozeItem(
  q: Queryable,
  id: string,
  scope: Scope,
  change: { until?: string; by?: string; now: string },
): Promise<ReviewItem | undefined> {
  if (!UUID.test(id)) return undefined;
  const patch = {
    updated_at: change.now,
    ...(change.until ? { snoozed_until: change.until, snoozed_by: change.by } : {}),
  };
  const params: unknown[] = [id, JSON.stringify(patch), change.until ?? null, change.now];
  const team = scoped(scope, params);
  const [row] = await q.query<{ body: unknown }>(
    `UPDATE review_items
     SET body = (body - 'snoozed_until' - 'snoozed_by') || $2::text::jsonb,
       snoozed_until = $3::timestamptz, updated_at = $4::timestamptz, version = version + 1
     WHERE id = $1::uuid AND state = 'open' AND ${notClaimed}${team}
     RETURNING body`,
    params,
  );
  return row ? json<ReviewItem>(row.body) : undefined;
}

const queryValidator = createValidator(ReviewItemQuerySchema);

/**
 * Items `$n` owns, or whose signals it wrote: a source event, or any event of the item's
 * session, with that person as actor.
 */
function ownOrRaisedBy(n: number): string {
  const person = `lower($${n}::text)`;
  return `(EXISTS (SELECT 1 FROM jsonb_array_elements_text(body->'owners') AS o(person)
      WHERE lower(o.person) = ${person})
    OR EXISTS (SELECT 1 FROM events e
      WHERE e.id IN (SELECT s.id::uuid FROM jsonb_array_elements_text(review_items.body->'source_event_ids') AS s(id))
        AND e.actor_kind = 'person' AND lower(e.actor_id) = ${person})
    OR (review_items.session_id IS NOT NULL AND EXISTS (SELECT 1 FROM events e
      WHERE e.session_id = review_items.session_id
        AND coalesce(e.team, '') = coalesce(review_items.team, '')
        AND e.actor_kind = 'person' AND lower(e.actor_id) = ${person})))`;
}

/**
 * One page of items in rank order (see rank.ts). With `person`, only the items they own or
 * raised (see ownOrRaisedBy).
 */
export async function listItems(
  q: Queryable,
  scope: Scope,
  query: ReviewItemQuery,
  now: Date,
  person?: string,
): Promise<ReviewItemsPage> {
  const defined = Object.fromEntries(
    Object.entries(query ?? {}).filter(([, value]) => value !== undefined),
  );
  const checked = queryValidator.validate(defined);
  if (!checked.ok) {
    const [first] = checked.errors;
    throw new ReviewInputError(first?.field ?? "query", first?.message ?? "Invalid query");
  }
  const params: unknown[] = [now.toISOString(), query.state ?? "open"];
  const rank = rankColumns("$1");
  const conditions = ["state = $2"];
  if (query.owner !== undefined) {
    params.push(query.owner);
    conditions.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(body->'owners') AS o(person)
      WHERE lower(o.person) = lower($${params.length}::text))`);
  }
  if (query.team !== undefined) {
    params.push(query.team);
    conditions.push(`team = $${params.length}`);
  }
  if (person !== undefined) {
    params.push(person);
    conditions.push(ownOrRaisedBy(params.length));
  }
  const team = scoped(scope, params);
  if (query.cursor !== undefined) {
    const key = decodeRankCursor(query.cursor);
    const start = params.length + 1;
    params.push(...key);
    conditions.push(
      `(${rank.join(", ")}) > ($${start}::int, $${start + 1}::int, $${start + 2}::int, $${start + 3}::timestamptz, $${start + 4}::uuid)`,
    );
  }
  const limit = query.limit ?? PAGE_LIMIT_DEFAULT;
  params.push(limit + 1);
  const rows = await q.query<{
    body: unknown;
    s: number;
    b: number;
    r: number;
    created_key: string;
    id: string;
  }>(
    `SELECT body, ${rank[0]} AS s, ${rank[1]} AS b, ${rank[2]} AS r, ${CREATED_KEY} AS created_key,
       id::text AS id
     FROM review_items WHERE ${conditions.join(" AND ")}${team}
     ORDER BY ${rank.join(", ")} LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  const items = page.map((row) => json<ReviewItem>(row.body));
  const last = page.at(-1);
  const next: RankKey | undefined =
    rows.length > limit && last
      ? [
          Number(last.s) as 0 | 1,
          Number(last.b) as 0 | 1,
          Number(last.r),
          last.created_key,
          last.id,
        ]
      : undefined;
  return { items, next_cursor: next ? encodeRankCursor(next) : null };
}
