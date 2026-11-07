import { stableEventId } from "@selfhost/ledger";
import { AGENT_VENDORS, EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import {
  PLAN_AGENT,
  type PlanForecast,
  type SpikeAlarm,
  seriesId,
  type WindowForecast,
} from "@selfhost/spend";
import { alarmText, labelActions, shortSuggestion, suggestionText, warningText } from "./text.js";

/** alert.raised data.alert values selfhost writes. */
export const SPEND_SPIKE_ALERT = "spend_spike";
export const LIMIT_FORECAST_ALERT = "limit_forecast";

const SYSTEM = { kind: "system" as const, id: "selfhost" };

/**
 * One warning per person, plan and window: the id comes from the window's start, so a later
 * run in the same window gives the same id and the ledger keeps the first.
 */
export function forecastAlert(
  forecast: PlanForecast,
  window: WindowForecast,
  now: Date,
): LedgerEvent {
  const start = window.start ?? now.toISOString();
  const key = `${LIMIT_FORECAST_ALERT}:${forecast.person}:${forecast.plan}:${window.window}:${start}`;
  return {
    id: stableEventId(start, key),
    schema: EVENT_SCHEMA,
    ts: now.toISOString(),
    source: "cli",
    kind: "alert.raised",
    actor: SYSTEM,
    agent: { vendor: PLAN_AGENT[forecast.plan] },
    data: {
      alert: LIMIT_FORECAST_ALERT,
      owner: forecast.person,
      plan: forecast.plan,
      window: window.window,
      tier: forecast.tier,
      basis: window.basis,
      basis_label: window.basis_label,
      usage_usd: window.usage_usd,
      limit_usd: window.limit_usd,
      run_out: window.run_out,
      window_end: window.end,
      message: warningText(forecast, window, now),
      suggestion: forecast.suggestion ? suggestionText(forecast.suggestion, now) : null,
      fix: shortSuggestion(forecast.suggestion) || null,
    },
  };
}

/** One alarm per series and 15-minute slot, whatever the run that finds it. */
export function spikeAlert(alarm: SpikeAlarm, now: Date, runbookUrl: string): LedgerEvent {
  const key = `${SPEND_SPIKE_ALERT}:${seriesId(alarm.series)}:${alarm.slot_start}`;
  const vendor = AGENT_VENDORS.find((candidate) => candidate === alarm.series.agent);
  return {
    id: stableEventId(alarm.slot_start, key),
    schema: EVENT_SCHEMA,
    ts: now.toISOString(),
    source: "cli",
    kind: "alert.raised",
    actor: SYSTEM,
    ...(vendor ? { agent: { vendor } } : {}),
    data: {
      alert: SPEND_SPIKE_ALERT,
      label: "possible stolen key",
      category: "security",
      owner: alarm.series.person ?? alarm.series.key,
      series: alarm.series,
      slot_start: alarm.slot_start,
      slot_end: alarm.slot_end,
      usd: alarm.usd,
      requests: alarm.requests,
      baseline: alarm.baseline,
      reason: alarm.reason,
      message: alarmText(alarm),
      actions: labelActions(alarm.actions, runbookUrl),
    },
  };
}
