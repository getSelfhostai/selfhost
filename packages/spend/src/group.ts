import { isRequestType, type LedgerEvent } from "@selfhost/schema";

export const SPEND_DIMENSIONS = ["request_type", "agent", "model", "person"] as const;

export type SpendDimension = (typeof SPEND_DIMENSIONS)[number];

export interface SpendTotals {
  /** cost.recorded events, one per model request. */
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** The four token counts added up. */
  tokens: number;
  usd: number;
}

/** The value of each grouped dimension, for example { request_type: "status_line" }. */
export type SpendGroup = Partial<Record<SpendDimension, string>>;

export interface SpendRow extends SpendTotals {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  group: SpendGroup;
}

export interface SpendSeries {
  by: SpendDimension[];
  interval: "day";
  /** Every UTC day in the range, oldest first, including days with no spend. */
  days: string[];
  /** One row per day and group with spend, by day, then usd (highest first). */
  rows: SpendRow[];
}

export interface GroupOptions {
  by: readonly SpendDimension[];
  interval?: "day";
  /** First day to include, as a Date or an ISO date or time. Default: the first day with spend. */
  from?: Date | string;
  /** Last day to include. Default: the last day with spend. */
  to?: Date | string;
}

const DAY_MS = 86_400_000;

/** UTC day of a Date or ISO string, or undefined when it does not parse. */
export function utcDay(value: Date | string): string | undefined {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

/** Days from `first` to `last`, both included. */
export function dayRange(first: string, last: string): string[] {
  const days: string[] = [];
  for (let ms = Date.parse(first); ms <= Date.parse(last); ms += DAY_MS) {
    days.push(new Date(ms).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * The group value of an event: data.request_type (unknown when missing or not in the
 * vocabulary), agent.vendor, model, and actor.id for a person (unknown for agent or system
 * actors).
 */
export function dimensionValue(event: LedgerEvent, dimension: SpendDimension): string {
  switch (dimension) {
    case "request_type": {
      const type = event.data?.request_type;
      return isRequestType(type) ? type : "unknown";
    }
    case "agent":
      return event.agent?.vendor ?? "unknown";
    case "model":
      return event.model ?? "unknown";
    case "person":
      return event.actor.kind === "person" ? event.actor.id : "unknown";
  }
}

export function emptyTotals(): SpendTotals {
  return {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    tokens: 0,
    usd: 0,
  };
}

export function addTotals(into: SpendTotals, from: SpendTotals): void {
  into.requests += from.requests;
  into.input_tokens += from.input_tokens;
  into.output_tokens += from.output_tokens;
  into.cache_read_tokens += from.cache_read_tokens;
  into.cache_write_tokens += from.cache_write_tokens;
  into.tokens += from.tokens;
  into.usd += from.usd;
}

function eventTotals(cost: NonNullable<LedgerEvent["cost"]>): SpendTotals {
  const tokens =
    cost.input_tokens + cost.output_tokens + cost.cache_read_tokens + cost.cache_write_tokens;
  return {
    requests: 1,
    input_tokens: cost.input_tokens,
    output_tokens: cost.output_tokens,
    cache_read_tokens: cost.cache_read_tokens,
    cache_write_tokens: cost.cache_write_tokens,
    tokens,
    usd: cost.usd,
  };
}

function checkDimensions(by: readonly SpendDimension[]): SpendDimension[] {
  for (const dimension of by) {
    if (!(SPEND_DIMENSIONS as readonly string[]).includes(dimension)) {
      throw new TypeError(
        `Unknown spend dimension "${dimension}", expected ${SPEND_DIMENSIONS.join(", ")}`,
      );
    }
  }
  return [...new Set(by)];
}

/** Stable text key for a group, used to merge and order rows. */
export function groupKey(group: SpendGroup, by: readonly SpendDimension[]): string {
  return by.map((dimension) => group[dimension] ?? "").join("\u0000");
}

function boundDay(value: Date | string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const day = utcDay(value);
  if (!day) throw new TypeError(`${name}: expected a date, got "${String(value)}"`);
  return day;
}

/**
 * Tokens and USD of cost.recorded events per UTC day and group. Other event kinds are ignored.
 * Pure: the same events give the same series, in the same order.
 */
export function groupSpend(events: Iterable<LedgerEvent>, opts: GroupOptions): SpendSeries {
  if ((opts.interval ?? "day") !== "day") {
    throw new TypeError(`Unsupported interval "${opts.interval}", expected "day"`);
  }
  const by = checkDimensions(opts.by);
  const from = boundDay(opts.from, "from");
  const to = boundDay(opts.to, "to");
  const rows = new Map<string, SpendRow>();
  let first: string | undefined;
  let last: string | undefined;
  for (const event of events) {
    if (event.kind !== "cost.recorded" || !event.cost) continue;
    const day = utcDay(event.ts);
    if (!day || (from && day < from) || (to && day > to)) continue;
    const group: SpendGroup = {};
    for (const dimension of by) group[dimension] = dimensionValue(event, dimension);
    const key = `${day}\u0001${groupKey(group, by)}`;
    let row = rows.get(key);
    if (!row) {
      row = { day, group, ...emptyTotals() };
      rows.set(key, row);
    }
    addTotals(row, eventTotals(event.cost));
    if (first === undefined || day < first) first = day;
    if (last === undefined || day > last) last = day;
  }
  const start = from ?? first;
  const end = to ?? last;
  const sorted = [...rows.values()].sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      b.usd - a.usd ||
      groupKey(a.group, by).localeCompare(groupKey(b.group, by)),
  );
  return {
    by,
    interval: "day",
    days: start && end && start <= end ? dayRange(start, end) : [],
    rows: sorted,
  };
}

export interface GroupTotals extends SpendTotals {
  group: SpendGroup;
  /** Share of the series' total USD, 0 to 1. */
  share: number;
}

/** Totals over every day of a series: per group (highest USD first) and overall. */
export function totalSpend(series: SpendSeries): { total: SpendTotals; groups: GroupTotals[] } {
  const total = emptyTotals();
  const groups = new Map<string, GroupTotals>();
  for (const row of series.rows) {
    addTotals(total, row);
    const key = groupKey(row.group, series.by);
    let totals = groups.get(key);
    if (!totals) {
      totals = { group: row.group, ...emptyTotals(), share: 0 };
      groups.set(key, totals);
    }
    addTotals(totals, row);
  }
  const list = [...groups.values()];
  for (const totals of list) totals.share = total.usd > 0 ? totals.usd / total.usd : 0;
  list.sort(
    (a, b) =>
      b.usd - a.usd || groupKey(a.group, series.by).localeCompare(groupKey(b.group, series.by)),
  );
  return { total, groups: list };
}
