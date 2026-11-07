import { type Ledger, openLedger } from "@selfhost/ledger";
import type { LedgerEvent } from "@selfhost/schema";
import {
  detectWaste,
  groupSpend,
  oneSourcePerSession,
  SPEND_DIMENSIONS,
  type SpendDimension,
  type SpendTotals,
  totalSpend,
  utcDay,
  type WasteFlag,
} from "@selfhost/spend";
import type { Command } from "commander";
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
}

interface Io {
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  now?: Date;
}

export interface SpendReport {
  /** First and last UTC day covered. */
  from: string;
  to: string;
  by: SpendDimension[];
  /** Share of a day's spend, 0 to 1, that flags a request type. */
  threshold: number;
  min_usd: number;
  total: SpendTotals;
  groups: (SpendTotals & { group: Partial<Record<SpendDimension, string>>; share: number })[];
  flags: WasteFlag[];
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

async function costEvents(ledger: Ledger, from: Date): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await ledger.query({
      kind: "cost.recorded",
      from: from.toISOString(),
      limit: PAGE,
      cursor,
    });
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return events;
}

function printReport(report: SpendReport, write: (line: string) => void): void {
  write(`Spend from ${report.from} to ${report.to} (UTC days), by ${report.by.join(", ")}`);
  if (report.total.requests === 0) {
    write("No cost.recorded events in this window. Run selfhost import first.");
    return;
  }
  table(
    [
      [...report.by, "requests", "tokens", "usd", "share"],
      ...report.groups.map((group) => [
        ...report.by.map((dimension) => group.group[dimension] ?? ""),
        String(group.requests),
        tokens(group.tokens),
        usd(group.usd),
        percent(group.share),
      ]),
      [
        "total",
        ...report.by.slice(1).map(() => ""),
        String(report.total.requests),
        tokens(report.total.tokens),
        usd(report.total.usd),
        "100.0%",
      ],
    ],
    write,
    4,
  );
  write("");
  const rule = `${percent(report.threshold)} of a day's spend`;
  if (report.flags.length === 0) {
    write(`No request type crossed ${rule}.`);
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
    const report: SpendReport = {
      from: utcDay(since) ?? "",
      to: utcDay(now) ?? "",
      by,
      threshold,
      min_usd: minUsd,
      total,
      groups,
      flags: detectWaste(byType, { shareThreshold: threshold, minUsd }),
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
    .description("spend by request type, agent, model or person, with request types that grew")
    .option("--since <when>", "how far back to read, like 7d, 12h or a date", "7d")
    .option("--by <dimensions>", "request_type, agent, model, person (comma-separated)")
    .option("--threshold <percent>", "flag a request type at this share of a day's spend", "10")
    .option("--min-usd <usd>", "ignore request types that cost less than this on the day", "0")
    .option("--json", "print the report as JSON")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .action(async (options: SpendCommandOptions) => {
      const io = { env: process.env, write: (line: string) => console.log(line) };
      try {
        await runSpend(options, io);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
