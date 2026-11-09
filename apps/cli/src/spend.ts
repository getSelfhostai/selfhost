import { readFileSync } from "node:fs";
import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  type LedgerEvent,
  parseConfig,
  RUNTIME_LEFTOVER_MINUTES,
  type SandboxWasteResponse,
  validateConfig,
} from "@selfhost/schema";
import {
  type CacheStats,
  cacheByGroup,
  cacheTips,
  cacheTipText,
  detectWaste,
  groupKey,
  groupSpend,
  oneSourcePerSession,
  SPEND_DIMENSIONS,
  type SpendDimension,
  type SpendTotals,
  sandboxWaste,
  sessionCaches,
  totalSpend,
  utcDay,
  type WasteFlag,
} from "@selfhost/spend";
import type { Command } from "commander";
import { type AlertSettings, loadAlertSettings } from "./alerts/settings.js";
import { defaultConfigPath } from "./config-file.js";
import { findConfig } from "./find-config.js";
import { percent, table, tokens, usd } from "./format.js";
import { parseSince } from "./import.js";

export interface SpendCommandOptions {
  since?: string;
  by?: string;
  threshold?: string;
  minUsd?: string;
  json?: boolean;
  database?: string;
  dataDir?: string;
  config?: string;
}

interface Io {
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  now?: Date;
  /** Where selfhost.toml is looked for, for [alerts]. Without configPath the defaults apply. */
  cwd?: string;
  configPath?: string;
}

/** A group's or the total's prompt cache hit rate: null when no session reported cache tokens. */
export interface SpendCache {
  cache_hit_rate: number | null;
  /** Requests of sessions that reported no cache tokens, left out of the rate. */
  cache_unknown_requests: number;
}

/** A session that cost at least [alerts] cache_tip_usd at a hit rate under cache_hit_floor. */
export interface CacheTip {
  session_id: string;
  agent: string;
  person: string;
  model: string;
  usd: number;
  cache_hit_rate: number;
  requests: number;
  text: string;
}

export interface SpendReport {
  /** First and last UTC day covered. */
  from: string;
  to: string;
  by: SpendDimension[];
  /** Share of a day's spend, 0 to 1, that flags a request type. */
  threshold: number;
  min_usd: number;
  total: SpendTotals & SpendCache;
  groups: (SpendTotals &
    SpendCache & { group: Partial<Record<SpendDimension, string>>; share: number })[];
  flags: WasteFlag[];
  /** [alerts] cache_hit_floor and cache_tip_usd, and the sessions they flag. */
  cache_hit_floor: number;
  cache_tip_usd: number;
  cache_tips: CacheTip[];
  /**
   * Sandbox cost of background runs: idle share per runtime for 7 and 30 days, sandboxes left
   * running past their run, and each run's sandbox cost next to its model cost.
   */
  sandboxes: SandboxWasteResponse;
}

const PAGE = 1000;

export function parseBy(value: string | undefined): SpendDimension[] {
  const names = (value ?? "request_type")
    .split(",")
    .map((name) => name.trim().toLowerCase().replace("-", "_"))
    .filter((name) => name !== "");
  const unknown = names.filter((name) => !(SPEND_DIMENSIONS as readonly string[]).includes(name));
  if (names.length === 0 || unknown.length > 0) {
    throw new Error(
      `--by: expected a comma-separated list of ${SPEND_DIMENSIONS.join(", ")}, got "${value}"`,
    );
  }
  return [...new Set(names)] as SpendDimension[];
}

/** A percentage of daily spend, like 10 or 12.5, as a share between 0 and 1. */
export function parseThreshold(value: string | undefined): number {
  const percent = Number(value ?? "10");
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new Error(`--threshold: expected a percentage above 0 and up to 100, got "${value}"`);
  }
  return percent / 100;
}

function parseMinUsd(value: string | undefined): number {
  const usd = Number(value ?? "0");
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`--min-usd: expected an amount of 0 or more, got "${value}"`);
  }
  return usd;
}

async function eventsOf(ledger: Ledger, kind: string, from: Date): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await ledger.query({ kind, from: from.toISOString(), limit: PAGE, cursor });
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return events;
}

const costEvents = (ledger: Ledger, from: Date) => eventsOf(ledger, "cost.recorded", from);

/** Sandbox events and the events that end runs, for the sandbox waste report's 30 days. */
const SANDBOX_KINDS = ["sandbox.started", "sandbox.stopped", "session.ended", "alert.raised"];
const SANDBOX_DAYS = 30;

