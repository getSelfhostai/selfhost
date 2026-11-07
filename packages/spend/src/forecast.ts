import type { LedgerEvent } from "@selfhost/schema";
import {
  BUILT_IN_LIMITS,
  HOUR_MS,
  type LimitHit,
  type LimitSource,
  type LimitWindow,
  limitHits,
  PLANS,
  type Plan,
  planOf,
  SESSION_WINDOW_MS,
  tableLimit,
  WEEK_MS,
} from "./plans.js";
import { keyOf } from "./spike.js";

export const DEFAULT_WARN_HOURS = 24;
/** Usage the weekly projection replays: the same hours of the week, over the last 7 days. */
export const PROFILE_DAYS = 7;
/** Limit hits older than this no longer calibrate a limit: vendors change limits often. */
export const CALIBRATION_DAYS = 28;
/** Hits a calibrated limit is the median of, newest first. */
export const CALIBRATION_HITS = 3;
/** Days of events a forecast reads: calibration hits plus the week before the oldest one. */
export const FORECAST_HISTORY_DAYS = CALIBRATION_DAYS + 7;
/** Weeks start on Monday 00:00 UTC unless a weekly limit hit says when the week resets. */
export const DEFAULT_WEEK_ANCHOR = Date.UTC(2026, 0, 5);
/** The session burn rate looks back an hour, and never less than half an hour. */
const BURN_MAX_MS = HOUR_MS;
const BURN_MIN_MS = HOUR_MS / 2;
/** Length of the quietest stretch of the day the fix suggests. */
const QUIET_HOURS = 4;
/** USD sums in a different order differ in the last bits: within this they are equal. */
const EPSILON = 1e-9;

export type ForecastStatus = "reached" | "warn" | "ok" | "idle" | "unknown";

export type LimitBasis = "calibrated" | "table" | "none";

export interface WindowForecast {
  window: LimitWindow;
  /** Bounds of the running window; null when no session window is running. */
  start: string | null;
  end: string | null;
  /** API-equivalent USD used in the window so far. */
  usage_usd: number;
  limit_usd: number | null;
  /** calibrated: from the person's own limit hits; table: from the tier they set; none. */
  basis: LimitBasis;
  basis_label: string;
  /**
   * USD per hour the projection uses: the last hour's burn for the session window, and the
   * average of the same hours last week over the rest of the week for the weekly window.
   */
  rate_usd_per_hour: number;
  /** Usage at the end of the window if nothing runs out. */
  projected_usd: number;
  /** When the limit runs out inside this window, or ran out; null when it lasts. */
  run_out: string | null;
  status: ForecastStatus;
}

export type Suggestion =
  | { kind: "overflow"; key: string; left_usd: number; cap_usd: number }
  | {
      kind: "quiet_hours";
      /** UTC hours of the day, end exclusive; 22 to 2 wraps past midnight. */
      from_hour: number;
      to_hour: number;
      /** When the window that runs out resets. */
      resets_at: string | null;
    };

export interface PlanForecast {
  person: string;
  plan: Plan;
  tier: string | null;
  /** Earliest run-out across the two windows, this week; null when the plan lasts. */
  run_out: string | null;
  run_out_window: LimitWindow | null;
  /** The most urgent window status. */
  status: ForecastStatus;
  windows: WindowForecast[];
  /** A fix, when a window warns or has reached its limit. */
  suggestion: Suggestion | null;
  /** Limit hits in the logs for this person and plan in the last CALIBRATION_DAYS. */
  hits: number;
}

export interface ForecastOptions {
  now: Date;
  /** Tier each person set for each plan. */
  tiers?: Partial<Record<Plan, string>>;
  /** Limit tables, first match wins. Default: the built-in table. */
  limits?: readonly LimitSource[];
  /** Warn when a limit runs out within this many hours. Default 24. */
  warnHours?: number;
  /** The team's API key to suggest when a limit is about to run out. */
  overflow?: { key: string; monthly_cap_usd: number };
}

interface Point {
  ms: number;
  usd: number;
}

interface Block {
  start: number;
  end: number;
}

const STATUS_ORDER: ForecastStatus[] = ["reached", "warn", "ok", "idle", "unknown"];

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Usage that counts toward a person's plan: their cost.recorded events from the plan's agent.
 * Gateway traffic is billed to an API key, not the subscription, so it is left out.
 */
