import { type Ledger, openLedger } from "@selfhost/ledger";
import type { LedgerEvent } from "@selfhost/schema";
import { detectSpikes, oneSourcePerSession } from "@selfhost/spend";
import { usd } from "../format.js";
import { parseSince } from "../import.js";
import { runbookUrl, spikeOptions } from "./check.js";
import { spikeAlert } from "./events.js";
import { type AlertIo, type LedgerOptions, loadAlertSettings, readEvents } from "./settings.js";

/** Exit code when an alarm is raised, apart from errors (1), so scripts can page on it. */
export const ALARM_EXIT_CODE = 2;

const DAY_MS = 86_400_000;

/** Like --since elsewhere, plus minutes: 15m, 1h, 2d or a date. */
export function parseAlarmSince(value: string, now: Date): Date {
  const minutes = /^(\d+)m$/.exec(value.trim());
  if (minutes) return new Date(now.getTime() - Number(minutes[1]) * 60_000);
  return parseSince(value, now) ?? now;
}

export interface AlarmsCommandOptions extends LedgerOptions {
  since?: string;
  config?: string;
  json?: boolean;
}

/** `selfhost spend alarms --json`. */
export interface AlarmsReport {
  schema: "selfhost.spend_alarms/v1";
  /** The 15-minute slots evaluated: from the one holding `from` to the one holding `to`. */
  from: string;
  to: string;
  spike_factor: number;
  floor_usd: number;
  baseline_days: number;
  /** One alert.raised event per series and slot, as written to the ledger. */
  alarms: LedgerEvent[];
  /** Alarms this run recorded, and alarms an earlier run already had. */
  written: number;
  already_raised: number;
}

function printAlarms(report: AlarmsReport, write: (line: string) => void): void {
  const window = `${report.from.slice(0, 16).replace("T", " ")} to ${report.to.slice(11, 16)} UTC`;
  if (report.alarms.length === 0) {
    write(
      `No spend spikes from ${window}: every series stayed inside its band ` +
        `(${report.spike_factor}x its usual spend at that time of day, floor ${usd(report.floor_usd)} per 15 minutes).`,
    );
    return;
  }
  write(`SPEND ALARM: ${report.alarms.length} possible stolen key alarm(s) from ${window}`);
  for (const alarm of report.alarms) {
    write("");
    write(`  ${String(alarm.data?.message)}`);
    const actions = (alarm.data?.actions ?? []) as { label: string; url?: string }[];
    for (const action of actions)
      write(`    - ${action.label}${action.url ? `: ${action.url}` : ""}`);
  }
  write("");
  write(
    `${report.written} new, ${report.already_raised} already raised. Recorded as alert.raised in the ledger.`,
  );
}

/**
 * Evaluates the latest 15-minute slots of every key, person, agent and runtime against its own
 * baseline and records an alert.raised event per slot outside the band. Event ids depend only
 * on the series and the slot, so a rerun records nothing twice. Exits 2 when there is an alarm.
 */
export async function runAlarms(
  options: AlarmsCommandOptions,
  io: AlertIo,
  ledger?: Ledger,
): Promise<AlarmsReport> {
  const now = io.now ?? new Date();
  const since = parseAlarmSince(options.since ?? "1h", now);
  const settings = loadAlertSettings(io, options.config, true);
  const target =
    ledger ??
    (await openLedger({ url: options.database ?? io.env.DATABASE_URL, dataDir: options.dataDir }));
  try {
    const from = new Date(since.getTime() - (settings.alerts.spike_baseline_days + 1) * DAY_MS);
    const events = oneSourcePerSession(await readEvents(target, "cost.recorded", from));
    const alarms = detectSpikes(events, spikeOptions(settings, now, since)).map((alarm) =>
      spikeAlert(alarm, now, runbookUrl(settings)),
    );
    const result =
      alarms.length > 0 ? await target.append(alarms) : { accepted: [], duplicates: [] };
    const report: AlarmsReport = {
      schema: "selfhost.spend_alarms/v1",
      from: since.toISOString(),
      to: now.toISOString(),
      spike_factor: settings.alerts.spike_factor,
      floor_usd: settings.alerts.spike_floor_usd,
      baseline_days: settings.alerts.spike_baseline_days,
      alarms,
      written: result.accepted.length,
      already_raised: result.duplicates.length,
    };
    if (options.json) io.write(JSON.stringify(report, null, 2));
    else printAlarms(report, io.write);
    if (alarms.length > 0) io.setExitCode(ALARM_EXIT_CODE);
    return report;
  } finally {
    if (!ledger) await target.close();
  }
}
