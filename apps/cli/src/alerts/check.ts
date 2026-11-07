import type { LedgerEvent } from "@selfhost/schema";
import {
  detectSpikes,
  FORECAST_HISTORY_DAYS,
  forecastLimits,
  type PlanForecast,
  type SpikeAlarm,
  utcDay,
  type WindowForecast,
} from "@selfhost/spend";
import { forecastAlert, spikeAlert } from "./events.js";
import type { AlertSettings, Tiers } from "./settings.js";
import { DEFAULT_RUNBOOK_URL } from "./text.js";

const DAY_MS = 86_400_000;

/** Days of events a check reads: the forecast's history or the spike baseline, whichever is longer. */
export const historyDays = (settings: AlertSettings) =>
  Math.max(FORECAST_HISTORY_DAYS, settings.alerts.spike_baseline_days + 1);

export interface Warning {
  forecast: PlanForecast;
  window: WindowForecast;
  event: LedgerEvent;
}

export interface Alarm {
  alarm: SpikeAlarm;
  event: LedgerEvent;
}

export interface CheckResult {
  forecasts: PlanForecast[];
  /** Windows forecast to run out inside the warning window, one alert event each. */
  warnings: Warning[];
  alarms: Alarm[];
  /** The person's spend today (UTC), every agent. */
  today_usd: number;
}

export interface CheckOptions {
  person: string;
  now: Date;
  /** Spike alarms cover the slots from this time to now. */
  since: Date;
  settings: AlertSettings;
  tiers: Tiers;
}

export const forecastOptions = (settings: AlertSettings, tiers: Tiers, now: Date) => ({
  now,
  tiers,
  limits: settings.limits,
  warnHours: settings.alerts.forecast_warn_hours,
  ...(settings.overflow ? { overflow: settings.overflow } : {}),
});

export function spikeOptions(settings: AlertSettings, now: Date, since: Date) {
  return {
    now,
    since,
    factor: settings.alerts.spike_factor,
    floorUsd: settings.alerts.spike_floor_usd,
    baselineDays: settings.alerts.spike_baseline_days,
  };
}

export const runbookUrl = (settings: AlertSettings) =>
  settings.alerts.runbook_url ?? DEFAULT_RUNBOOK_URL;

export function warningsOf(forecasts: readonly PlanForecast[], now: Date): Warning[] {
  return forecasts.flatMap((forecast) =>
    forecast.windows
      .filter((window) => window.status === "warn")
      .map((window) => ({ forecast, window, event: forecastAlert(forecast, window, now) })),
  );
}

/**
 * The limit forecast for one person and the spike alarms for every series, over events that
 * already went through oneSourcePerSession. Pure apart from the clock in `now`.
 */
export function check(events: readonly LedgerEvent[], opts: CheckOptions): CheckResult {
  const { now, settings } = opts;
  const forecasts = forecastLimits(events, opts.person, forecastOptions(settings, opts.tiers, now));
  const alarms = detectSpikes(events, spikeOptions(settings, now, opts.since)).map((alarm) => ({
    alarm,
    event: spikeAlert(alarm, now, runbookUrl(settings)),
  }));
  const today = utcDay(now);
  let todayUsd = 0;
  for (const event of events) {
    if (event.kind !== "cost.recorded" || !event.cost) continue;
    if (event.actor.kind !== "person" || event.actor.id !== opts.person) continue;
    const ms = Date.parse(event.ts);
    if (utcDay(event.ts) === today && ms <= now.getTime()) todayUsd += event.cost.usd;
  }
  return { forecasts, warnings: warningsOf(forecasts, now), alarms, today_usd: todayUsd };
}

/** Start of the history a check needs. */
export const historyStart = (settings: AlertSettings, now: Date) =>
  new Date(now.getTime() - historyDays(settings) * DAY_MS);
