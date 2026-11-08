import type { LedgerEvent } from "@selfhost/schema";
import { normalizeDecisionPath, pathMatches, teamIn } from "./decisions/store.js";
import { LedgerQueryError } from "./errors.js";
import { databaseOf, type Ledger } from "./ledger.js";

export interface FileCallQuery {
  /** File or folder relative to the repository root, or absolute as a tool call saw it. */
  path: string;
  /** Only events stored with one of these teams (a person token's). Default: every event. */
  teams?: readonly string[];
  /** Only calls in this repository, as owner/name. */
  repo?: string;
  /** Calls at or after this time. */
  from?: string;
  /** At most this many calls, newest first. Default 500, at most 2000. */
  limit?: number;
}

const LIMIT_DEFAULT = 500;
const LIMIT_MAX = 2000;

/**
 * tool.called events whose target is the file, a file under the folder, or the same path seen
 * from a deeper root, newest first. Path matching is the decision log's (on whole segments).
 */
export async function fileCalls(ledger: Ledger, query: FileCallQuery): Promise<LedgerEvent[]> {
  const path = normalizeDecisionPath(query.path);
  if (path === "" || path === "." || path === "/") {
    throw new LedgerQueryError("path", "Expected a file or folder path");
  }
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? LIMIT_DEFAULT), 1), LIMIT_MAX);
  const params: unknown[] = [path];
  const param = (value: unknown) => {
    params.push(value);
    return params.length;
  };
  const conditions = [
    "kind = 'tool.called'",
    "body#>>'{target,type}' = 'file'",
    pathMatches("body#>>'{target,value}'", 1),
  ];
  if (query.teams !== undefined) conditions.push(teamIn(param(JSON.stringify(query.teams))));
  if (query.repo !== undefined) {
    conditions.push(`lower(body->>'repo') = lower($${param(query.repo)}::text)`);
  }
  if (query.from !== undefined) conditions.push(`ts >= $${param(query.from)}::timestamptz`);
  const rows = await databaseOf(ledger).query<{ body: unknown }>(
    `SELECT body FROM events WHERE ${conditions.join(" AND ")}
     ORDER BY ts DESC, id DESC LIMIT $${param(limit)}`,
    params,
  );
  return rows.map((row) => (typeof row.body === "string" ? JSON.parse(row.body) : row.body));
}
