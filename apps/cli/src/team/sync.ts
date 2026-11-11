import { rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LedgerWriter } from "@selfhost/importers";
import type { Ledger } from "@selfhost/ledger";
import { PAGE_LIMIT_MAX } from "@selfhost/schema";
import { compileRepos, pullContext, type RepoCompile } from "../context/layers.js";
import {
  exceptionsDir,
  hasRequests,
  hasUnreportedUses,
  pullServerGrants,
} from "../hooks/exceptions.js";
import { exceptionTrust } from "../hooks/trust.js";
import { serverGrants } from "../inbox/grants.js";
import { type Fetch, TeamClient } from "./client.js";
import {
  type Membership,
  pinExceptionKeys,
  readSyncState,
  type SyncState,
  teamPolicyPath,
  writeSyncState,
} from "./config.js";
import { type LaptopIo, type LaptopReport, machineId, reportLaptop } from "./laptop.js";
import { RemoteWriter, type RemoteWriterOptions } from "./remote-writer.js";

/** The `sync` part of `selfhost import --json` in team mode. */
export interface SyncReport {
  server: string;
  team: string;
  person: string;
  /** true when this sync sent the whole local ledger: the first sync after joining. */
  history: boolean;
  /** Events sent, and how the server counted them. */
  sent: number;
  accepted: number;
  duplicates: number;
  /** sha256 of the team's selfhost.toml pulled by this sync, null when the team has none. */
  policy_hash?: string | null;
  /** One-time exceptions people approved on the server, pulled as grants for this machine. */
  grants?: number;
  /** sha256 over the org and team context layers pulled by this sync. */
  context_hash?: string;
  /**
   * Repositories compiled again because the pulled layers changed: the ones whose context was
   * compiled with them on this machine.
   */
  context_repos?: RepoCompile[];
  /** The managed settings of the pulled policy on this laptop, and the heartbeat. */
  laptop?: LaptopReport;
  /** Why the sync stopped. The events stay in the local ledger and go up on the next sync. */
  error?: string;
}

export interface TeamSync {
  membership: Membership;
  configPath: string;
  client: TeamClient;
  remote: RemoteWriter;
  /** Installs the managed settings and sends heartbeats; without it a sync does neither. */
  laptop?: LaptopIo;
}

export function teamSync(
  membership: Membership,
  configPath: string,
  fetch: Fetch,
  options: Omit<RemoteWriterOptions, "person"> = {},
  laptop?: LaptopIo,
): TeamSync {
  const client = new TeamClient(membership.server, membership.token, fetch);
  const remote = new RemoteWriter(client, { ...options, person: membership.person });
  return { membership, configPath, client, remote, ...(laptop ? { laptop } : {}) };
}

/** Sends the local ledger, newest first a page at a time; only events at or after `from`. */
export async function pushLedger(ledger: Ledger, remote: LedgerWriter, from?: Date): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await ledger.query({ from: from?.toISOString(), limit: PAGE_LIMIT_MAX, cursor });
    if (page.events.length > 0) await remote.append(page.events);
    cursor = page.nextCursor;
  } while (cursor);
}

/**
 * Brings the server up to date with the local ledger and pulls the team policy and the org and
 * team context layers; when the layers changed, the repositories compiled with them on this
 * machine are compiled again. With a laptop, it then installs the managed settings the policy
 * compiles to and reports a heartbeat. The first sync
 * after joining sends the whole local ledger, so history from solo mode shows up on the server;
 * later ones send events from `since` on. Ids are idempotency keys, so nothing is stored twice.
 */
