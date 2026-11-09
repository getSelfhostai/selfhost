import { existsSync, readFileSync } from "node:fs";
import { type Adapter, adapterFor, type Fetch } from "@selfhost/integrations";
import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  type ConformanceReport,
  findLeftovers,
  hasKey,
  hourlyPrice,
  keyEnvs,
  type Leftover,
  openRuntime,
  providerSettings,
  type Reaped,
  RUNTIME_KINDS,
  RUNTIMES,
  type RuntimeAdapter,
  type RuntimeConfig,
  type RuntimeKind,
  reapLeftovers,
  runConformance,
} from "@selfhost/runtime";
import {
  formatConfigError,
  type LedgerEvent,
  parseConfig,
  RUNTIME_LEFTOVER_MINUTES,
} from "@selfhost/schema";
import type { Command } from "commander";
import { findConfig } from "./find-config.js";
import { table, usd } from "./format.js";

export interface RuntimeIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  setExitCode: (code: number) => void;
  now?: () => Date;
  fetch?: Fetch;
  /** Opens a runtime's adapter. Default: openRuntime with the team's key from env. */
  openAdapter?: (kind: RuntimeKind, config: RuntimeConfig) => RuntimeAdapter;
}

export interface RuntimeCommandOptions {
  config?: string;
  json?: boolean;
  conformance?: boolean;
  dryRun?: boolean;
  includeUnknown?: boolean;
  minutes?: string;
  database?: string;
  dataDir?: string;
}

const DAY_MS = 86_400_000;
/** How far back reap reads the ledger for runs and their sandboxes. */
const REAP_HISTORY_DAYS = 30;

/** selfhost.toml found from cwd (or --config); the defaults when there is none. */
function loadConfig(
  options: RuntimeCommandOptions,
  io: RuntimeIo,
): { path?: string; config: RuntimeConfig } {
  const location = findConfig(io.cwd, options.config, io.env);
  if (location && !existsSync(location.path)) throw new Error(`${location.path} does not exist`);
  const text = location ? readFileSync(location.path, "utf8") : "version = 1\n";
  const parsed = parseConfig(text);
  if (!parsed.ok) {
    const lines = parsed.errors.map((error) => `  ${formatConfigError(error, location?.path)}`);
    throw new Error([`${location?.path} is invalid. Run selfhost doctor.`, ...lines].join("\n"));
  }
  return { ...(location ? { path: location.path } : {}), config: parsed.config };
}

const allowedOf = (config: RuntimeConfig): readonly RuntimeKind[] =>
  config.runtime?.allow ?? RUNTIME_KINDS;

const defaultOf = (config: RuntimeConfig) =>
  config.runtime?.default ?? config.integrations?.runtime?.tool;

/** The runtimes worth talking to: allowed ones that have a key, or the ones named. */
function targets(config: RuntimeConfig, io: RuntimeIo, named: string[]): RuntimeKind[] {
  for (const name of named) {
    if (!(RUNTIME_KINDS as readonly string[]).includes(name)) {
      throw new Error(`Unknown runtime ${name}. Runtimes: ${RUNTIME_KINDS.join(", ")}.`);
    }
  }
  if (named.length > 0) return named as RuntimeKind[];
  return allowedOf(config).filter((kind) => hasKey(kind, providerSettings(config, kind), io.env));
}

const open = (io: RuntimeIo, kind: RuntimeKind, config: RuntimeConfig) =>
  io.openAdapter
    ? io.openAdapter(kind, config)
    : openRuntime(kind, config, { env: io.env, ...(io.fetch ? { fetch: io.fetch } : {}) });

export interface RuntimeListRow {
  runtime: RuntimeKind;
  name: string;
  allowed: boolean;
  default: boolean;
  /** The environment variables the key is read from; never the key. */
  key_env: string[];
  key_set: boolean;
  billing: string;
  /** List price per hour at the runtime's default size; null without one. */
  usd_per_hour: number | null;
  sdk: string | null;
}

/** `selfhost runtime list`: every runtime, whether policy allows it and whether it has a key. */
export function runRuntimeList(options: RuntimeCommandOptions, io: RuntimeIo) {
  const { path, config } = loadConfig(options, io);
  const allowed = allowedOf(config);
  const fallback = defaultOf(config);
  const rows: RuntimeListRow[] = RUNTIME_KINDS.map((kind) => {
    const settings = providerSettings(config, kind);
    const info = RUNTIMES[kind];
    const price = hourlyPrice(kind, info.defaultSize, { usdPerHour: settings.usd_per_hour });
    return {
      runtime: kind,
      name: info.name,
      allowed: allowed.includes(kind),
      default: fallback === kind,
      key_env: keyEnvs(kind, settings),
      key_set: hasKey(kind, settings, io.env),
      billing: info.billing,
      usd_per_hour: price === undefined ? null : Math.round(price * 1e6) / 1e6,
      sdk: info.sdk ? `${info.sdk.name}@${info.sdk.version}` : null,
    };
  });
  const report = {
    schema: "selfhost.runtimes/v1",
    source: path ?? "no selfhost.toml",
    policy: config.runtime?.policy ?? "default",
    region: config.runtime?.region ?? null,
    max_size: config.runtime?.max_size ?? null,
    runtimes: rows,
  };
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return report;
  }
  io.write(
    `Runtimes in ${report.source}: policy ${report.policy}${report.region ? `, region ${report.region}` : ""}`,
  );
  table(
    [
      ["runtime", "allowed", "key", "billing", "per hour"],
      ...rows.map((row) => [
        `${row.runtime}${row.default ? " (default)" : ""}`,
        row.allowed ? "yes" : "no",
        row.key_set ? `set (${row.key_env.join(", ")})` : `missing: ${row.key_env.join(", ")}`,
        row.billing,
        row.usd_per_hour === null ? "your rate" : usd(row.usd_per_hour),
      ]),
    ],
    io.write,
    1,
  );
  io.write("");
  io.write(
    "Per hour is the list price at each runtime's default size. Keys stay in the environment; selfhost never stores them.",
  );
  return report;
}

