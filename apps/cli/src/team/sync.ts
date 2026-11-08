import { rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LedgerWriter } from "@selfhost/importers";
import type { Ledger } from "@selfhost/ledger";
import { PAGE_LIMIT_MAX } from "@selfhost/schema";
import { exceptionsDir, hasRequests, issueGrants } from "../hooks/exceptions.js";
import { type Fetch, TeamClient } from "./client.js";
import {
  type Membership,
  readSyncState,
  type SyncState,
  teamPolicyPath,
  writeSyncState,
} from "./config.js";
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
  /** Why the sync stopped. The events stay in the local ledger and go up on the next sync. */
  error?: string;
}

export interface TeamSync {
  membership: Membership;
  configPath: string;
  client: TeamClient;
  remote: RemoteWriter;
}

export function teamSync(
  membership: Membership,
  configPath: string,
  fetch: Fetch,
  options: Omit<RemoteWriterOptions, "person"> = {},
): TeamSync {
  const client = new TeamClient(membership.server, membership.token, fetch);
  const remote = new RemoteWriter(client, { ...options, person: membership.person });
  return { membership, configPath, client, remote };
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
 * Brings the server up to date with the local ledger and pulls the team policy. The first sync
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
    report.policy_hash = await pullPolicy(client, configPath, state);
    const grants = await pullGrants(client, configPath);
    if (grants !== undefined) report.grants = grants;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return { ...report, ...remote.totals };
}

/** Records a successful send in the sync state. */
export function markSynced(configPath: string, state: SyncState, history = false): void {
  const now = new Date().toISOString();
  state.last_sync = now;
  if (history) state.history_synced_at = now;
  writeSyncState(configPath, state);
}

/** Saves the team's selfhost.toml next to the config file and returns its hash. */
async function pullPolicy(
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
 * named) and writes a grant for each one a person approved. Only this machine's own requests are
 * asked about, so the sync pulls this person's grants and nobody else's. Undefined when there was
 * nothing to ask; a failed read leaves the rest for the next sync.
 */
export async function pullGrants(
  client: TeamClient,
  configPath: string,
  now = new Date(),
): Promise<number | undefined> {
  const dir = exceptionsDir(dirname(configPath));
  if (!hasRequests(dir)) return undefined;
  const report = await issueGrants(dir, (id) => client.reviewItem(id), now);
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
