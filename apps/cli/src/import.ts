import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import {
  type ImportOptions,
  importAll,
  type LedgerWriter,
  type Vendor,
  watchLogs,
} from "@selfhost/importers";
import { isPostgresUrl, type Ledger, openLedger, resolveDataDir } from "@selfhost/ledger";
import { defaultConfigPath } from "./config-file.js";
import { drainSpool, type SpoolReport, watchSpool } from "./hooks/drain.js";
import { spoolDir } from "./hooks/receive.js";
import type { Fetch } from "./team/client.js";
import { type Membership, readMembership, readSyncState } from "./team/config.js";
import type { RemoteWriterOptions } from "./team/remote-writer.js";
import { markSynced, type SyncReport, syncingWriter, syncLedger, teamSync } from "./team/sync.js";

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
  /** Hook spool folder. Default: ~/.selfhost/spool. */
  spoolDir?: string;
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
  /** Hook events from `selfhost hook`, drained from the spool. */
  hooks: SpoolReport;
  /** Team mode only: what went to the team server. */
  sync?: SyncReport;
}

/** One line per batch from `selfhost import --watch --json`. */
export interface ImportBatchReport {
  schema: "selfhost.import_batch/v1";
  accepted: number;
}

export interface ImportIo {
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  now?: Date;
  /** Where the team membership is kept. Default: ~/.selfhost/config.json. */
  configPath?: string;
  /** Used only in team mode, and only for the joined server. Default: the global fetch. */
  fetch?: Fetch;
  /** Retry timing for sends to the team server. */
  retry?: Omit<RemoteWriterOptions, "person">;
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

function importOptions(
  options: ImportCommandOptions,
  io: ImportIo,
  membership: Membership | undefined,
): ImportOptions {
  return {
    since: parseSince(options.since, io.now),
    vendor: parseVendor(options.vendor),
    logPrompts: options.prompts ?? false,
    actorId: options.person ?? membership?.person ?? defaultPerson(io.env),
    claudeDir: options.claudeDir,
    codexDir: options.codexDir,
  };
}

/** Where events go: "Postgres (DATABASE_URL)" or the embedded ledger folder. */
export function describeTarget(
  options: Pick<ImportCommandOptions, "database" | "dataDir">,
  io: Pick<ImportIo, "env">,
): string {
  const url = options.database ?? io.env.DATABASE_URL;
  if (url && isPostgresUrl(url)) return "Postgres (DATABASE_URL)";
  return resolveDataDir(options.dataDir, io.env);
}

const globalFetch: Fetch = (url, init) => fetch(url, init);

function teamSyncFor(membership: Membership, io: ImportIo) {
  return teamSync(membership, configPathOf(io), io.fetch ?? globalFetch, io.retry);
}

const configPathOf = (io: ImportIo) => io.configPath ?? defaultConfigPath();

/**
 * Imports local session logs into the ledger once. In team mode it then syncs: the events go
 * to the team server too, and the team policy comes back. Solo mode makes no network request.
 * Pass a ledger to reuse an open one.
 */
export async function runImport(
  options: ImportCommandOptions,
  io: ImportIo,
  ledger?: Ledger,
): Promise<ImportReport> {
  const membership = readMembership(configPathOf(io));
  const opts = importOptions(options, io, membership);
  const url = options.database ?? io.env.DATABASE_URL;
  const target = ledger ?? (await openLedger({ url, dataDir: options.dataDir }));
  try {
    const result = await importAll(target, opts);
    const hooks = await drainSpool(target, options.spoolDir ?? spoolDir(io.env), {
      person: opts.actorId ?? "",
      logPrompts: opts.logPrompts,
      now: io.now,
    });
    const report: ImportReport = {
      schema: "selfhost.import/v1",
      ...result,
      ledger: describeTarget(options, io),
      hooks,
    };
    if (membership) {
      report.sync = await syncLedger(target, teamSyncFor(membership, io), opts.since);
    }
    if (options.json) {
      io.write(options.watch ? JSON.stringify(report) : JSON.stringify(report, null, 2));
    } else {
      io.write(
        `Imported ${result.accepted} new events from ${result.files} log files ` +
          `(${result.duplicates} already in the ledger).`,
      );
      if (hooks.lines > 0) {
        io.write(
          `Imported ${hooks.accepted} new hook events from the spool (${hooks.duplicates} already ` +
            `in the ledger, ${hooks.malformed} malformed lines skipped).`,
        );
      }
      io.write(`Ledger: ${report.ledger}`);
      if (report.sync) for (const line of describeSync(report.sync)) io.write(line);
    }
    return report;
  } finally {
    if (!ledger) await target.close();
  }
}

function describeSync(sync: SyncReport): string[] {
  const where = `team ${sync.team} on ${sync.server}`;
  if (sync.error) {
    return [
      `Sync to ${where} failed: ${sync.error}`,
      "The events are in the local ledger and go up on the next sync.",
    ];
  }
  const what = sync.history ? "Shared the local history with" : "Synced";
  const policy = sync.policy_hash ? `, team policy ${sync.policy_hash.slice(0, 12)}` : "";
  const counts = `${sync.sent} events (${sync.accepted} new, ${sync.duplicates} already there)`;
  return [`${what} ${where}: ${counts}${policy}.`];
}

/** Imports once, then keeps tailing the logs until interrupted. */
export async function runWatch(options: ImportCommandOptions, io: ImportIo): Promise<void> {
  const url = options.database ?? io.env.DATABASE_URL;
  const ledger = await openLedger({ url, dataDir: options.dataDir });
  const first = await runImport(options, io, ledger);
  if (!options.json) io.write("Watching for new log lines. Press Ctrl+C to stop.");
  const membership = readMembership(configPathOf(io));
  const opts = importOptions(options, io, membership);
  let writer: LedgerWriter = ledger;
  let synced = () => {};
  if (membership) {
    const sync = teamSyncFor(membership, io);
    // A failed first sync is retried with the next batch instead of only on the next run.
    const catchUp = first.sync?.error
      ? async () => {
          const retried = await syncLedger(ledger, sync, opts.since);
          if (retried.error) throw new Error(retried.error);
        }
      : undefined;
    writer = syncingWriter(ledger, sync.remote, catchUp);
    synced = () => markSynced(sync.configPath, readSyncState(sync.configPath, membership));
  }
  const onBatch = (n: number) => {
    synced();
    if (n === 0) return;
    const batch: ImportBatchReport = { schema: "selfhost.import_batch/v1", accepted: n };
    io.write(options.json ? JSON.stringify(batch) : `+${n} events`);
  };
  const watcher = watchLogs(writer, opts, onBatch);
  const hookWatcher = watchSpool(
    writer,
    options.spoolDir ?? spoolDir(io.env),
    { person: opts.actorId ?? "", logPrompts: opts.logPrompts },
    onBatch,
  );
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await watcher.close();
  await hookWatcher.close();
  await ledger.close();
}