async function sandboxEvents(ledger: Ledger, now: Date): Promise<LedgerEvent[]> {
  const from = new Date(now.getTime() - SANDBOX_DAYS * 86_400_000);
  const lists = await Promise.all(SANDBOX_KINDS.map((kind) => eventsOf(ledger, kind, from)));
  return lists.flat();
}

const cacheOf = (stats: CacheStats | undefined): SpendCache => ({
  cache_hit_rate: stats?.hit_rate ?? null,
  cache_unknown_requests: stats?.unknown_requests ?? 0,
});

const cacheText = (rate: number | null) => (rate === null ? "unknown" : percent(rate));

/** Cost tips printed at most; --json lists them all. */
const TIPS_SHOWN = 3;

/** [alerts] from selfhost.toml; the defaults when the caller gives no config path (tests). */
function alertSettings(options: SpendCommandOptions, io: Io): AlertSettings["alerts"] {
  if (!io.configPath && !options.config) return DEFAULT_ALERTS;
  const where = { cwd: io.cwd ?? process.cwd(), env: io.env, configPath: io.configPath ?? "" };
  return loadAlertSettings(where, options.config, false).alerts;
}

/** [runtime] leftover_minutes from selfhost.toml, else the default. */
function runtimeLeftoverMinutes(options: SpendCommandOptions, io: Io): number {
  if (!io.configPath && !options.config) return RUNTIME_LEFTOVER_MINUTES;
  try {
    const path = findConfig(io.cwd ?? process.cwd(), options.config, io.env)?.path;
    const parsed = path ? parseConfig(readFileSync(path, "utf8")) : undefined;
    return (parsed?.ok && parsed.config.runtime?.leftover_minutes) || RUNTIME_LEFTOVER_MINUTES;
  } catch {
    return RUNTIME_LEFTOVER_MINUTES;
  }
}

const DEFAULT_ALERTS = (() => {
  const result = validateConfig({ version: 1 });
  if (!result.ok) throw new Error("the default selfhost.toml does not validate");
  return result.config.alerts;
})();

/** The sandbox part of the report: printed only when the ledger has sandboxes. */
function printSandboxes(waste: SandboxWasteResponse, write: (line: string) => void): void {
  const month = waste.windows.find((window) => window.days === 30);
  if (!month || month.by_runtime.length === 0) return;
  write("");
  write("Sandboxes of background runs: idle is billed time with no command running");
  table(
    [
      ["runtime", "window", "sandboxes", "cost", "idle", "idle share"],
      ...waste.windows.flatMap((window) =>
        window.by_runtime.map((row) => [
          row.runtime,
          `${window.days}d`,
          String(row.sandboxes),
          usd(row.billed_usd),
          usd(row.idle_usd),
          percent(row.idle_share),
        ]),
      ),
    ],
    write,
    4,
  );
  const week = waste.windows.find((window) => window.days === 7);
  for (const row of week?.by_runtime ?? []) {
    if (row.suggestion) write(`Cost tip: ${row.suggestion.text}`);
  }
  if (waste.leftovers.length > 0) {
    write("");
    write(`Left running more than ${waste.leftover_minutes} minutes after their run:`);
    for (const left of waste.leftovers) {
      write(
        `  ${left.runtime} ${left.sandbox_id}  run ${left.run_id ?? "unknown"}  ${left.minutes_after_run} min after it ended  ${usd(left.after_run_usd)} of ${usd(left.cost_usd)}${left.stopped_at === null ? ", still running" : ""}`,
      );
    }
    if (waste.leftovers.some((left) => left.stopped_at === null)) {
      write("  selfhost runtime reap stops the ones still running.");
    }
  }
}

