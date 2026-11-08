import { posix } from "node:path";
import {
  createValidator,
  type DecisionQuery,
  DecisionQuerySchema,
  type LedgerEvent,
  PAGE_LIMIT_DEFAULT,
} from "@selfhost/schema";
import { decodeCursor, encodeCursor, TS_KEY } from "../cursor.js";
import type { Database } from "../db.js";
import { LedgerQueryError } from "../errors.js";

/** Event kinds the decision log holds: human decisions and rule verdicts. */
export const DECISION_KINDS = ["decision.recorded", "policy.evaluated"] as const;

export interface DecisionPage {
  /** Newest first, ordered by (ts, id). */
  events: LedgerEvent[];
  /** Pass as cursor to get the next page. Absent on the last page. */
  nextCursor?: string;
  /**
   * For each event on the page (lower-case id) that later decisions correct or overturn, the
   * ids of those decisions, oldest first. Events are never edited, so this is how a reader
   * learns that a decision no longer stands.
   */
  replacedBy: Record<string, string[]>;
}

export interface DecisionSearchOptions {
  /**
   * Only events stored with one of these teams: the teams a person token may read. An empty
   * list matches nothing. Default: every event.
   */
  teams?: readonly string[];
}

export interface DecisionStore {
  /** The decision.recorded or policy.evaluated event with this id, if there is one. */
  get(id: string): Promise<LedgerEvent | undefined>;
  /**
   * Decisions and rule verdicts matching every filter given, newest first. `path` matches a
   * file, the files under a folder and the folders that hold it; `topic` needs every word in
   * the question or reason. The HTTP API, the CLI and the MCP tool all call this.
   */
  search(query: DecisionQuery, options?: DecisionSearchOptions): Promise<DecisionPage>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_IN = `kind IN (${DECISION_KINDS.map((kind) => `'${kind}'`).join(", ")})`;
const MAX_WORDS = 20;

const queryValidator = createValidator(DecisionQuerySchema);

const parseBody = (body: unknown) =>
  (typeof body === "string" ? JSON.parse(body) : body) as LedgerEvent;

/** A path as decisions store it: forward slashes, no leading ./ and no trailing slash. */
export function normalizeDecisionPath(path: string): string {
  const normalized = posix.normalize(path.trim().replaceAll("\\", "/"));
  return normalized.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}

function words(field: string, value: string): string[] {
  const list = value.toLowerCase().split(/\s+/).filter(Boolean);
  if (list.length === 0) throw new LedgerQueryError(field, "Expected at least one word");
  if (list.length > MAX_WORDS) throw new LedgerQueryError(field, `At most ${MAX_WORDS} words`);
  return list;
}

/**
 * True when the file or folder in `column` and the queried path `$n` are the same, one holds
 * the other, or one is the other seen from a deeper root (an absolute path in a tool call).
 * Matching is on whole path segments, so "db" does not match "dbx/file".
 */
export function pathMatches(column: string, n: number): string {
  const p = `$${n}::text`;
  return `(${column} = ${p}
    OR starts_with(${column}, ${p} || '/')
    OR starts_with(${p}, ${column} || '/')
    OR right(${column}, length(${p}) + 1) = ('/' || ${p})
    OR strpos(${column}, '/' || ${p} || '/') > 0)`;
}

/** `team IN (...)` for a JSON array parameter: the teams a person token reads. */
export function teamIn(n: number): string {
  return `team IN (SELECT jsonb_array_elements_text($${n}::text::jsonb))`;
}

function buildSearch(query: DecisionQuery, options: DecisionSearchOptions) {
  const defined = Object.fromEntries(
    Object.entries(query ?? {}).filter(([, value]) => value !== undefined),
  );
  const checked = queryValidator.validate(defined);
  if (!checked.ok) {
    const [first] = checked.errors;
    throw new LedgerQueryError(first?.field ?? "query", first?.message ?? "Invalid query");
  }
  const conditions = [KIND_IN];
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return params.length;
  };
  if (query.path !== undefined) {
    const path = normalizeDecisionPath(query.path);
    if (path === "" || path === "." || path === "/") {
      throw new LedgerQueryError("path", "Expected a file or folder path");
    }
    const n = param(path);
    conditions.push(`(
      (body#>>'{target,type}' = 'file' AND ${pathMatches("body#>>'{target,value}'", n)})
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(body#>'{data,paths}') = 'array'
            THEN body#>'{data,paths}' ELSE '[]'::jsonb END
        ) AS listed(path)
        WHERE ${pathMatches("listed.path", n)}
      ))`);
  }
  if (query.topic !== undefined) {
    const text = `lower(concat_ws(' ', body#>>'{data,question}', body#>>'{decision,reason}'))`;
    for (const word of words("topic", query.topic)) {
      conditions.push(`strpos(${text}, $${param(word)}::text) > 0`);
    }
  }
  if (query.text !== undefined) {
    for (const word of words("text", query.text)) {
      conditions.push(
        `strpos(lower(coalesce(body#>>'{decision,reason}', '')), $${param(word)}::text) > 0`,
      );
    }
  }
  if (query.rule_id !== undefined) {
    conditions.push(`body#>>'{decision,rule_id}' = $${param(query.rule_id)}::text`);
  }
  if (query.verdict !== undefined) {
    conditions.push(`body#>>'{decision,verdict}' = $${param(query.verdict)}::text`);
  }
  if (query.repo !== undefined) conditions.push(`body->>'repo' = $${param(query.repo)}::text`);
  if (query.target !== undefined) {
    conditions.push(`strpos(body#>>'{target,value}', $${param(query.target)}::text) > 0`);
  }
  if (query.person !== undefined) {
    conditions.push(`coalesce(body#>>'{decision,by}', actor_id) = $${param(query.person)}::text`);
  }
  if (query.team !== undefined) conditions.push(`team = $${param(query.team)}::text`);
  if (options.teams !== undefined) conditions.push(teamIn(param(JSON.stringify(options.teams))));
  if (query.item_id !== undefined) {
    const n = param(query.item_id.toLowerCase());
    conditions.push(
      `(lower(body#>>'{decision,item_id}') = $${n}::text OR lower(body#>>'{links,item_id}') = $${n}::text)`,
    );
  }
  if (query.from !== undefined) conditions.push(`ts >= $${param(query.from)}::timestamptz`);
  if (query.to !== undefined) conditions.push(`ts < $${param(query.to)}::timestamptz`);
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor);
    const ts = param(cursor.ts);
    conditions.push(`(ts, id) < ($${ts}::timestamptz, $${param(cursor.id)}::uuid)`);
  }
  return { limit: query.limit ?? PAGE_LIMIT_DEFAULT, conditions, params };
}