export interface RuntimeCheckRow {
  runtime: RuntimeKind;
  status: "connected" | "error";
  detail: string;
  conformance?: ConformanceReport;
}

/**
 * `selfhost runtime check`: each runtime's key against its API, with the call `selfhost
 * integrations check` makes. --conformance also runs the conformance suite, which starts one
 * small sandbox on the team's account and stops it.
 */
export async function runRuntimeCheck(
  names: string[],
  options: RuntimeCommandOptions,
  io: RuntimeIo,
): Promise<RuntimeCheckRow[]> {
  const { config } = loadConfig(options, io);
  const kinds = names.length > 0 ? targets(config, io, names) : allowedOf(config);
  const fetch = io.fetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
  const rows: RuntimeCheckRow[] = [];
  for (const kind of kinds) {
    const adapter = adapterFor("runtime", kind) as Adapter<"runtime"> | undefined;
    const settings = providerSettings(config, kind);
    const result = adapter
      ? await adapter.check(settings, io.env, fetch)
      : { status: "error" as const, detail: "No check for this runtime." };
    const row: RuntimeCheckRow = {
      runtime: kind,
      status: result.status === "connected" ? "connected" : "error",
      detail: result.detail,
    };
    if (options.conformance && row.status === "connected") {
      if (!options.json) {
        io.write(
          `Running the conformance suite on ${RUNTIMES[kind].name}: one small sandbox, stopped at the end.`,
        );
      }
      row.conformance = await runConformance(open(io, kind, config), {
        log: options.json ? undefined : (line) => io.write(`  ${line}`),
      });
      if (!row.conformance.ok) row.status = "error";
    }
    rows.push(row);
  }
  if (options.json)
    io.write(JSON.stringify({ schema: "selfhost.runtime_reach/v1", runtimes: rows }, null, 2));
  else {
    if (rows.length === 0) io.write("No runtime is allowed in [runtime] allow.");
    for (const row of rows) {
      io.write(`${row.runtime}: ${row.status}. ${row.detail}`);
      if (row.conformance) {
        const failed = row.conformance.checks.filter((check) => check.status === "fail");
        io.write(
          failed.length === 0
            ? `  conformance: every check passed.`
            : `  conformance: ${failed.length} failed (${failed.map((check) => check.name).join(", ")}).`,
        );
      }
    }
  }
  if (rows.some((row) => row.status === "error")) io.setExitCode(1);
  return rows;
}

async function history(ledger: Ledger, from: Date): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  for (const kind of ["sandbox.started", "sandbox.stopped", "session.ended", "alert.raised"]) {
    let cursor: string | undefined;
    do {
      const page = await ledger.query({ kind, from: from.toISOString(), limit: 1000, cursor });
      events.push(...page.events);
      cursor = page.nextCursor;
    } while (cursor);
  }
  return events;
}

export interface ReapReport {
  schema: "selfhost.runtime_reap/v1";
  dry_run: boolean;
  leftover_minutes: number;
  leftovers: (Leftover & { stopped: boolean; error?: string })[];
  errors: { runtime: RuntimeKind; message: string }[];
}

/**
 * `selfhost runtime reap`: finds sandboxes selfhost made that still run after their run ended
 * (or that the ledger says stopped) on every allowed runtime with a key, and stops them. Each
 * stop is written to the ledger with its cost, and the run's owner gets a review item.
 * --dry-run only lists them. Sandboxes the ledger has no record of are only listed, unless
 * --include-unknown.
 */