function printReport(report: SpendReport, write: (line: string) => void): void {
  write(`Spend from ${report.from} to ${report.to} (UTC days), by ${report.by.join(", ")}`);
  if (report.total.requests === 0) {
    write("No cost.recorded events in this window. Run selfhost import first.");
    printSandboxes(report.sandboxes, write);
    return;
  }
  table(
    [
      [...report.by, "requests", "tokens", "usd", "share", "cache hits"],
      ...report.groups.map((group) => [
        ...report.by.map((dimension) => group.group[dimension] ?? ""),
        String(group.requests),
        tokens(group.tokens),
        usd(group.usd),
        percent(group.share),
        cacheText(group.cache_hit_rate),
      ]),
      [
        "total",
        ...report.by.slice(1).map(() => ""),
        String(report.total.requests),
        tokens(report.total.tokens),
        usd(report.total.usd),
        "100.0%",
        cacheText(report.total.cache_hit_rate),
      ],
    ],
    write,
    5,
  );
  write("");
  for (const tip of report.cache_tips.slice(0, TIPS_SHOWN)) write(`Cost tip: ${tip.text}`);
  if (report.cache_tips.length > TIPS_SHOWN) {
    write(`  and ${report.cache_tips.length - TIPS_SHOWN} more in --json.`);
  }
  if (report.cache_tips.length > 0) write("");
  const rule = `${percent(report.threshold)} of a day's spend`;
  if (report.flags.length === 0) {
    write(`No request type crossed ${rule}.`);
    printSandboxes(report.sandboxes, write);
    return;
  }
  write(`Flagged: request types that crossed ${rule}`);
  for (const flag of report.flags) {
    const before = flag.previous_share === null ? "first day" : `${percent(flag.previous_share)}`;
    const trend = flag.trend.map((point) => percent(point.share)).join(" ");
    write(
      `  ${flag.day}  ${flag.request_type}  ${percent(flag.share)} of ${usd(flag.day_usd)} ` +
        `(${usd(flag.usd)}), previous day with spend ${before}` +
        (trend ? `, trend ${trend}` : ""),
    );
  }
  printSandboxes(report.sandboxes, write);
}

/** Groups the ledger's cost.recorded events and flags request types that crossed the threshold. */
export async function runSpend(
  options: SpendCommandOptions,
  io: Io,
  ledger?: Ledger,
): Promise<SpendReport> {
  const now = io.now ?? new Date();
  const since = parseSince(options.since ?? "7d", now) ?? now;
  const by = parseBy(options.by);
  const threshold = parseThreshold(options.threshold);
  const minUsd = parseMinUsd(options.minUsd);
  const alerts = alertSettings(options, io);
  const target =
    ledger ??
    (await openLedger({ url: options.database ?? io.env.DATABASE_URL, dataDir: options.dataDir }));
  try {
    const events = oneSourcePerSession(await costEvents(target, since));
    const range = { from: since, to: now };
    const series = groupSpend(events, { by, ...range });
    const byType = by.includes("request_type")
      ? series
      : groupSpend(events, { by: ["request_type"], ...range });
    const { total, groups } = totalSpend(series);
    const inRange = events.filter((event) => {
      const day = utcDay(event.ts);
      return day !== undefined && day >= (utcDay(since) ?? "") && day <= (utcDay(now) ?? "");
    });
    const cache = cacheByGroup(inRange, by);
    const floor = alerts.cache_hit_floor ?? 0.5;
    const tipUsd = alerts.cache_tip_usd ?? 5;
    const report: SpendReport = {
      from: utcDay(since) ?? "",
      to: utcDay(now) ?? "",
      by,
      threshold,
      min_usd: minUsd,
      total: { ...total, ...cacheOf(cache.total) },
      groups: groups.map((group) => ({
        ...group,
        ...cacheOf(cache.groups.get(groupKey(group.group, by))),
      })),
      flags: detectWaste(byType, { shareThreshold: threshold, minUsd }),
      cache_hit_floor: floor,
      cache_tip_usd: tipUsd,
      cache_tips: cacheTips(sessionCaches(inRange), { floor, minUsd: tipUsd }).map((session) => ({
        session_id: session.session_id,
        agent: session.agent,
        person: session.person,
        model: session.model,
        usd: Math.round(session.usd * 1e6) / 1e6,
        cache_hit_rate: session.hit_rate ?? 0,
        requests: session.requests,
        text: cacheTipText(session),
      })),
      sandboxes: sandboxWaste([...(await sandboxEvents(target, now)), ...events], {
        now,
        leftoverMinutes: runtimeLeftoverMinutes(options, io),
      }),
    };
    if (options.json) io.write(JSON.stringify(report, null, 2));
    else printReport(report, io.write);
    return report;
  } finally {
    if (!ledger) await target.close();
  }
}

export function registerSpend(program: Command): void {
  program
    .command("spend")
    .description(
      "spend by request type, agent, model or person, with cache hit rates and request types that grew",
    )
    .option("--since <when>", "how far back to read, like 7d, 12h or a date", "7d")
    .option("--by <dimensions>", "request_type, agent, model, person (comma-separated)")
    .option("--threshold <percent>", "flag a request type at this share of a day's spend", "10")
    .option("--min-usd <usd>", "ignore request types that cost less than this on the day", "0")
    .option("--json", "print the report as JSON")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option("-c, --config <path>", "path to selfhost.toml, for the [alerts] cache settings")
    .action(async (options: SpendCommandOptions) => {
      const io = {
        env: process.env,
        write: (line: string) => console.log(line),
        configPath: defaultConfigPath(),
      };
      try {
        await runSpend(options, io);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