export function createDecisionStore(db: Database): DecisionStore {
  /** Later decisions that name one of `ids` in replaces_event_id. */
  async function replacements(ids: string[]): Promise<Record<string, string[]>> {
    if (ids.length === 0) return {};
    const rows = await db.query<{ id: string; replaces: string }>(
      `SELECT id::text AS id, lower(body#>>'{decision,replaces_event_id}') AS replaces
       FROM events
       WHERE kind = 'decision.recorded'
         AND lower(body#>>'{decision,replaces_event_id}') IN
           (SELECT jsonb_array_elements_text($1::text::jsonb))
       ORDER BY ts, id`,
      [JSON.stringify(ids.map((id) => id.toLowerCase()))],
    );
    const result: Record<string, string[]> = {};
    for (const row of rows) result[row.replaces] = [...(result[row.replaces] ?? []), row.id];
    return result;
  }

  return {
    async get(id) {
      if (!UUID.test(id)) return undefined;
      const rows = await db.query<{ body: unknown }>(
        `SELECT body FROM events WHERE id = $1::uuid AND ${KIND_IN}`,
        [id],
      );
      return rows[0] ? parseBody(rows[0].body) : undefined;
    },

    async search(query, options = {}) {
      const { limit, conditions, params } = buildSearch(query, options);
      params.push(limit + 1);
      const rows = await db.query<{ body: unknown; ts_key: string; id: string }>(
        `SELECT body, ${TS_KEY} AS ts_key, id::text AS id FROM events
         WHERE ${conditions.join(" AND ")}
         ORDER BY ts DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      const page = rows.slice(0, limit);
      const events = page.map((row) => parseBody(row.body));
      const replacedBy = await replacements(page.map((row) => row.id));
      const last = page.at(-1);
      if (rows.length > limit && last) {
        return { events, nextCursor: encodeCursor(last.ts_key, last.id), replacedBy };
      }
      return { events, replacedBy };
    },
  };
}
