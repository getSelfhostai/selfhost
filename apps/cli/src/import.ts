import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { resolve as resolvePath } from "node:path";
import {
  type ImportOptions,
  importAll,
  type LedgerWriter,
  type SkippedLines,
  type Vendor,
  watchLogs,
} from "@selfhost/importers";
import { isPostgresUrl, type Ledger, openLedger, resolveDataDir } from "@selfhost/ledger";
import { scrub } from "@selfhost/notify";
import type { LedgerEvent } from "@selfhost/schema";
import { startMonitor } from "./alerts/monitor.js";
import { defaultConfigPath } from "./config-file.js";
import { plural } from "./format.js";
import { drainSpool, type SpoolReport, watchSpool } from "./hooks/drain.js";
import { spoolDir } from "./hooks/receive.js";
import { refreshGrants } from "./inbox/grants.js";
import { type OpenLocalReviewList, watchInbox } from "./inbox/sync.js";
import { type LaptopNotifyReport, notifyOnLaptop } from "./notify/laptop.js";
import { describeManaged } from "./policy/managed.js";
import { feedDir, startFeed } from "./tail/feed.js";
import type { Fetch } from "./team/client.js";
import { type Membership, readMembership, readSyncState } from "./team/config.js";
import type { LaptopIo } from "./team/laptop.js";
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
  /**
   * Print the hook spool's ledger events as JSON lines instead of writing them anywhere, and keep
   * the spool. A background run reads them from its sandbox this way, so its tool calls are mapped
   * by the same code as on a laptop.
   */
  hookEvents?: boolean;
}

/** `selfhost import --json`. */
export interface ImportReport {
  schema: "selfhost.import/v1";
  files: number;
  accepted: number;
  duplicates: number;
  /** Log files with lines that are not JSON the importer reads, skipped, with counts. */
  skipped: SkippedLines[];
  /** Where the events went: "Postgres (DATABASE_URL)" or the embedded ledger folder. */
  ledger: string;
  /** Hook events from `selfhost hook`, drained from the spool. */
  hooks: SpoolReport;
  /** Team mode only: what went to the team server. */
  sync?: SyncReport;
  /**
   * Solo mode only, when there was any: budget alerts this machine's spend raised against
   * [budget] in selfhost.toml, and what was sent through the apprise command (selfhost notify).
   */
  notify?: LaptopNotifyReport;
  /**
   * Ids of the one-time exceptions approved since the last run, now usable once by this
   * machine's agents. Solo mode reads the local review list; team mode the server (sync.grants).
   */
  grants?: string[];
}

/** One line per batch from `selfhost import --watch --json`. */
export interface ImportBatchReport {
  schema: "selfhost.import_batch/v1";
  accepted: number;
}

