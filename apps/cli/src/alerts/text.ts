import type {
  LimitWindow,
  Plan,
  PlanForecast,
  SpikeAction,
  SpikeActionId,
  SpikeAlarm,
  Suggestion,
  WindowForecast,
} from "@selfhost/spend";
import { usd } from "../format.js";

/** Default key rotation runbook, overridden by [alerts] runbook_url. */
export const DEFAULT_RUNBOOK_URL =
  "https://github.com/getselfhostai/selfhost/blob/main/packages/spend/README.md#key-rotation-runbook";

export const PLAN_NAMES: Record<Plan, string> = { claude: "Claude", codex: "Codex" };
export const WINDOW_NAMES: Record<LimitWindow, string> = { session: "5-hour", weekly: "weekly" };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "1h40m", "25m", "3d 1h". */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "13:40 UTC", with the weekday when it is not within the next day. */
export function clock(iso: string, now: Date): string {
  const date = new Date(iso);
  const time = `${iso.slice(11, 16)} UTC`;
  return Math.abs(date.getTime() - now.getTime()) < 86_400_000
    ? time
    : `${DAYS[date.getUTCDay()]} ${time}`;
}

/** "13:40 UTC (in 1h40m)". */
export const whenFromNow = (iso: string, now: Date) =>
  `${clock(iso, now)} (in ${duration(Date.parse(iso) - now.getTime())})`;

const hour = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** One sentence: what runs out when, and that it is before the window resets. */
export function warningText(forecast: PlanForecast, window: WindowForecast, now: Date): string {
  const name = `${PLAN_NAMES[forecast.plan]} ${WINDOW_NAMES[window.window]} limit`;
  const resets =
    window.end === null
      ? ""
      : window.window === "session"
        ? `the window resets at ${clock(window.end, now)}`
        : `the week resets ${clock(window.end, now)}`;
  if (window.status === "reached") {
    const at = window.run_out ? ` at ${clock(window.run_out, now)}` : "";
    return `${name} reached${at} (estimated)${resets ? `; ${resets}` : ""}.`;
  }
  const when = window.run_out ? whenFromNow(window.run_out, now) : "soon";
  return `${name} runs out around ${when}${resets ? `, before ${resets}` : ""}.`;
}

export function suggestionText(suggestion: Suggestion, now: Date): string {
  if (suggestion.kind === "overflow") {
    return (
      `Overflow to the team API key ${suggestion.key}: ${usd(suggestion.left_usd)} of its ` +
      `${usd(suggestion.cap_usd)} monthly cap left.`
    );
  }
  const after = suggestion.resets_at ? `, or after ${clock(suggestion.resets_at, now)}` : "";
  return (
    "Move background work (subagents, reviews, scheduled runs) to quieter hours, like " +
    `${hour(suggestion.from_hour)}-${hour(suggestion.to_hour)} UTC${after}.`
  );
}

/** The fix in a few words, for the statusline. */
export function shortSuggestion(suggestion: Suggestion | null): string {
  if (!suggestion) return "";
  if (suggestion.kind === "overflow") return `overflow to ${suggestion.key}`;
  return `move background work to ${hour(suggestion.from_hour).slice(0, 2)}-${hour(suggestion.to_hour).slice(0, 2)} UTC`;
}

export interface LabeledAction extends SpikeAction {
  label: string;
  url?: string;
}

const ACTION_LABELS: Record<SpikeActionId, (target: string | null) => string> = {
  rotate_key: (target) =>
    `Rotate ${target ?? "the key or login this spend used"}: open the key rotation runbook`,
  pause_runtime: (target) => `Pause runtime ${target}`,
  disable_virtual_key: (target) => `Disable virtual key ${target} in the gateway`,
};

export function labelActions(actions: readonly SpikeAction[], runbookUrl: string): LabeledAction[] {
  return actions.map((action) => ({
    ...action,
    label: ACTION_LABELS[action.id](action.target),
    ...(action.id === "rotate_key" ? { url: runbookUrl } : {}),
  }));
}

/** Who and what the spend was on: "dev@example.com, claude_code, key litellm:ci-bot". */
export function seriesText(alarm: SpikeAlarm): string {
  const { key, person, agent, runtime } = alarm.series;
  return [
    person ?? undefined,
    agent,
    key ? `key ${key}` : undefined,
    runtime ? `runtime ${runtime}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(", ");
}

export function alarmText(alarm: SpikeAlarm): string {
  const slot = `${alarm.slot_start.slice(11, 16)}-${alarm.slot_end.slice(11, 16)} UTC`;
  const usual =
    alarm.reason === "no_baseline"
      ? `a series with ${alarm.baseline.active_days} days of history (floor reached)`
      : `the usual ${usd(alarm.baseline.median)} at this time of day (band ${usd(alarm.baseline.band)})`;
  return (
    `Possible stolen key: ${usd(alarm.usd)} in 15 minutes (${slot}, ${alarm.requests} requests) ` +
    `on ${seriesText(alarm)}, against ${usual}. Not a budget warning.`
  );
}
