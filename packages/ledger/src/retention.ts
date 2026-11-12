import { parseConfig } from "@selfhost/schema";
import type { Queryable } from "./db.js";
import { databaseOf, type Ledger } from "./ledger.js";

export const DAY_MS = 86_400_000;

/** Postgres timestamps start at year 1; an older cutoff deletes nothing extra. */
const EARLIEST_MS = Date.parse("0001-01-01T00:00:00.000Z");

export interface RetentionResult {
  /** Events deleted. */
  deleted: number;
  /** Events with no team, or a team with no stored selfhost.toml, from before this were deleted. */
  before: string;
  /** Teams whose stored selfhost.toml sets their retention: team id to the cutoff used. */
  teams: Record<string, string>;
}

function cutoff(now: Date, days: number): string {
  return new Date(Math.max(now.getTime() - days * DAY_MS, EARLIEST_MS)).toISOString();
}

/**
 * ledger.retention_days of every team that has a stored selfhost.toml, at most maxDays (a
 * hosted server's limit) when given.
 */
async function teamRetention(
  db: Queryable,
  maxDays = Number.POSITIVE_INFINITY,
): Promise<Record<string, number>> {
  const rows = await db.query<{ id: string; policy_text: string }>(
    "SELECT id, policy_text FROM teams WHERE policy_text IS NOT NULL",
  );
  const days: Record<string, number> = {};
  for (const row of rows) {
    const parsed = parseConfig(row.policy_text);
    if (parsed.ok) days[row.id] = Math.min(parsed.config.ledger.retention_days, maxDays);
  }
  return days;
}

const DELETE_EXPIRED = `
WITH removed AS (
  DELETE FROM events
  WHERE ts < $1::timestamptz
    AND ts < coalesce(($2::text::jsonb ->> (body->>'team'))::timestamptz, $3::timestamptz)
  RETURNING 1
)
SELECT count(*)::int AS deleted FROM removed`;

/**
 * Deletes events older than `days` before `now`, the one delete the append-only trigger allows.
 * Events of a team with a stored selfhost.toml use that file's ledger.retention_days instead.
 * selfhost.retention is set with SET LOCAL, so it ends with this transaction and every other
 * statement is still refused. With options.maxDays no team keeps events longer than that.
 */
export async function retentionSweep(
  ledger: Ledger,
  days: number,
  now: Date = new Date(),
  options: { maxDays?: number } = {},
): Promise<RetentionResult> {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`Retention days: expected a whole number of 1 or more, got ${days}`);
  }
  const db = databaseOf(ledger);
  const teamDays = await teamRetention(db, options.maxDays);
  const teams = Object.fromEntries(
    Object.entries(teamDays).map(([team, value]) => [team, cutoff(now, value)]),
  );
  const before = cutoff(now, days);
  // The newest cutoff bounds every row the delete can touch, so the ts index narrows the scan.
  const newest = cutoff(now, Math.min(days, ...Object.values(teamDays)));
  const deleted = await db.transaction(async (tx) => {
    await tx.query("SET LOCAL selfhost.retention = 'on'");
    const [row] = await tx.query<{ deleted: number }>(DELETE_EXPIRED, [
      newest,
      JSON.stringify(teams),
      before,
    ]);
    return Number(row?.deleted ?? 0);
  });
  return { deleted, before, teams };
}
