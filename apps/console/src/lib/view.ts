/**
 * What the console shows, kept in the address bar so a view can be bookmarked and shared:
 * the screen, the date range, the four filters (team is also the team every screen is about),
 * the breakdown and the chart metric, and the run the run view opens. The token never goes in it.
 */

export const SCREENS = [
  "overview",
  "review",
  "rules",
  "spend",
  "code",
  "run",
  "integrations",
  "team",
] as const;
export type Screen = (typeof SCREENS)[number];

export const BREAKDOWNS = ["team", "person", "agent", "model"] as const;
export type Breakdown = (typeof BREAKDOWNS)[number];

export const FILTERS = BREAKDOWNS;

export const PRESETS = ["7d", "30d", "90d", "month"] as const;
export type Preset = (typeof PRESETS)[number];

export const CHART_METRICS = ["usd", "tokens", "sessions"] as const;
export type ChartMetric = (typeof CHART_METRICS)[number];

export interface View {
  /** Absent for the overview. */
  screen?: Exclude<Screen, "overview">;
  /** The run (or session) id the run view shows. */
  run?: string;
  /** A preset, or custom with from and to. */
  range: Preset | "custom";
  /** First day, YYYY-MM-DD (UTC). Only for custom. */
  from?: string;
  /** Last day included, YYYY-MM-DD (UTC). Only for custom. */
  to?: string;
  filters: Partial<Record<Breakdown, string>>;
  breakdown?: Breakdown;
  metric: ChartMetric;
  /** Org for the admin token. */
  org?: string;
}

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const isOneOf = <T extends string>(list: readonly T[], value: string | null): value is T =>
  value !== null && (list as readonly string[]).includes(value);

export function parseView(search: string): View {
  const params = new URLSearchParams(search);
  const from = params.get("from");
  const to = params.get("to");
  const custom = from !== null && to !== null && DAY.test(from) && DAY.test(to) && from <= to;
  const range = params.get("range");
  const breakdown = params.get("view");
  const metric = params.get("metric");
  const filters: View["filters"] = {};
  for (const name of FILTERS) {
    const value = params.get(name);
    if (value) filters[name] = value;
  }
  const org = params.get("org") ?? undefined;
  const screen = params.get("screen");
  const run = params.get("run") ?? undefined;
  return {
    ...(isOneOf(SCREENS, screen) && screen !== "overview" ? { screen } : {}),
    ...(run ? { run } : {}),
    range: custom ? "custom" : isOneOf(PRESETS, range) ? range : "30d",
    ...(custom ? { from, to } : {}),
    filters,
    ...(isOneOf(BREAKDOWNS, breakdown) ? { breakdown } : {}),
    metric: isOneOf(CHART_METRICS, metric) ? metric : "usd",
    ...(org ? { org } : {}),
  };
}

export function viewSearch(view: View): string {
  const params = new URLSearchParams();
  if (view.screen) params.set("screen", view.screen);
  if (view.run) params.set("run", view.run);
  if (view.range === "custom" && view.from && view.to) {
    params.set("from", view.from);
    params.set("to", view.to);
  } else if (view.range !== "30d") params.set("range", view.range);
  for (const name of FILTERS) {
    const value = view.filters[name];
    if (value) params.set(name, value);
  }
  if (view.breakdown) params.set("view", view.breakdown);
  if (view.metric !== "usd") params.set("metric", view.metric);
  if (view.org) params.set("org", view.org);
  const text = params.toString();
  return text ? `?${text}` : "";
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The range as API times: from the start of the first UTC day to the start of the day after
 * the last, so today is always in a preset.
 */
export function rangeOf(view: View, now: Date): { from: string; to: string; days: string[] } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let first: number;
  let last: number;
  if (view.range === "custom" && view.from && view.to) {
    first = Date.parse(`${view.from}T00:00:00Z`);
    last = Date.parse(`${view.to}T00:00:00Z`);
  } else if (view.range === "month") {
    first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    last = today;
  } else {
    const days = Number.parseInt(view.range, 10) || 30;
    first = today - (days - 1) * DAY_MS;
    last = today;
  }
  const days: string[] = [];
  for (let ms = first; ms <= last; ms += DAY_MS) days.push(dayOf(ms));
  return {
    from: new Date(first).toISOString(),
    to: new Date(last + DAY_MS).toISOString(),
    days,
  };
}

/** The /v1/usage query for a view, grouped by groupBy, with or without the filters. */
export function usageQuery(
  view: View,
  now: Date,
  groupBy: string[],
  withFilters = true,
): URLSearchParams {
  const { from, to } = rangeOf(view, now);
  const params = new URLSearchParams({ from, to });
  if (groupBy.length > 0) params.set("group_by", groupBy.join(","));
  if (withFilters) {
    for (const name of FILTERS) {
      const value = view.filters[name];
      if (value) params.set(name, value);
    }
  }
  if (view.org) params.set("org", view.org);
  return params;
}