export interface ImportIo {
  env: NodeJS.ProcessEnv;
  /** Where selfhost.toml is looked for, for [budget] and [notify]. Default: process.cwd(). */
  cwd?: string;
  write: (line: string) => void;
  now?: Date;
  /** Where the team membership is kept. Default: ~/.selfhost/config.json. */
  configPath?: string;
  /** Used only in team mode, and only for the joined server. Default: the global fetch. */
  fetch?: Fetch;
  /** Retry timing for sends to the team server. */
  retry?: Omit<RemoteWriterOptions, "person">;
  /** Solo mode's review list, which `--watch` keeps the saved inbox copy from. */
  localReviewList?: OpenLocalReviewList;
  /** In team mode, installs the managed settings and sends heartbeats on sync. */
  laptop?: LaptopIo;
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

/**
 * The person sessions belong to: SELFHOST_PERSON, then the git email (of the repository in
 * `cwd` when given), then the OS user name.
 */
export function defaultPerson(env: NodeJS.ProcessEnv, cwd?: string): string {
  if (env.SELFHOST_PERSON) return env.SELFHOST_PERSON;
  try {
    const email = execFileSync("git", ["config", "--get", "user.email"], {
      cwd,
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

/** The local ledger keeps prompt text only with --prompts; secrets and emails are always masked. */
function openTarget(options: ImportCommandOptions, io: Pick<ImportIo, "env">): Promise<Ledger> {
  return openLedger({
    url: options.database ?? io.env.DATABASE_URL,
    dataDir: options.dataDir,
    redaction: { logPrompts: options.prompts === true, patterns: [] },
  });
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
  return teamSync(membership, configPathOf(io), io.fetch ?? globalFetch, io.retry, io.laptop);
}

const configPathOf = (io: ImportIo) => io.configPath ?? defaultConfigPath();

/** How often `selfhost import --watch` checks budgets and sends notifications on a laptop. */
const LAPTOP_NOTIFY_MS = 60_000;

/**
 * `selfhost import --hook-events`: the hook spool's events, one JSON line each, on stdout. Nothing
 * is written, the spool is kept and no server is called, so it can run again and again; the
 * events' ids are stable, so the ledger that takes them stores each once.
 */
export async function printHookEvents(
  options: ImportCommandOptions,
  io: ImportIo,
): Promise<SpoolReport> {
  const membership = readMembership(configPathOf(io));
  const opts = importOptions(options, io, membership);
  const writer: LedgerWriter = {
    async append(events: LedgerEvent[]) {
      for (const event of events) io.write(JSON.stringify(event));
      return { accepted: events.map((event) => event.id), duplicates: [] };
    },
  };
  return drainSpool(writer, options.spoolDir ?? spoolDir(io.env), {
    person: opts.actorId ?? "",
    logPrompts: opts.logPrompts,
    now: io.now,
    keep: true,
  });
}

/**
 * Imports local session logs into the ledger once. In team mode it then syncs: the events go
 * to the team server too, and the team policy comes back. Solo mode makes no network request
 * itself; only the apprise command does, for a person who added notification targets.
 * Pass a ledger to reuse an open one.
 */
export async function runImport(
  options: ImportCommandOptions,
  io: ImportIo,
  ledger?: Ledger,
): Promise<ImportReport> {
  const membership = readMembership(configPathOf(io));
  const opts = importOptions(options, io, membership);
  const target = ledger ?? (await openTarget(options, io));
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
    } else {
      const open = io.localReviewList;
      let list: Awaited<ReturnType<OpenLocalReviewList>> | undefined;
      if (open) {
        const grants = await refreshGrants(
          configPathOf(io),
          async (id) => {
            list ??= await open(target);
            return list.get(id);
          },
          io.now ?? new Date(),
        );
        if (grants) report.grants = grants.issued.map((grant) => grant.id);
      }
      const notify = await laptopNotify(target, opts.actorId ?? defaultPerson(io.env), io, {
        refresh: open
          ? async () => {
              list ??= await open(target);
            }
          : undefined,
      });
      if (describeNotify(notify).length > 0) report.notify = notify;
    }
    if (options.json) {
      io.write(options.watch ? JSON.stringify(report) : JSON.stringify(report, null, 2));
    } else {
      io.write(
        `Imported ${result.accepted} new events from ${result.files} log files ` +
          `(${result.duplicates} already in the ledger).`,
      );
      for (const line of describeSkipped(result.skipped)) io.write(line);
      if (hooks.lines > 0) {
        const repeated =
          hooks.repeated > 0
            ? `, ${plural(hooks.repeated, "line")} from a second hook entry for the same call skipped`
            : "";
        io.write(
          `Imported ${hooks.accepted} new hook events from the spool (${hooks.duplicates} already ` +
            `in the ledger, ${hooks.malformed} malformed lines skipped${repeated}).`,
        );
      }
      io.write(`Ledger: ${report.ledger}`);
      if (report.sync) for (const line of describeSync(report.sync)) io.write(line);
      if (report.notify) for (const line of describeNotify(report.notify)) io.write(line);
      const granted = report.grants?.length ?? report.sync?.grants ?? 0;
      if (granted > 0) {
        io.write(
          `${plural(granted, "approved exception")} ready: each lets its blocked call through once.`,
        );
      }
    }
    return report;
  } finally {
    if (!ledger) await target.close();
  }
}

/** Budget alerts and sends on a laptop; a failure here never fails the import. */
async function laptopNotify(
  ledger: Ledger,
  person: string,
  io: ImportIo,
  options: { refresh?: () => Promise<unknown> },
): Promise<LaptopNotifyReport> {
  try {
    return await notifyOnLaptop(ledger, person, {
      env: io.env,
      cwd: io.cwd ?? process.cwd(),
      ...(io.now ? { now: io.now } : {}),
      ...(options.refresh ? { refresh: options.refresh } : {}),
    });
  } catch (error) {
    const reason = scrub(error instanceof Error ? error.message : String(error));
    return { budget_alerts: [], sent: 0, failed: 0, skipped: `Notifications failed: ${reason}` };
  }
}

/** A warning per log file with lines the importer could not read. */
export function describeSkipped(skipped: readonly SkippedLines[]): string[] {
  return skipped.map((file) =>
    file.skipped === file.lines
      ? `Warning: none of the ${plural(file.lines, "line")} in ${file.file} is JSON the importer reads; all skipped. Is it an agent session log?`
      : `Warning: ${file.skipped} of ${plural(file.lines, "line")} in ${file.file} are not JSON the importer reads; skipped.`,
  );
}

function describeNotify(notify: LaptopNotifyReport): string[] {
  return [
    ...notify.budget_alerts.map((message) => `Budget alert: ${message}`),
    ...(notify.sent + notify.failed > 0
      ? [`Notifications: ${notify.sent} sent, ${notify.failed} failed.`]
      : []),
    ...(notify.skipped ? [notify.skipped] : []),
  ];
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
  const repos = (sync.context_repos ?? []).map((repo) =>
    repo.error
      ? `The team's context changed, but ${repo.root} was not compiled again: ${repo.error}`
      : `The team's context changed: compiled ${repo.root} again (${repo.changed} files changed).`,
  );
  const laptop = sync.laptop;
  const managed = [
    // Quiet on the usual sync, when every file was already in place.
    ...(laptop?.managed?.files.some((file) => file.status !== "current")
      ? describeManaged(laptop.managed)
      : []),
    ...(laptop?.managed_error ? [`Managed settings not installed: ${laptop.managed_error}`] : []),
  ];
  return [`${what} ${where}: ${counts}${policy}.`, ...repos, ...managed];
}

/** Imports once, then keeps tailing the logs until interrupted. */
export async function runWatch(options: ImportCommandOptions, io: ImportIo): Promise<void> {
  const ledger = await openTarget(options, io);
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
  // Limit forecasts, spend alarms and the statusline cache, checked as batches land.
  const monitor = await startMonitor(ledger, {
    person: opts.actorId ?? defaultPerson(io.env),
    json: options.json,
    write: io.write,
    env: io.env,
    configPath: configPathOf(io),
  });
  // The live feed selfhost tail follows, so it never opens the ledger this process holds. It
  // sits under the monitor, so the alerts the monitor raises reach it too.
  const url = options.database ?? io.env.DATABASE_URL;
  const feed = startFeed(feedDir(io.env, configPathOf(io)), {
    warn: io.write,
    ...(url && isPostgresUrl(url)
      ? {}
      : { dataDir: resolvePath(resolveDataDir(options.dataDir, io.env)) }),
  });
  writer = monitor.tap(feed.tap(writer));
  // The saved inbox copy the statusline counts from, and the inbox queue sent on reconnect.
  const inbox = await watchInbox(ledger, {
    membership,
    person: opts.actorId ?? defaultPerson(io.env),
    configPath: configPathOf(io),
    fetch: io.fetch ?? globalFetch,
    localReviewList: io.localReviewList,
    write: io.write,
    json: options.json,
  });
  // Budget alerts and notifications on a laptop, at most once a minute as batches land.
  let notifiedAt = Date.now();
  let notifying: Promise<void> | undefined;
  let skipped: string | undefined = first.notify?.skipped;
  const notifyLaptop = () => {
    if (membership || notifying || Date.now() - notifiedAt < LAPTOP_NOTIFY_MS) return;
    notifiedAt = Date.now();
    notifying = laptopNotify(ledger, opts.actorId ?? defaultPerson(io.env), io, {})
      .then((notify) => {
        if (options.json) {
          if (notify.budget_alerts.length > 0 || notify.sent + notify.failed > 0) {
            io.write(JSON.stringify({ schema: "selfhost.notify_batch/v1", ...notify }));
          }
          return;
        }
        const lines = describeNotify({ ...notify, skipped: undefined });
        if (notify.skipped && notify.skipped !== skipped) lines.push(notify.skipped);
        skipped = notify.skipped;
        for (const line of lines) io.write(line);
      })
      .finally(() => {
        notifying = undefined;
      });
  };
  const onBatch = (n: number) => {
    synced();
    monitor.check();
    inbox?.refresh();
    notifyLaptop();
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
  await notifying;
  await monitor.close();
  await inbox?.close();
  feed.close();
  await ledger.close();
}
