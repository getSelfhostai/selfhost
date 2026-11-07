import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  forecastLimits,
  forecastPeople,
  knownTiers,
  oneSourcePerSession,
  PLANS,
  type PlanForecast,
  tableLimit,
} from "@selfhost/spend";
import { table, usd } from "../format.js";
import { forecastOptions, historyStart, warningsOf } from "./check.js";
import { localPerson } from "./person.js";
import {
  type AlertIo,
  checkTiers,
  effectiveTiers,
  type LedgerOptions,
  loadAlertSettings,
  parsePlanTiers,
  readEvents,
  readTiers,
  saveTiers,
  type Tiers,
} from "./settings.js";
import {
  clock,
  PLAN_NAMES,
  suggestionText,
  WINDOW_NAMES,
  warningText,
  whenFromNow,
} from "./text.js";

export interface ForecastCommandOptions extends LedgerOptions {
  person?: string;
  /** claude=max_5x,codex=plus: tiers for this run, on top of the saved ones. */
  plan?: string;
  warnHours?: string;
  config?: string;
  json?: boolean;
}

/** `selfhost spend forecast --json`. */
export interface ForecastReport {
  schema: "selfhost.limit_forecast/v1";
  now: string;
  /** Plans each person used in the last 7 days, or set a tier for. */
  forecasts: PlanForecast[];
  /** limit_forecast alert events written by this run; reruns in the same window write none. */
  written: number;
}

function parseWarnHours(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`--warn-hours: expected a number of hours above 0, got "${value}"`);
  }
  return hours;
}

/** A plan worth showing: used in the last week, a tier set, or a limit hit seen. */
const relevant = (forecast: PlanForecast) =>
  forecast.tier !== null ||
  forecast.hits > 0 ||
  forecast.windows.some((window) => window.usage_usd > 0 || window.projected_usd > 0);

function printForecast(report: ForecastReport, write: (line: string) => void): void {
  const now = new Date(report.now);
  if (report.forecasts.length === 0) {
    write("No Claude Code or Codex usage in the last 7 days. Run selfhost import first.");
    return;
  }
  for (const person of [...new Set(report.forecasts.map((forecast) => forecast.person))]) {
    write(`Plan limits for ${person}, ${report.now.slice(0, 16).replace("T", " ")} UTC`);
    const forecasts = report.forecasts.filter((forecast) => forecast.person === person);
    const rows = forecasts.flatMap((forecast) =>
      forecast.windows.map((window) => [
        PLAN_NAMES[forecast.plan],
        WINDOW_NAMES[window.window],
        window.status === "idle" ? "idle" : usd(window.usage_usd),
        window.limit_usd === null ? "-" : usd(window.limit_usd),
        window.run_out
          ? window.status === "reached"
            ? `reached ${clock(window.run_out, now)}`
            : whenFromNow(window.run_out, now)
          : window.status === "idle" || window.limit_usd === null
            ? "-"
            : window.window === "weekly"
              ? "not this week"
              : "not this window",
        window.basis_label,
      ]),
    );
    table([["plan", "window", "used", "limit", "runs out", "basis"], ...rows], write);
    for (const forecast of forecasts) {
      for (const window of forecast.windows) {
        if (window.status !== "warn" && window.status !== "reached") continue;
        write("");
        write(
          `${window.status === "warn" ? "Warning" : "Reached"}: ${warningText(forecast, window, now)}`,
        );
        if (forecast.suggestion) write(`  Fix: ${suggestionText(forecast.suggestion, now)}`);
      }
    }
    write("");
  }
  write(
    "Usage is API-equivalent USD from local logs. Set your tier with selfhost spend plan claude=<tier>.",
  );
}

/**
 * Forecasts when each person's Claude and Codex plans run out this week and records one
 * limit_forecast alert per window that is about to. Reads usage from the ledger only: no
 * vendor login, token or credential file is opened.
 */
