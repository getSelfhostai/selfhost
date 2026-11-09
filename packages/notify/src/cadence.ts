import type { NotifyCadence } from "@selfhost/schema";

const DAY_MS = 86_400_000;

/**
 * The digest window `now` is in: from the last send time at or before now (each day at
 * `hour` UTC, or Mondays at `hour` for weekly) to the next one. undefined for off.
 */
export function digestWindow(
  cadence: NotifyCadence,
  now: Date,
  hour: number,
): { start: Date; key: string } | undefined {
  if (cadence === "off") return undefined;
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let start = day + hour * 3_600_000;
  if (start > now.getTime()) start -= DAY_MS;
  if (cadence === "weekly") {
    // Back to the Monday of the window's day: getUTCDay is 0 on Sunday.
    const weekday = (new Date(start).getUTCDay() + 6) % 7;
    start -= weekday * DAY_MS;
  }
  const at = new Date(start);
  return { start: at, key: `${cadence}:${at.toISOString()}` };
}

/** The spend digest's window: daily at `hour` UTC. */
export function spendDigestWindow(now: Date, hour: number): { start: Date; key: string } {
  const window = digestWindow("daily", now, hour);
  if (!window) throw new Error("unreachable: a daily window always exists");
  return { start: window.start, key: `spend:${window.start.toISOString()}` };
}