export async function runRuntimeReap(
  options: RuntimeCommandOptions,
  io: RuntimeIo,
  ledger?: Ledger,
): Promise<ReapReport> {
  const now = io.now ?? (() => new Date());
  const { config } = loadConfig(options, io);
  const minutes = options.minutes
    ? Number(options.minutes)
    : (config.runtime?.leftover_minutes ?? RUNTIME_LEFTOVER_MINUTES);
  if (!Number.isInteger(minutes) || minutes < 1) {
    throw new Error(`--minutes: expected a whole number of minutes, got "${options.minutes}"`);
  }
  const target =
    ledger ??
    (await openLedger({ url: options.database ?? io.env.DATABASE_URL, dataDir: options.dataDir }));
  try {
    const adapters = targets(config, io, []).map((kind) => open(io, kind, config));
    const events = await history(target, new Date(now().getTime() - REAP_HISTORY_DAYS * DAY_MS));
    const found = await findLeftovers({ adapters, events, now: now(), leftoverMinutes: minutes });
    let reaped: Reaped[] = found.leftovers.map((leftover) => ({ leftover, stopped: false }));
    if (!options.dryRun) {
      reaped = await reapLeftovers({
        adapters,
        leftovers: found.leftovers,
        emit: async (event) => {
          await target.append([event]);
        },
        now,
        includeUnknown: options.includeUnknown === true,
        context: { source: "cli" },
      });
    }
    const report: ReapReport = {
      schema: "selfhost.runtime_reap/v1",
      dry_run: options.dryRun === true,
      leftover_minutes: minutes,
      leftovers: reaped.map((entry) => ({
        ...entry.leftover,
        stopped: entry.stopped,
        ...(entry.error ? { error: entry.error } : {}),
      })),
      errors: found.errors,
    };
    if (options.json) io.write(JSON.stringify(report, null, 2));
    else printReap(report, adapters.length, io.write);
    if (found.errors.length > 0) io.setExitCode(1);
    return report;
  } finally {
    if (!ledger) await target.close();
  }
}

function printReap(report: ReapReport, runtimes: number, write: (line: string) => void) {
  if (runtimes === 0) {
    write("No allowed runtime has a key here, so there is nothing to look at.");
    return;
  }
  for (const error of report.errors)
    write(`${error.runtime}: could not list sandboxes: ${error.message}`);
  if (report.leftovers.length === 0) {
    write(`No sandbox is running more than ${report.leftover_minutes} minutes past its run.`);
    return;
  }
  write(report.dry_run ? `Left running (dry run, nothing stopped):` : `Left running:`);
  for (const entry of report.leftovers) {
    const outcome = report.dry_run
      ? entry.reason === "unknown"
        ? "would be kept (not in the ledger)"
        : "would be stopped"
      : entry.stopped
        ? "stopped"
        : `kept: ${entry.error ?? "not stopped"}`;
    write(`  ${entry.runtime} ${entry.sandboxId}  ${usd(entry.costUsd)} so far  ${outcome}`);
    write(`    ${entry.why}`);
  }
}

export function registerRuntime(
  program: Command,
  io: () => RuntimeIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  // `selfhost runtime check` for [egress] and [secrets] may already be registered (packages/
  // credentials); then reachability and the conformance suite join it as --reach and
  // --conformance instead of a second check command.
  const runtime =
    program.commands.find((command) => command.name() === "runtime") ??
    program
      .command("runtime")
      .description("the places background agents run: E2B, Daytona, Modal, Coder, your own server");
  runtime
    .command("list")
    .description(
      "each runtime, whether [runtime] allows it, whether its key is set, its list price",
    )
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--json", "print the list as JSON")
    .action((options: RuntimeCommandOptions) => {
      try {
        runRuntimeList(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
  const existing = runtime.commands.find((command) => command.name() === "check");
  if (existing) {
    existing
      .option("--reach", "also test each runtime's key against its API")
      .option("--conformance", "also run the conformance suite: starts one small sandbox each")
      .hook("postAction", async (command) => {
        const options = command.opts() as RuntimeCommandOptions & { reach?: boolean };
        if (!options.reach && !options.conformance) return;
        const kinds = command.args.filter((name) =>
          (RUNTIME_KINDS as readonly string[]).includes(name),
        );
        try {
          await runRuntimeCheck(kinds, options, io());
        } catch (error) {
          fail(error, options.json);
        }
      });
  } else {
    runtime
      .command("check")
      .description(
        "test each allowed runtime's key against its API; --conformance also starts a sandbox",
      )
      .argument("[runtimes...]", "runtimes to check (default: every allowed one)")
      .option("-c, --config <path>", "path to selfhost.toml")
      .option("--conformance", "run the conformance suite: starts one small sandbox and stops it")
      .option("--json", "print the result as JSON")
      .action(async (names: string[], options: RuntimeCommandOptions) => {
        try {
          await runRuntimeCheck(names, options, io());
        } catch (error) {
          fail(error, options.json);
        }
      });
  }
  runtime
    .command("reap")
    .description(
      `stop sandboxes still running past the end of their run (default ${RUNTIME_LEFTOVER_MINUTES} minutes)`,
    )
    .option("--dry-run", "list them, stop nothing")
    .option("--minutes <n>", "minutes past the run's end (default: [runtime] leftover_minutes)")
    .option("--include-unknown", "also stop selfhost sandboxes the ledger has no run for")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--json", "print the result as JSON")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .action(async (options: RuntimeCommandOptions) => {
      try {
        await runRuntimeReap(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
