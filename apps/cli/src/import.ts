import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { type ImportOptions, importAll, type Vendor, watchLogs } from "@selfhost/importers";
import { isPostgresUrl, type Ledger, openLedger, resolveDataDir } from "@selfhost/ledger";

export interface ImportCommandOptions {
  since?: string;
  vendor?: string;
  watch?: boolean;
  prompts?: boolean;
  database?: string;
  dataDir?: string;
  person?: string;
  claudeDir?: string;
  codexDir?: string;
  /** Print JSON instead of text: one object, or one line per batch with --watch. */
  json?: boolean;
}

/** `selfhost import --json`. */
export interface ImportReport {
  schema: "selfhost.import/v1";
  files: number;
  accepted: number;
  duplicates: number;
  /** Where the events went: "Postgres (DATABASE_URL)" or the embedded ledger folder. */
  ledger: string;
}

/** One line per batch from `selfhost import --watch --json`. */
export interface ImportBatchReport {
  schema: "selfhost.import_batch/v1";
  accepted: number;
}

interface Io {
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  now?: Date;
}

const VENDORS: Record<string, Vendor> = {
  claude: "claude_code",
  "claude-code": "claude_code",
  claude_code: "claude_code",
  codex: "codex",
};

/** Accepts a duration like 30d or 12h, or anything Date can parse. */
export function parseSince(value: string | undefined, now = new Date()): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d+)([dh])$/.exec(value.trim());
  if (match) {
    const unitMs = match[2] === "d" ? 86_400_000 : 3_600_000;
    return new Date(now.getTime() - Number(match[1]) * unitMs);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`--since: expected a duration like 30d or 12h, or a date, got "${value}"`);
  }
  return date;
}

export function parseVendor(value: string | undefined): Vendor | undefined {
  if (!value) return undefined;
  const vendor = VENDORS[value.trim().toLowerCase()];
  if (!vendor) throw new Error(`--vendor: expected claude or codex, got "${value}"`);
  return vendor;
}

/** The person sessions belong to: --person, then the git email, then the OS user name. */
export function defaultPerson(env: NodeJS.ProcessEnv): string {
  if (env.SELFHOST_PERSON) return env.SELFHOST_PERSON;
  try {
    const email = execFileSync("git", ["config", "--get", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (email) return email;
  } catch {
    // No git or no email configured: fall back to the OS user.
  }
  return userInfo().username;
}

function importOptions(options: ImportCommandOptions, io: Io): ImportOptions {
  return {
    since: parseSince(options.since, io.now),
    vendor: parseVendor(options.vendor),
    logPrompts: options.prompts ?? false,
    actorId: options.person ?? defaultPerson(io.env),
    claudeDir: options.claudeDir,
    codexDir: options.codexDir,
  };
}

function describeTarget(options: ImportCommandOptions, io: Io): string {
  const url = options.database ?? io.env.DATABASE_URL;
  if (url && isPostgresUrl(url)) return "Postgres (DATABASE_URL)";
  return resolveDataDir(options.dataDir, io.env);
}

/** Imports local session logs into the ledger once. Pass a ledger to reuse an open one. */
export async function runImport(
  options: ImportCommandOptions,
  io: Io,
  ledger?: Ledger,
): Promise<ImportReport> {
  const opts = importOptions(options, io);
  const url = options.database ?? io.env.DATABASE_URL;
  const target = ledger ?? (await openLedger({ url, dataDir: options.dataDir }));
  try {
    const result = await importAll(target, opts);
    const report: ImportReport = {
      schema: "selfhost.import/v1",
      ...result,
      ledger: describeTarget(options, io),
    };
    if (options.json) {
      io.write(options.watch ? JSON.stringify(report) : JSON.stringify(report, null, 2));
    } else {
      io.write(
        `Imported ${result.accepted} new events from ${result.files} log files ` +
          `(${result.duplicates} already in the ledger).`,
      );
      io.write(`Ledger: ${report.ledger}`);
    }
    return report;
  } finally {
    if (!ledger) await target.close();
  }
}

/** Imports once, then keeps tailing the logs until interrupted. */
export async function runWatch(options: ImportCommandOptions, io: Io): Promise<void> {
  const url = options.database ?? io.env.DATABASE_URL;
  const ledger = await openLedger({ url, dataDir: options.dataDir });
  await runImport(options, io, ledger);
  if (!options.json) io.write("Watching for new log lines. Press Ctrl+C to stop.");
  const watcher = watchLogs(ledger, importOptions(options, io), (n) => {
    if (n === 0) return;
    const batch: ImportBatchReport = { schema: "selfhost.import_batch/v1", accepted: n };
    io.write(options.json ? JSON.stringify(batch) : `+${n} events`);
  });
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await watcher.close();
  await ledger.close();
}
