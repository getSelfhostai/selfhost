import { existsSync, readFileSync } from "node:fs";
import { type Ledger, openLedger, retentionSweep } from "@selfhost/ledger";
import { formatConfigError, parseConfig } from "@selfhost/schema";
import type { Command } from "commander";
import { findConfig } from "./find-config.js";
import { describeTarget } from "./import.js";

export interface PruneOptions {
  days?: string;
  config?: string;
  database?: string;
  dataDir?: string;
  json?: boolean;
}

/** `selfhost ledger prune --json`. */
export interface PruneReport {
  schema: "selfhost.ledger_prune/v1";
  days: number;
  /** Where days came from: "--days", the selfhost.toml path, or "default". */
  days_from: string;
  /** Events from before this time were deleted. */
  before: string;
  deleted: number;
  /** "Postgres (DATABASE_URL)" or the embedded ledger folder. */
  ledger: string;
}

interface LedgerIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  now?: Date;
}

export function parseDays(value: string): number {
  const days = Number(value.trim());
  if (!/^\d+$/.test(value.trim()) || days < 1) {
    throw new Error(`--days: expected a whole number of 1 or more, got "${value}"`);
  }
  return days;
}

/** --days, else ledger.retention_days from the selfhost.toml `doctor` finds, else its default. */
function retentionDays(options: PruneOptions, io: LedgerIo): { days: number; from: string } {
  if (options.days !== undefined) return { days: parseDays(options.days), from: "--days" };
  const location = findConfig(io.cwd, options.config, io.env);
  const found = location && existsSync(location.path);
  if (location && !found && location.from !== "search") {
    throw new Error(`${location.path} does not exist`);
  }
  const parsed = parseConfig(found ? readFileSync(location.path, "utf8") : "version = 1\n");
  if (!parsed.ok) {
    const lines = parsed.errors.map((error) => `  ${formatConfigError(error, location?.path)}`);
    throw new Error([`${location?.path} is invalid. Run selfhost doctor.`, ...lines].join("\n"));
  }
  return { days: parsed.config.ledger.retention_days, from: found ? location.path : "default" };
}

/** Deletes ledger events older than the retention. Pass a ledger to reuse an open one. */
export async function runPrune(
  options: PruneOptions,
  io: LedgerIo,
  ledger?: Ledger,
): Promise<PruneReport> {
  const { days, from } = retentionDays(options, io);
  const target =
    ledger ??
    (await openLedger({ url: options.database ?? io.env.DATABASE_URL, dataDir: options.dataDir }));
  try {
    const result = await retentionSweep(target, days, io.now ?? new Date());
    const report: PruneReport = {
      schema: "selfhost.ledger_prune/v1",
      days,
      days_from: from,
      before: result.before,
      deleted: result.deleted,
      ledger: describeTarget(options, io),
    };
    if (options.json) {
      io.write(JSON.stringify(report, null, 2));
    } else {
      io.write(
        `Deleted ${report.deleted} events from before ${report.before} (retention ${days} days, from ${from}).`,
      );
      io.write(`Ledger: ${report.ledger}`);
    }
    return report;
  } finally {
    if (!ledger) await target.close();
  }
}

export function registerLedger(
  program: Command,
  io: () => LedgerIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const ledger = program.command("ledger").description("look after the local ledger");
  ledger
    .command("prune")
    .description("delete events older than ledger.retention_days in selfhost.toml (default 90)")
    .option("--days <n>", "keep this many days instead")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option("--json", "print JSON")
    .action(async (options: PruneOptions) => {
      try {
        await runPrune(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
