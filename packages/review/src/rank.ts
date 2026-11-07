import type { ReviewItem } from "@selfhost/schema";
import { ReviewInputError } from "./errors.js";

/**
 * The list order, the same on every surface and for every state:
 *
 * 1. Items not snoozed, then items whose snooze has not ended yet.
 * 2. Items an agent is blocked on (blocking), then the rest.
 * 3. Higher risk score first.
 * 4. Older first, by created_at (when the first signal happened).
 * 5. By id, so two items never tie.
 *
 * Every key is stored on the item, so the order depends only on the items and the time of the
 * read (for the snooze). `rankKey` is that order as a tuple compared left to right, ascending.
 */
export type RankKey = [
  snoozed: 0 | 1,
  blocking: 0 | 1,
  risk: number,
  createdAt: string,
  id: string,
];

export function isSnoozed(item: Pick<ReviewItem, "snoozed_until">, now: Date): boolean {
  return item.snoozed_until !== undefined && Date.parse(item.snoozed_until) > now.getTime();
}

export function rankKey(item: ReviewItem, now: Date): RankKey {
  return [
    isSnoozed(item, now) ? 1 : 0,
    item.blocking ? 0 : 1,
    100 - item.risk.score,
    new Date(item.created_at).toISOString(),
    item.id.toLowerCase(),
  ];
}

/** Sorts items in list order. The SQL in the store sorts the same way. */
export function compareItems(a: ReviewItem, b: ReviewItem, now: Date): number {
  const left = rankKey(a, now);
  const right = rankKey(b, now);
  for (let i = 0; i < left.length; i++) {
    const x = left[i] as string | number;
    const y = right[i] as string | number;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** The rank columns in SQL; $now is the parameter holding the time of the read. */
export function rankColumns(now: string): string[] {
  return [
    `(CASE WHEN snoozed_until > ${now}::timestamptz THEN 1 ELSE 0 END)`,
    "(CASE WHEN blocking THEN 0 ELSE 1 END)",
    "(100 - risk_score)",
    "created_at",
    "id",
  ];
}

/** created_at as the cursor stores it: UTC with microseconds. */
export const CREATED_KEY = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeRankCursor(key: RankKey): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

export function decodeRankCursor(cursor: string): RankKey {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    value = undefined;
  }
  if (
    Array.isArray(value) &&
    value.length === 5 &&
    (value[0] === 0 || value[0] === 1) &&
    (value[1] === 0 || value[1] === 1) &&
    Number.isInteger(value[2]) &&
    value[2] >= 0 &&
    value[2] <= 100 &&
    typeof value[3] === "string" &&
    TS.test(value[3]) &&
    typeof value[4] === "string" &&
    UUID.test(value[4])
  ) {
    return value as RankKey;
  }
  throw new ReviewInputError("cursor", "Expected a cursor returned by a previous page");
}