function planPoints(events: readonly LedgerEvent[], person: string, plan: Plan): Point[] {
  const points: Point[] = [];
  for (const event of events) {
    if (event.kind !== "cost.recorded" || !event.cost || event.source === "gateway") continue;
    if (event.actor.kind !== "person" || event.actor.id !== person || planOf(event) !== plan) {
      continue;
    }
    const ms = Date.parse(event.ts);
    if (Number.isFinite(ms)) points.push({ ms, usd: event.cost.usd });
  }
  return points.sort((a, b) => a.ms - b.ms);
}

/**
 * Five-hour session windows, as ccusage models them: a window starts at the hour of the first
 * request after the previous one ended.
 */
function sessionBlocks(points: readonly Point[]): Block[] {
  const blocks: Block[] = [];
  for (const point of points) {
    const last = blocks.at(-1);
    if (last && point.ms < last.end) continue;
    const start = Math.floor(point.ms / HOUR_MS) * HOUR_MS;
    blocks.push({ start, end: start + SESSION_WINDOW_MS });
  }
  return blocks;
}

const blockAt = (blocks: readonly Block[], ms: number) =>
  blocks.find((block) => block.start <= ms && ms < block.end);

function weekAt(ms: number, anchor: number): Block {
  const start = anchor + Math.floor((ms - anchor) / WEEK_MS) * WEEK_MS;
  return { start, end: start + WEEK_MS };
}

/** USD of points with from <= ms <= to. */
function sumBetween(points: readonly Point[], from: number, to: number): number {
  let usd = 0;
  for (const point of points) if (point.ms >= from && point.ms <= to) usd += point.usd;
  return usd;
}

