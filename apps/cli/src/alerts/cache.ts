import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LimitWindow, Plan } from "@selfhost/spend";
import { usd } from "../format.js";
import type { CheckResult } from "./check.js";
import { duration, PLAN_NAMES, seriesText, shortSuggestion } from "./text.js";

/**
 * What `selfhost statusline` prints from, so it never has to open the ledger: written by
 * `selfhost import --watch` after each batch, and by the statusline itself when no watcher is
 * running. Small on purpose.
 */
export interface StatuslineCache {
  schema: "selfhost.statusline/v1";
  written_at: string;
  /** The `import --watch` process keeping it fresh, or null. */
  pid: number | null;
  person: string;
  today: { day: string; usd: number };
  warnings: {
    plan: Plan;
    window: LimitWindow;
    status: "warn" | "reached";
    run_out: string | null;
    window_end: string | null;
    fix: string;
  }[];
  alarms: { slot_start: string; slot_end: string; usd: number; on: string }[];
}

/** A cache older than this, with no live watcher, is recomputed. */
export const CACHE_TTL_MS = 5 * 60_000;
/** Alarms stay on the statusline this long after their slot ends. */
const ALARM_SHOWN_MS = 60 * 60_000;

export function cacheFrom(
  result: CheckResult,
  person: string,
  now: Date,
  pid: number | null,
): StatuslineCache {
  return {
    schema: "selfhost.statusline/v1",
    written_at: now.toISOString(),
    pid,
    person,
    today: { day: now.toISOString().slice(0, 10), usd: Math.round(result.today_usd * 1e6) / 1e6 },
    warnings: result.forecasts.flatMap((forecast) =>
      forecast.windows
        .filter((window) => window.status === "warn" || window.status === "reached")
        .map((window) => ({
          plan: forecast.plan,
          window: window.window,
          status: window.status as "warn" | "reached",
          run_out: window.run_out,
          window_end: window.end,
          fix: shortSuggestion(forecast.suggestion),
        })),
    ),
    alarms: result.alarms
      .filter(({ alarm }) => alarm.series.person === person || alarm.series.person === null)
      .map(({ alarm }) => ({
        slot_start: alarm.slot_start,
        slot_end: alarm.slot_end,
        usd: alarm.usd,
        on: seriesText(alarm),
      })),
  };
}

export function readCache(path: string): StatuslineCache | undefined {
  try {
    const cache = JSON.parse(readFileSync(path, "utf8")) as StatuslineCache;
    return cache?.schema === "selfhost.statusline/v1" ? cache : undefined;
  } catch {
    return undefined;
  }
}

/** Written to a temporary file and renamed, so a reader never sees half of it. */
export function writeCache(path: string, cache: StatuslineCache): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Fresh enough to print: kept up by a live watcher, or written in the last few minutes. */
export function isUsable(cache: StatuslineCache | undefined, now: Date): cache is StatuslineCache {
  if (!cache) return false;
  if (isAlive(cache.pid)) return true;
  return now.getTime() - Date.parse(cache.written_at) <= CACHE_TTL_MS;
}

const WINDOW_SHORT: Record<LimitWindow, string> = { session: "5h", weekly: "weekly" };

/**
 * One short line: a spike alarm from the last hour, else a limit about to run out, else the
 * person's spend today. `review` is the pending review count, like "3 to review": it leads the
 * line, after an alarm.
 */
export function renderStatusline(cache: StatuslineCache, now: Date, review?: string): string {
  const ms = now.getTime();
  const alarm = cache.alarms
    .filter((candidate) => Date.parse(candidate.slot_end) + ALARM_SHOWN_MS > ms)
    .sort((a, b) => b.usd - a.usd)[0];
  if (alarm) {
    const line = `selfhost: possible stolen key, ${usd(alarm.usd)} in 15 min on ${alarm.on}`;
    return review ? `${line} · ${review}` : line;
  }
  const warning = cache.warnings
    .filter((candidate) => candidate.window_end !== null && Date.parse(candidate.window_end) > ms)
    .sort((a, b) => (a.run_out ?? "").localeCompare(b.run_out ?? ""))[0];
  if (warning) {
    const name = `${PLAN_NAMES[warning.plan]} ${WINDOW_SHORT[warning.window]} limit`;
    const runOut = warning.run_out ? Date.parse(warning.run_out) : undefined;
    const when =
      warning.status === "reached" || (runOut !== undefined && runOut <= ms)
        ? `${name} reached, resets in ${duration(Date.parse(warning.window_end ?? "") - ms)}`
        : `${name} in ~${duration((runOut ?? ms) - ms)}`;
    return [review, when, warning.fix].filter(Boolean).join(" · ");
  }
  const today = cache.today.day === now.toISOString().slice(0, 10) ? cache.today.usd : 0;
  return review ? `${review} · ${usd(today)} today` : `selfhost: ${usd(today)} today`;
}