export async function runForecast(
  options: ForecastCommandOptions,
  io: AlertIo,
  ledger?: Ledger,
): Promise<ForecastReport> {
  const now = io.now ?? new Date();
  const settings = loadAlertSettings(io, options.config, true);
  const warnHours = parseWarnHours(options.warnHours);
  if (warnHours !== undefined)
    settings.alerts = { ...settings.alerts, forecast_warn_hours: warnHours };
  const flag = parsePlanTiers(options.plan);
  checkTiers(flag, settings.limits);
  const me = localPerson(options.person, io);
  const target =
    ledger ??
    (await openLedger({ url: options.database ?? io.env.DATABASE_URL, dataDir: options.dataDir }));
  try {
    const from = historyStart(settings, now);
    const events = oneSourcePerSession([
      ...(await readEvents(target, "cost.recorded", from)),
      ...(await readEvents(target, "alert.raised", from)),
    ]);
    const saved = readTiers(io.configPath);
    const people = options.person
      ? [options.person]
      : [
          ...new Set([
            ...forecastPeople(events, now),
            ...(Object.keys(saved).length > 0 ? [me] : []),
          ]),
        ].sort();
    const forecasts = people.flatMap((person) => {
      const tiers = effectiveTiers(person === me ? saved : {}, flag);
      return forecastLimits(events, person, forecastOptions(settings, tiers, now)).filter(relevant);
    });
    const warnings = warningsOf(forecasts, now);
    const written =
      warnings.length > 0
        ? (await target.append(warnings.map((warning) => warning.event))).accepted.length
        : 0;
    const report: ForecastReport = {
      schema: "selfhost.limit_forecast/v1",
      now: now.toISOString(),
      forecasts,
      written,
    };
    if (options.json) io.write(JSON.stringify(report, null, 2));
    else printForecast(report, io.write);
    return report;
  } finally {
    if (!ledger) await target.close();
  }
}

export interface PlanCommandOptions {
  config?: string;
  json?: boolean;
}

/** `selfhost spend plan --json`. */
export interface PlanReport {
  schema: "selfhost.plan_tiers/v1";
  tiers: Tiers;
  /** Every tier the tables know, with its limits and where they come from. */
  table: {
    plan: string;
    tier: string;
    session_usd: number | null;
    weekly_usd: number | null;
    source: string;
  }[];
}

/**
 * Shows or sets the person's own plan tiers, kept in ~/.selfhost/config.json. Nothing is read
 * from the vendors' login or credential files: the person says which plan they are on.
 */
export function runPlan(
  assignments: string[],
  options: PlanCommandOptions,
  io: AlertIo,
): PlanReport {
  const settings = loadAlertSettings(io, options.config, true);
  const update = parsePlanTiers(assignments);
  checkTiers(update, settings.limits);
  const tiers =
    Object.keys(update).length > 0 ? saveTiers(io.configPath, update) : readTiers(io.configPath);
  const rows = PLANS.flatMap((plan) =>
    knownTiers(plan, settings.limits).map((tier) => {
      const session = tableLimit(plan, tier, "session", settings.limits);
      const weekly = tableLimit(plan, tier, "weekly", settings.limits);
      return {
        plan,
        tier,
        session_usd: session?.usd ?? null,
        weekly_usd: weekly?.usd ?? null,
        source: [...new Set([session?.label, weekly?.label].filter(Boolean))].join("; "),
      };
    }),
  );
  const report: PlanReport = { schema: "selfhost.plan_tiers/v1", tiers, table: rows };
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return report;
  }
  for (const plan of PLANS) {
    io.write(`${PLAN_NAMES[plan]}: ${tiers[plan] ?? "not set"}`);
  }
  io.write("");
  table(
    [
      ["plan", "tier", "5-hour", "weekly", "from"],
      ...rows.map((row) => [
        row.plan,
        row.tier,
        row.session_usd === null ? "-" : usd(row.session_usd),
        row.weekly_usd === null ? "-" : usd(row.weekly_usd),
        row.source,
      ]),
    ],
    io.write,
  );
  io.write("");
  io.write(
    "Approximate API-equivalent USD per window. A limit hit in your own logs replaces these; override them in [plans] in selfhost.toml.",
  );
  return report;
}