/** When cumulative usage from `from` first reached `limit`, or undefined. */
function crossing(points: readonly Point[], from: number, to: number, limit: number) {
  let usd = 0;
  for (const point of points) {
    if (point.ms < from || point.ms > to) continue;
    usd += point.usd;
    if (usd >= limit - EPSILON) return point.ms;
  }
  return undefined;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const hourOfWeek = (ms: number) => Math.floor(ms / HOUR_MS) % (7 * 24);

/** USD per hour of the week over the PROFILE_DAYS before now. */
function weekProfile(points: readonly Point[], now: number): number[] {
  const profile = new Array<number>(7 * 24).fill(0);
  const from = now - PROFILE_DAYS * 24 * HOUR_MS;
  for (const point of points) {
    if (point.ms < from || point.ms >= now) continue;
    const hour = hourOfWeek(point.ms);
    profile[hour] = (profile[hour] ?? 0) + point.usd;
  }
  return profile;
}

/** The QUIET_HOURS-long stretch of the day (UTC) with the least usage, earliest on a tie. */
function quietHours(profile: readonly number[]): { from_hour: number; to_hour: number } {
  const byHour = new Array<number>(24).fill(0);
  profile.forEach((usd, hour) => {
    const of = hour % 24;
    byHour[of] = (byHour[of] ?? 0) + usd;
  });
  let best = 0;
  let bestUsd = Number.POSITIVE_INFINITY;
  for (let start = 0; start < 24; start++) {
    let usd = 0;
    for (let offset = 0; offset < QUIET_HOURS; offset++) usd += byHour[(start + offset) % 24] ?? 0;
    if (usd < bestUsd - 1e-9) {
      best = start;
      bestUsd = usd;
    }
  }
  return { from_hour: best, to_hour: (best + QUIET_HOURS) % 24 };
}

interface ResolvedLimit {
  usd: number | null;
  basis: LimitBasis;
  label: string;
}

/**
 * The person's own limit when the logs show them hitting it: the median, over their latest
 * hits, of the usage in the window up to each hit. Otherwise the tier they set, from the tables.
 */
function resolveLimit(
  window: LimitWindow,
  plan: Plan,
  tier: string | undefined,
  hits: readonly LimitHit[],
  points: readonly Point[],
  blocks: readonly Block[],
  anchor: number,
  sources: readonly LimitSource[],
): ResolvedLimit {
  const estimates: { usd: number; ts: string }[] = [];
  for (const hit of [...hits].reverse()) {
    if (hit.window !== window || estimates.length >= CALIBRATION_HITS) continue;
    const ms = Date.parse(hit.ts);
    const span = window === "session" ? blockAt(blocks, ms) : weekAt(ms, anchor);
    const usd = span ? sumBetween(points, span.start, ms) : 0;
    if (usd > 0) estimates.push({ usd, ts: hit.ts });
  }
  if (estimates.length > 0) {
    const latest = estimates[0]?.ts.slice(0, 10);
    const count = estimates.length === 1 ? "1 limit hit" : `${estimates.length} limit hits`;
    return {
      usd: median(estimates.map((estimate) => estimate.usd)),
      basis: "calibrated",
      label: `calibrated from ${count} in the logs, latest ${latest}`,
    };
  }
  if (tier) {
    const found = tableLimit(plan, tier, window, sources);
    if (found) return { usd: found.usd, basis: "table", label: `${tier}, ${found.label}` };
    return { usd: null, basis: "none", label: `no ${window} limit for tier ${tier}` };
  }
  return { usd: null, basis: "none", label: "no tier set and no limit hit in the logs" };
}

function statusOf(
  limit: number | null,
  usage: number,
  runOut: number | undefined,
  now: number,
  warnMs: number,
): ForecastStatus {
  if (limit === null) return "unknown";
  if (usage >= limit - EPSILON) return "reached";
  if (runOut !== undefined && runOut - now <= warnMs) return "warn";
  return "ok";
}

function sessionForecast(
  points: readonly Point[],
  blocks: readonly Block[],
  limit: ResolvedLimit,
  now: number,
  warnMs: number,
): WindowForecast {
  const block = blockAt(blocks, now);
  const base = {
    window: "session" as const,
    limit_usd: limit.usd,
    basis: limit.basis,
    basis_label: limit.label,
  };
  if (!block) {
    return {
      ...base,
      start: null,
      end: null,
      usage_usd: 0,
      rate_usd_per_hour: 0,
      projected_usd: 0,
      run_out: null,
      status: limit.usd === null ? "unknown" : "idle",
    };
  }
  const usage = sumBetween(points, block.start, now);
  const span = Math.min(BURN_MAX_MS, Math.max(BURN_MIN_MS, now - block.start));
  const rate = sumBetween(points, Math.max(block.start, now - span + 1), now) / span;
  let runOut: number | undefined;
  if (limit.usd !== null) {
    runOut =
      usage >= limit.usd - EPSILON
        ? crossing(points, block.start, now, limit.usd)
        : rate > 0
          ? now + (limit.usd - usage) / rate
          : undefined;
    if (runOut !== undefined && runOut >= block.end) runOut = undefined;
  }
  return {
    ...base,
    start: iso(block.start),
    end: iso(block.end),
    usage_usd: usage,
    rate_usd_per_hour: rate * HOUR_MS,
    projected_usd: usage + rate * (block.end - now),
    run_out: runOut === undefined ? null : iso(runOut),
    status: statusOf(limit.usd, usage, runOut, now, warnMs),
  };
}

function weeklyForecast(
  points: readonly Point[],
  profile: readonly number[],
  limit: ResolvedLimit,
  anchor: number,
  now: number,
  warnMs: number,
): WindowForecast {
  const week = weekAt(now, anchor);
  const usage = sumBetween(points, week.start, now);
  let runOut: number | undefined;
  if (limit.usd !== null && usage >= limit.usd - EPSILON) {
    runOut = crossing(points, week.start, now, limit.usd);
  }
  // Replay the same hours of last week over the rest of this one.
  let projected = usage;
  for (let t = now; t < week.end; ) {
    const next = Math.min((Math.floor(t / HOUR_MS) + 1) * HOUR_MS, week.end);
    const perMs = (profile[hourOfWeek(t)] ?? 0) / HOUR_MS;
    const add = perMs * (next - t);
    if (
      runOut === undefined &&
      limit.usd !== null &&
      perMs > 0 &&
      projected + add >= limit.usd - EPSILON
    ) {
      runOut = Math.min(next, t + (limit.usd - projected) / perMs);
    }
    projected += add;
    t = next;
  }
  const hoursLeft = (week.end - now) / HOUR_MS;
  return {
    window: "weekly",
    start: iso(week.start),
    end: iso(week.end),
    usage_usd: usage,
    limit_usd: limit.usd,
    basis: limit.basis,
    basis_label: limit.label,
    rate_usd_per_hour: hoursLeft > 0 ? (projected - usage) / hoursLeft : 0,
    projected_usd: projected,
    run_out: runOut === undefined ? null : iso(runOut),
    status: statusOf(limit.usd, usage, runOut, now, warnMs),
  };
}

/** API-equivalent USD spent this calendar month (UTC) on a key, from gateway events. */
export function keySpendThisMonth(events: readonly LedgerEvent[], key: string, now: Date): number {
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  let usd = 0;
  for (const event of events) {
    if (event.kind !== "cost.recorded" || !event.cost) continue;
    const of = keyOf(event);
    if (of !== key && !of?.endsWith(`:${key}`)) continue;
    const ms = Date.parse(event.ts);
    if (ms >= monthStart && ms <= now.getTime()) usd += event.cost.usd;
  }
  return usd;
}

function suggest(
  events: readonly LedgerEvent[],
  windows: readonly WindowForecast[],
  profile: readonly number[],
  opts: ForecastOptions,
): Suggestion | null {
  const urgent = windows.find((w) => w.status === "reached" || w.status === "warn");
  if (!urgent) return null;
  if (opts.overflow) {
    const cap = opts.overflow.monthly_cap_usd;
    const left = cap - keySpendThisMonth(events, opts.overflow.key, opts.now);
    if (left > 0) return { kind: "overflow", key: opts.overflow.key, left_usd: left, cap_usd: cap };
  }
  return { kind: "quiet_hours", ...quietHours(profile), resets_at: urgent.end };
}

/** People with plan usage in the PROFILE_DAYS before now, sorted. */
export function forecastPeople(events: Iterable<LedgerEvent>, now: Date): string[] {
  const from = now.getTime() - PROFILE_DAYS * 24 * HOUR_MS;
  const people = new Set<string>();
  for (const event of events) {
    if (event.kind !== "cost.recorded" || event.actor.kind !== "person" || !planOf(event)) continue;
    const ms = Date.parse(event.ts);
    if (ms >= from && ms <= now.getTime()) people.add(event.actor.id);
  }
  return [...people].sort();
}

/**
 * When each of a person's plans (Claude and Codex) runs out this week, from their own usage in
 * the ledger. The 5-hour session window projects the last hour's burn rate to the end of the
 * running window; the weekly window replays the same hours of the last 7 days to the end of the
 * week. Limits come from the person's own limit hits when the logs show any, else from the
 * tier they set. Pure: the same events and options give the same forecast.
 */
export function forecastLimits(
  events: Iterable<LedgerEvent>,
  person: string,
  opts: ForecastOptions,
): PlanForecast[] {
  const list = [...events];
  const now = opts.now.getTime();
  const warnMs = (opts.warnHours ?? DEFAULT_WARN_HOURS) * HOUR_MS;
  const sources = opts.limits ?? [BUILT_IN_LIMITS];
  const calibrateFrom = now - CALIBRATION_DAYS * 24 * HOUR_MS;
  const allHits = limitHits(list).filter((hit) => {
    const ms = Date.parse(hit.ts);
    return hit.person === person && ms >= calibrateFrom && ms <= now;
  });
  return PLANS.map((plan) => {
    const points = planPoints(list, person, plan);
    const hits = allHits.filter((hit) => hit.plan === plan);
    const weeklyReset = hits.findLast((hit) => hit.window === "weekly" && hit.resets_at);
    const anchor = weeklyReset?.resets_at ? Date.parse(weeklyReset.resets_at) : DEFAULT_WEEK_ANCHOR;
    const blocks = sessionBlocks(points);
    const profile = weekProfile(points, now);
    const tier = opts.tiers?.[plan];
    const limit = (window: LimitWindow) =>
      resolveLimit(window, plan, tier, hits, points, blocks, anchor, sources);
    const windows = [
      sessionForecast(points, blocks, limit("session"), now, warnMs),
      weeklyForecast(points, profile, limit("weekly"), anchor, now, warnMs),
    ];
    const first = windows
      .filter((window) => window.run_out !== null)
      .sort((a, b) => (a.run_out ?? "").localeCompare(b.run_out ?? ""))[0];
    const status =
      STATUS_ORDER.find((candidate) => windows.some((window) => window.status === candidate)) ??
      "unknown";
    return {
      person,
      plan,
      tier: tier ?? null,
      run_out: first?.run_out ?? null,
      run_out_window: first?.window ?? null,
      status,
      windows,
      suggestion: suggest(list, windows, profile, opts),
      hits: hits.length,
    };
  });
}
