import type { LedgerEvent } from "@selfhost/schema";

export const SLOT_MS = 15 * 60_000;
export const SLOTS_PER_DAY = 96;
export const DEFAULT_SPIKE_FACTOR = 10;
export const DEFAULT_SPIKE_FLOOR_USD = 5;
export const DEFAULT_BASELINE_DAYS = 14;
/** Scaled MADs above the median the band allows, on top of spike_factor x median. */
export const DEFAULT_MAD_K = 6;
/** Slots either side of the same time of day the baseline also looks at (2 = 30 minutes). */
export const DEFAULT_SLOT_SPREAD = 2;
/** Days with spend a series needs before its baseline counts; newer series alarm at the floor. */
export const DEFAULT_MIN_ACTIVE_DAYS = 3;
/** MAD x 1.4826 estimates the standard deviation of normally distributed spend. */
const MAD_SCALE = 1.4826;

/** What a spend series is per: one key, person, agent and runtime. Null when it does not apply. */
export interface SpikeSeries {
  /** Gateway virtual key (gateway:alias) or provider API key the spend went through. */
  key: string | null;
  person: string | null;
  /** Agent vendor, "unknown" when the source does not say. */
  agent: string;
  /** Remote runtime the agent ran on, from data.runtime. */
  runtime: string | null;
}

export type SpikeActionId = "rotate_key" | "pause_runtime" | "disable_virtual_key";

export interface SpikeAction {
  id: SpikeActionId;
  /** The key or runtime the action is for, or null for whatever key the series used. */
  target: string | null;
}

export interface SpikeBaseline {
  /** Days the baseline covers. */
  days: number;
  /** Of those, days the series had any spend: only these count. */
  active_days: number;
  /** Median and median absolute deviation of the slot's spend on active days. */
  median: number;
  mad: number;
  /** Spend above this, and at or above the floor, raises an alarm. */
  band: number;
}

export interface SpikeAlarm {
  series: SpikeSeries;
  /** The 15-minute slot, ISO 8601 UTC. */
  slot_start: string;
  slot_end: string;
  usd: number;
  requests: number;
  baseline: SpikeBaseline;
  /** above_band, or no_baseline for a series with fewer than minActiveDays days of history. */
  reason: "above_band" | "no_baseline";
  actions: SpikeAction[];
}

