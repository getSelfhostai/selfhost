import { REQUEST_TYPES, type RequestType, WORK_REQUEST_TYPES } from "@selfhost/schema";
import type { SpendSeries } from "./group.js";

/**
 * Request types the detector watches by default: overhead, not the work itself (main, subagent)
 * and not spend whose source says nothing about it (unknown).
 */
export const WASTE_REQUEST_TYPES: readonly RequestType[] = REQUEST_TYPES.filter(
  (type) => !(WORK_REQUEST_TYPES as readonly string[]).includes(type) && type !== "unknown",
);

export const DEFAULT_SHARE_THRESHOLD = 0.1;
export const DEFAULT_TREND_DAYS = 7;

export interface WasteOptions {
  /** Share of a day's spend, above 0 and at most 1, that flags a request type. Default 0.1. */
  shareThreshold?: number;
  /** Least USD a request type must cost on the day to be flagged. Default 0. */
  minUsd?: number;
  /** Request types to watch. Default: WASTE_REQUEST_TYPES. */
  types?: readonly string[];
  /** Days before the flagged day included in its trend. Default 7. */
  trendDays?: number;
}

export interface TrendPoint {
  day: string;
  usd: number;
  /** Share of that day's spend, 0 when the day had none. */
  share: number;
}

export interface WasteFlag {
  /** UTC day the request type crossed the threshold. */
  day: string;
  request_type: string;
  usd: number;
  /** All spend that day. */
  day_usd: number;
  /** usd / day_usd. */
  share: number;
  /** Share on the previous day with any spend, or null when there is none in the series. */
  previous_share: number | null;
  /** The trendDays days before `day` that the series covers, oldest first. */
  trend: TrendPoint[];
}

/**
 * Flags a request type on the first day its share of that day's spend reaches the threshold
 * (costing at least minUsd), after a day with spend where it did not, or on the first day with
 * spend in the series. It is flagged again only after dropping back below. Days with no spend at
 * all do not reset a crossing. The series must be grouped by request_type; other dimensions are
 * added up.
 */
export function detectWaste(series: SpendSeries, opts: WasteOptions = {}): WasteFlag[] {
  if (!series.by.includes("request_type")) {
    throw new TypeError('detectWaste needs a series grouped by "request_type"');
  }
  const threshold = opts.shareThreshold ?? DEFAULT_SHARE_THRESHOLD;
  if (!(threshold > 0 && threshold <= 1)) {
    throw new RangeError(`shareThreshold must be above 0 and at most 1, got ${threshold}`);
  }
  const minUsd = opts.minUsd ?? 0;
  const trendDays = opts.trendDays ?? DEFAULT_TREND_DAYS;
  const types = opts.types ?? WASTE_REQUEST_TYPES;

  const dayUsd = new Map<string, number>();
  const typeUsd = new Map<string, number>();
  for (const row of series.rows) {
    dayUsd.set(row.day, (dayUsd.get(row.day) ?? 0) + row.usd);
    const key = `${row.day}\n${row.group.request_type}`;
    typeUsd.set(key, (typeUsd.get(key) ?? 0) + row.usd);
  }
  const point = (day: string, type: string): TrendPoint => {
    const total = dayUsd.get(day) ?? 0;
    const usd = typeUsd.get(`${day}\n${type}`) ?? 0;
    return { day, usd, share: total > 0 ? usd / total : 0 };
  };

  const flags: WasteFlag[] = [];
  for (const type of types) {
    let previous: number | null = null;
    let wasAbove = false;
    series.days.forEach((day, index) => {
      const total = dayUsd.get(day) ?? 0;
      if (total <= 0) return;
      const { usd, share } = point(day, type);
      const above = share >= threshold && usd > 0 && usd >= minUsd;
      if (above && !wasAbove) {
        flags.push({
          day,
          request_type: type,
          usd,
          day_usd: total,
          share,
          previous_share: previous,
          trend: series.days
            .slice(Math.max(0, index - trendDays), index)
            .map((past) => point(past, type)),
        });
      }
      previous = share;
      wasAbove = above;
    });
  }
  return flags.sort((a, b) => a.day.localeCompare(b.day) || b.share - a.share);
}
