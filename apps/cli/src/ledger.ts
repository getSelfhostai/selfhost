import { existsSync, readFileSync } from "node:fs";
import {
  connect,
  isPostgresUrl,
  type Ledger,
  migrate,
  openLedger,
  resolveDataDir,
  retentionSweep,
  rollback,
  rowCounts,
  type SchemaStatus,
  schemaStatus,
} from "@selfhost/ledger";
import { formatConfigError, parseConfig } from "@selfhost/schema";
import type { Command } from "commander";
import { type BackupOptions, runBackup, runRestore } from "./backup.js";
import { findConfig } from "./find-config.js";
import { describeTarget } from "./import.js";
import type { Exec } from "./up/resources.js";
import { STACK_DIR } from "./up/stack.js";

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
  /** Runs ssh and scp for backup and restore with --host. */
  exec: Exec;
}

interface TargetOptions {
  database?: string;
  dataDir?: string;
  json?: boolean;
}

/** `selfhost ledger status --json`. */
export interface LedgerStatusReport extends SchemaStatus {
  schema: "selfhost.ledger_status/v1";
  ledger: string;
  /** Rows in each table, schema_migrations included. */
  rows: Record<string, number>;
}

/** `selfhost ledger migrate --json`. */
export interface LedgerMigrateReport extends SchemaStatus {
  schema: "selfhost.ledger_migrate/v1";
  ledger: string;
  rolled_back: string[];
  applied: string[];
}

/** Connects without migrating, so status and rollbacks see the schema as it is. */
async function connectTarget(options: TargetOptions, io: LedgerIo) {
  const url = options.database ?? io.env.DATABASE_URL;
  if (!(url?.trim() && isPostgresUrl(url))) {
    const dataDir = resolveDataDir(options.dataDir, io.env);
    if (!existsSync(dataDir)) throw new Error(`There is no embedded ledger at ${dataDir}`);
  }
  return connect({ url, dataDir: options.dataDir });
}

export async function runStatus(options: TargetOptions, io: LedgerIo): Promise<LedgerStatusReport> {
  const db = await connectTarget(options, io);
  try {
    const report: LedgerStatusReport = {
      schema: "selfhost.ledger_status/v1",
      ledger: describeTarget(options, io),
      ...(await schemaStatus(db)),
      rows: await rowCounts(db),
    };
    if (options.json) {
      io.write(JSON.stringify(report, null, 2));
      return report;
    }
    io.write(`Ledger: ${report.ledger}`);
    io.write(
      `Schema: ${report.current ?? "empty"}; this release knows up to ${report.latest ?? "none"}`,
    );
    if (report.pending.length > 0) io.write(`Pending: ${report.pending.join(", ")}`);
    if (report.unknown.length > 0) {
      io.write(
        `From a newer release: ${report.unknown.join(", ")}. This release refuses to run on it; roll back with the newer one.`,
      );
    }
    io.write(
      `Rows: ${Object.entries(report.rows)
        .map(([table, count]) => `${table} ${count}`)
        .join(", ")}`,
    );
    return report;
  } finally {
    await db.close();
  }
}

/** Applies pending migrations, or with --to moves the schema to that version, up or down. */
export async function runMigrate(
  options: TargetOptions & { to?: string },
  io: LedgerIo,
): Promise<LedgerMigrateReport> {
  const db = await connectTarget(options, io);
  try {
    const to = options.to;
    const rolledBack = to === undefined ? [] : await rollback(db, to);
    const applied = await migrate(db, undefined, to === undefined ? {} : { to });
    const report: LedgerMigrateReport = {
      schema: "selfhost.ledger_migrate/v1",
      ledger: describeTarget(options, io),
      ...(await schemaStatus(db)),
      rolled_back: rolledBack,
      applied,
    };
    if (options.json) {
      io.write(JSON.stringify(report, null, 2));
      return report;
    }
    if (rolledBack.length > 0) io.write(`Rolled back ${rolledBack.join(", ")}`);
    if (applied.length > 0) io.write(`Applied ${applied.join(", ")}`);
    io.write(`Schema: ${report.current ?? "empty"} (${report.ledger})`);
    return report;
  } finally {
    await db.close();
  }
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
  const ledger = program
    .command("ledger")
    .description("look after the ledger: retention, schema version, backups");
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

  const target = (command: Command) =>
    command
      .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
      .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
      .option("--json", "print JSON");

  target(
    ledger
      .command("status")
      .description("the schema version against this release's migrations, and rows per table"),
  ).action(async (options: TargetOptions) => {
    try {
      await runStatus(options, io());
    } catch (error) {
      fail(error, options.json);
    }
  });

  target(
    ledger
      .command("migrate")
      .description(
        "apply pending migrations, or move to --to <version> with the rollbacks of newer ones",
      )
      .option("--to <version>", "like 0008, or 0 for none"),
  ).action(async (options: TargetOptions & { to?: string }) => {
    try {
      await runMigrate(options, io());
    } catch (error) {
      fail(error, options.json);
    }
  });

  const remote = (command: Command) =>
    command
      .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
      .option("--host <user@host>", "a Docker Compose install on this server, over SSH")
      .option("--port <port>", "--host: ssh port")
      .option("-i, --identity <file>", "--host: private key (default: ssh-agent and ~/.ssh)")
      .option("--dir <path>", "--host: the stack folder", STACK_DIR)
      .option("--json", "print JSON");

  remote(
    ledger
      .command("backup [file]")
      .description(
        "back up the embedded ledger, or with --host a Docker Compose or selfhost up server, to a file here",
      ),
  ).action(async (file: string | undefined, options: BackupOptions) => {
    try {
      await runBackup(file, options, io());
    } catch (error) {
      fail(error, options.json);
    }
  });

  remote(
    ledger
      .command("restore <file>")
      .description("restore a backup into the embedded ledger, or with --host into that server")
      .option("--force", "replace a ledger that already holds events"),
  ).action(async (file: string, options: BackupOptions) => {
    try {
      await runRestore(file, options, io());
    } catch (error) {
      fail(error, options.json);
    }
  });
}