export interface SpikeOptions {
  now: Date;
  /** Evaluate the slots from the one holding `since` to the one holding `now`. */
  since: Date;
  /** Band is at least this multiple of the baseline median. Default 10. */
  factor?: number;
  /** Spend under this many USD in a slot never alarms. Default 5. */
  floorUsd?: number;
  /** Trailing days in the baseline. Default 14. */
  baselineDays?: number;
  /** Scaled MADs above the median the band allows. Default 6. */
  madK?: number;
  /** Neighbouring slots each baseline day looks at. Default 2. */
  slotSpread?: number;
  /** Active days a series needs before its baseline counts. Default 3. */
  minActiveDays?: number;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * The API key an event's spend went through: the gateway's virtual key alias, or the provider
 * key a system actor stands for (`anthropic:api_key:<id>`, `litellm:<alias>`). Undefined for
 * a person's own login.
 */
export function keyOf(event: LedgerEvent): string | undefined {
  const alias = event.data?.key_alias;
  if (isText(alias)) {
    const gateway = event.data?.gateway;
    return `${isText(gateway) ? gateway : "gateway"}:${alias}`;
  }
  if (event.actor.kind === "system" && /(^litellm:|:api_key:)/.test(event.actor.id)) {
    return event.actor.id;
  }
  return undefined;
}

export function spikeSeriesOf(event: LedgerEvent): SpikeSeries {
  const runtime = event.data?.runtime;
  return {
    key: keyOf(event) ?? null,
    person: event.actor.kind === "person" ? event.actor.id : null,
    agent: event.agent?.vendor ?? "unknown",
    runtime: isText(runtime) ? runtime : null,
  };
}

/** Stable text id of a series, used in alarm ids and ordering. */
export function seriesId(series: SpikeSeries): string {
  return [
    `key=${series.key ?? ""}`,
    `person=${series.person ?? ""}`,
    `agent=${series.agent}`,
    `runtime=${series.runtime ?? ""}`,
  ].join("|");
}

/** The actions that apply to a series: the runbook always, the others when it has a target. */
export function spikeActions(series: SpikeSeries): SpikeAction[] {
  const actions: SpikeAction[] = [{ id: "rotate_key", target: series.key }];
  if (series.runtime) actions.push({ id: "pause_runtime", target: series.runtime });
  if (series.key?.startsWith("litellm:") || series.key?.startsWith("gateway:")) {
    actions.push({ id: "disable_virtual_key", target: series.key });
  }
  return actions;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

interface SeriesSlots {
  series: SpikeSeries;
  usd: Map<number, number>;
  requests: Map<number, number>;
}

const slotOf = (ms: number) => Math.floor(ms / SLOT_MS);

/**
 * Spend per 15 minutes for each key, person, agent and runtime, against that series' own
 * baseline at the same time of day. For each of the trailing baselineDays days with any spend
 * in the series, the baseline takes the highest slot within slotSpread of the same time of day,
 * so work that starts a little earlier or later is not a spike. The band is
 * max(factor x median, median + madK x 1.4826 x MAD); a slot above it alarms, unless it is under
 * the floor. A series with fewer than minActiveDays days of history has no baseline yet, so any
 * slot at or above the floor alarms. Pure and deterministic.
 */
export function detectSpikes(events: Iterable<LedgerEvent>, opts: SpikeOptions): SpikeAlarm[] {
  const factor = opts.factor ?? DEFAULT_SPIKE_FACTOR;
  const floor = opts.floorUsd ?? DEFAULT_SPIKE_FLOOR_USD;
  const days = opts.baselineDays ?? DEFAULT_BASELINE_DAYS;
  const madK = opts.madK ?? DEFAULT_MAD_K;
  const spread = opts.slotSpread ?? DEFAULT_SLOT_SPREAD;
  const minActive = opts.minActiveDays ?? DEFAULT_MIN_ACTIVE_DAYS;
  const lastSlot = slotOf(opts.now.getTime());
  const firstSlot = Math.min(slotOf(opts.since.getTime()), lastSlot);
  const earliest = (firstSlot - (days + 1) * SLOTS_PER_DAY) * SLOT_MS;

  const all = new Map<string, SeriesSlots>();
  for (const event of events) {
    if (event.kind !== "cost.recorded" || !event.cost) continue;
    const ms = Date.parse(event.ts);
    if (!(ms >= earliest) || ms >= (lastSlot + 1) * SLOT_MS) continue;
    const series = spikeSeriesOf(event);
    const id = seriesId(series);
    let entry = all.get(id);
    if (!entry) {
      entry = { series, usd: new Map(), requests: new Map() };
      all.set(id, entry);
    }
    const slot = slotOf(ms);
    entry.usd.set(slot, (entry.usd.get(slot) ?? 0) + event.cost.usd);
    entry.requests.set(slot, (entry.requests.get(slot) ?? 0) + 1);
  }

  const alarms: SpikeAlarm[] = [];
  for (const id of [...all.keys()].sort()) {
    const entry = all.get(id);
    if (!entry) continue;
    const at = (slot: number) => entry.usd.get(slot) ?? 0;
    for (let slot = firstSlot; slot <= lastSlot; slot++) {
      const usd = at(slot);
      if (usd <= 0 || usd < floor) continue;
      const values: number[] = [];
      for (let day = 1; day <= days; day++) {
        const same = slot - day * SLOTS_PER_DAY;
        let dayUsd = 0;
        for (let s = same + spread - SLOTS_PER_DAY + 1; s <= same + spread; s++) dayUsd += at(s);
        if (dayUsd <= 0) continue;
        let high = 0;
        for (let s = same - spread; s <= same + spread; s++) high = Math.max(high, at(s));
        values.push(high);
      }
      const mid = median(values);
      const mad = median(values.map((value) => Math.abs(value - mid)));
      const known = values.length >= minActive;
      const band = known ? Math.max(factor * mid, mid + madK * MAD_SCALE * mad) : 0;
      if (usd <= band) continue;
      alarms.push({
        series: entry.series,
        slot_start: new Date(slot * SLOT_MS).toISOString(),
        slot_end: new Date((slot + 1) * SLOT_MS).toISOString(),
        usd,
        requests: entry.requests.get(slot) ?? 0,
        baseline: { days, active_days: values.length, median: mid, mad, band },
        reason: known ? "above_band" : "no_baseline",
        actions: spikeActions(entry.series),
      });
    }
  }
  return alarms.sort(
    (a, b) =>
      a.slot_start.localeCompare(b.slot_start) ||
      b.usd - a.usd ||
      seriesId(a.series).localeCompare(seriesId(b.series)),
  );
}
