import { pathLookup, type Which } from "@selfhost/agents";
import { databaseOf, type Ledger } from "@selfhost/ledger";
import {
  appriseCli,
  type Deliver,
  laptopDirectory,
  NO_APPRISE_NOTE,
  notifyStore,
  type RunFile,
  raiseLaptopBudgetAlerts,
  runNotify,
} from "@selfhost/notify";
import { type ResolvedSelfhostConfig, validateConfig } from "@selfhost/schema";
import { loadConfig } from "../review.js";

/** What a laptop needs to notify: where selfhost.toml is and how to find apprise. */
export interface LaptopNotifyIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform?: NodeJS.Platform;
  /** Finds the apprise command. Default: PATH. */
  which?: Which;
  /** Runs apprise; tests pass their own. */
  runFile?: RunFile;
}

/** selfhost.toml as the other solo commands find it; the defaults when it is missing or broken. */
export function laptopConfig(io: Pick<LaptopNotifyIo, "env" | "cwd">): ResolvedSelfhostConfig {
  try {
    return loadConfig(io.cwd, undefined, { ...io, write: () => {} }).config;
  } catch {
    const defaults = validateConfig({ version: 1 });
    if (!defaults.ok) throw new Error("The default selfhost.toml does not validate");
    return defaults.config;
  }
}

/** The apprise command on PATH, as a Deliver; undefined when it is not installed. */
export function laptopDeliver(io: LaptopNotifyIo): Deliver | undefined {
  const which = io.which ?? pathLookup(io.env, io.platform);
  const path = which("apprise");
  return path ? appriseCli(path, io.env, io.runFile) : undefined;
}

/** What `selfhost import` did about budgets and notifications on a laptop. */
export interface LaptopNotifyReport {
  /** Budget alerts raised by this run, from [budget] in selfhost.toml. */
  budget_alerts: string[];
  sent: number;
  failed: number;
  /** Why nothing was sent although the person has targets. */
  skipped?: string;
}

/**
 * After a solo import: raises the 50%, 80% and 100% budget alerts the laptop's own spend has
 * reached, then, when the person has targets, refreshes the review list and sends what is due
 * through the apprise command. With no apprise on PATH it sends nothing and says so; no new
 * runtime dependency is needed for the rest of selfhost.
 */
export async function notifyOnLaptop(
  ledger: Ledger,
  person: string,
  io: LaptopNotifyIo & { now?: Date; refresh?: () => Promise<unknown> },
): Promise<LaptopNotifyReport> {
  const now = io.now ?? new Date();
  const config = laptopConfig(io);
  const alerts = await raiseLaptopBudgetAlerts(ledger, config.budget, person, now);
  const report: LaptopNotifyReport = {
    budget_alerts: alerts.map((alert) => String(alert.data?.message ?? "")),
    sent: 0,
    failed: 0,
  };
  const targets = await notifyStore(databaseOf(ledger)).targets(person);
  if (targets.length === 0) return report;
  const deliver = laptopDeliver(io);
  if (!deliver) return { ...report, skipped: NO_APPRISE_NOTE };
  await io.refresh?.();
  const result = await runNotify(ledger, {
    deliver,
    directory: laptopDirectory(person, config.notify),
    now,
    solo: true,
  });
  return { ...report, ...result };
}
