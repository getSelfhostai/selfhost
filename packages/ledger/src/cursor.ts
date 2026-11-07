import { LedgerQueryError } from "./errors.js";

/** ts as the keyset cursor stores it: UTC with microseconds, so ties sort by id. */
export const TS_KEY = `to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { ts: string; id: string } {
  const [ts = "", id = "", ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (rest.length > 0 || !CURSOR_TS.test(ts) || !CURSOR_ID.test(id)) {
    throw new LedgerQueryError("cursor", "Expected a cursor returned by a previous page");
  }
  return { ts, id };
}
