import { readFileSync } from "node:fs";
import { type Ledger, type RetentionResult, retentionSweep } from "@selfhost/ledger";
import { formatConfigError, parseConfig, type ResolvedSelfhostConfig } from "@selfhost/schema";

export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The server's defaults: the selfhost.toml at SELFHOST_CONFIG when set, else the built-in
 * defaults. Its [ledger] and [[redaction]] cover events with no team or whose team has no stored
 * policy; a team's own policy covers that team's events.
 */
export function serverConfig(env: NodeJS.ProcessEnv = process.env): ResolvedSelfhostConfig {
  const path = env.SELFHOST_CONFIG?.trim();
  const result = parseConfig(path ? readFileSync(path, "utf8") : "version = 1\n");
  if (result.ok) return result.config;
  const lines = result.errors.map((error) => `  ${formatConfigError(error, path)}`);
  throw new Error([`SELFHOST_CONFIG ${path} is invalid:`, ...lines].join("\n"));
}

export interface RetentionJobOptions {
  /** Retention for events with no team or whose team has no stored policy. */
  days: number;
  /** Default: once a day. */
  intervalMs?: number;
  /** Where the job reports. Default: console.log. */
  log?: (line: string) => void;
  now?: () => Date;
}

export interface RetentionJob {
  /** One sweep now. undefined when it failed; the failure is logged. */
  run(): Promise<RetentionResult | undefined>;
  stop(): void;
}

/**
 * Sweeps expired events now and then every intervalMs. A sweep still running when the next is
 * due is not started twice, the timer never keeps the process alive, and the log says how many
 * events went, never what they held.
 */
export function startRetentionJob(ledger: Ledger, options: RetentionJobOptions): RetentionJob {
  const { days, intervalMs = RETENTION_INTERVAL_MS, log = console.log } = options;
  const now = options.now ?? (() => new Date());
  let running: Promise<RetentionResult | undefined> | undefined;
  const run = () => {
    running ??= retentionSweep(ledger, days, now())
      .then(
        (result) => {
          if (result.deleted > 0) log(`retention: deleted ${result.deleted} expired events`);
          return result;
        },
        (error: unknown) => {
          log(`retention: sweep failed: ${error instanceof Error ? error.message : error}`);
          return undefined;
        },
      )
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  void run();
  return { run, stop: () => clearInterval(timer) };
}