export async function syncLedger(
  ledger: Ledger,
  sync: TeamSync,
  since?: Date,
): Promise<SyncReport> {
  const { membership, configPath, client, remote } = sync;
  const state = readSyncState(configPath, membership);
  const history = state.history_synced_at === undefined;
  const report: SyncReport = {
    server: membership.server,
    team: membership.team,
    person: membership.person,
    history,
    sent: 0,
    accepted: 0,
    duplicates: 0,
  };
  try {
    await pushLedger(ledger, remote, history ? undefined : since);
    markSynced(configPath, state, history);
    const grants = await pullGrants(client, configPath, new Date(), sync.laptop);
    if (grants !== undefined) report.grants = grants;
    const pulled = await pullTeam(sync, state);
    report.policy_hash = pulled.policy_hash;
    report.context_hash = pulled.context_hash;
    if (pulled.context_repos) report.context_repos = pulled.context_repos;
    if (pulled.laptop) report.laptop = pulled.laptop;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return { ...report, ...remote.totals };
}

/** What pulling the team's config brought: the part of a sync after the events went up. */
export interface PullReport {
  /** sha256 of the team's selfhost.toml pulled, null when the team has none. */
  policy_hash: string | null;
  /** true when it differs from the one pulled before. */
  policy_changed: boolean;
  context_hash: string;
  context_repos?: RepoCompile[];
  laptop?: LaptopReport;
  /** Why the server's exception keys could not be pinned. */
  exception_keys_error?: string;
}

/**
 * Pulls the team policy and the org and team context layers, compiles again the repositories
 * whose context was compiled with the layers when they changed, then with a laptop installs the
 * managed settings the policy compiles to and sends a heartbeat when it is due.
 */
export async function pullTeam(sync: TeamSync, state?: SyncState): Promise<PullReport> {
  const { membership, configPath, client } = sync;
  const current = state ?? readSyncState(configPath, membership);
  const before = current.policy_hash;
  const policyHash = await pullPolicy(client, configPath, current);
  const context = await pullContext(client, configPath, current);
  // Before the managed settings install, which writes the pinned keys to the trust file. A
  // server that lists none keeps the pin as it was; grants then wait for the next sync.
  let keysError: string | undefined;
  try {
    await pinExceptionKeys(client, configPath);
  } catch (error) {
    keysError = error instanceof Error ? error.message : String(error);
  }
  const report: PullReport = {
    policy_hash: policyHash,
    policy_changed: before !== undefined && before !== policyHash,
    context_hash: context.hash,
    ...(keysError === undefined ? {} : { exception_keys_error: keysError }),
  };
  if (context.changed && current.context_repos?.length) {
    report.context_repos = await compileRepos(configPath, current.context_repos);
  }
  if (sync.laptop) {
    report.laptop = await reportLaptop(client, configPath, membership, current, sync.laptop, false);
  }
  return report;
}

/** How often `selfhost import --watch` pulls the team's config in team mode. */
export const TEAM_PULL_MS = 5 * 60_000;

export interface TeamPuller {
  /** Pulls now, or waits for the pull already running. */
  run(): Promise<void>;
  /** Stops the timer and waits for a running pull. */
  close(): Promise<void>;
}

/**
 * For `selfhost import --watch` in team mode: pulls the team policy and context layers, installs
 * the managed settings again when they changed and sends heartbeats every `intervalMs`, the same
 * work a one-shot sync does after sending its events, since a watcher may run for days. A failed
 * pull is reported once and tried again on the next tick.
 */
export function startTeamPull(
  sync: TeamSync,
  options: {
    intervalMs?: number;
    onReport: (report: PullReport) => void;
    onError: (message: string) => void;
  },
): TeamPuller {
  let running: Promise<void> | undefined;
  let closed = false;
  const run = () => {
    if (closed) return Promise.resolve();
    running ??= pullTeam(sync)
      .then(options.onReport, (error: unknown) => {
        options.onError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const timer = setInterval(run, options.intervalMs ?? TEAM_PULL_MS);
  timer.unref?.();
  return {
    run,
    async close() {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}

/** Records a successful send in the sync state. */
export function markSynced(configPath: string, state: SyncState, history = false): void {
  const now = new Date().toISOString();
  state.last_sync = now;
  if (history) state.history_synced_at = now;
  writeSyncState(configPath, state);
}

/** Saves the team's selfhost.toml next to the config file and returns its hash. */
export async function pullPolicy(
  client: TeamClient,
  configPath: string,
  state: SyncState,
): Promise<string | null> {
  const policy = await client.policy();
  const path = teamPolicyPath(configPath);
  if (policy?.text === undefined) rmSync(path, { force: true });
  else writeFileSync(path, policy.text, { mode: 0o600 });
  state.policy_hash = policy?.hash ?? null;
  writeSyncState(configPath, state);
  return state.policy_hash;
}

/**
 * Asks the server about the exceptions this machine's hooks requested (the review item ids they
 * named) and writes each grant it signed for one a person approved, once its signature verifies
 * with a key this laptop pinned; then reports the grants hooks used. Only this machine's own
 * requests are asked about, so the sync pulls this person's grants and nobody else's. Undefined
 * when there was nothing to ask; a failed read leaves the rest for the next sync. A laptop that
 * pinned no key yet (it joined before the server signed grants) pins the server's keys first.
 */
export async function pullGrants(
  client: TeamClient,
  configPath: string,
  now = new Date(),
  where: Pick<LaptopIo, "platform" | "systemRoot"> = { platform: process.platform },
): Promise<number | undefined> {
  const dir = exceptionsDir(dirname(configPath));
  if (!hasRequests(dir) && !hasUnreportedUses(dir)) return undefined;
  const trustHere = () => exceptionTrust(configPath, where.platform, where.systemRoot);
  let trust = trustHere();
  if (trust.source === "none") {
    await pinExceptionKeys(client, configPath);
    trust = trustHere();
  }
  const server = serverGrants(client, machineId(configPath));
  const report = await pullServerGrants(dir, server, trust.keys, now);
  return report.issued.length;
}

/**
 * For `selfhost import --watch`: each batch goes to the local ledger, then to the server. When
 * `catchUp` is given (the first sync failed), the next batch runs it instead, which sends these
 * events too since they are in the local ledger by then. A failed send throws after the local
 * write, so the watcher keeps the batch and tries again on the next poll; the local ledger skips
 * the ids it already has.
 */
export function syncingWriter(
  local: LedgerWriter,
  remote: LedgerWriter,
  catchUp?: () => Promise<void>,
): LedgerWriter {
  let pending = catchUp;
  return {
    async append(events) {
      const result = await local.append(events);
      if (pending) {
        await pending();
        pending = undefined;
      } else {
        await remote.append(events);
      }
      return result;
    },
  };
}
