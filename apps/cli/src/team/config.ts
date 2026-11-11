import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readConfigFile, writeConfigFile } from "../config-file.js";
import { configPin, TRUST_SCHEMA, type TrustedKey } from "../hooks/trust.js";
import type { TeamClient } from "./client.js";

/**
 * What `selfhost join` keeps in the config file, and all it keeps: the server, the person token
 * and who it belongs to. Vendor logins and API keys are never asked for or stored.
 */
export interface Membership {
  server: string;
  token: string;
  person: string;
  team: string;
}

export const MEMBERSHIP_KEYS = ["server", "token", "person", "team"] as const;

/** The team membership, or undefined in solo mode (no file, no membership or a broken file). */
export function readMembership(configPath: string): Membership | undefined {
  const config = readConfigFile(configPath);
  if (!config) return undefined;
  const { server, token, person, team } = config;
  if (isText(server) && isText(token) && isText(person) && isText(team)) {
    return { server, token, person, team };
  }
  return undefined;
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

/** Adds the membership to the config file, keeping its other settings. */
export function saveMembership(configPath: string, membership: Membership): void {
  const config = writableConfig(configPath);
  writeConfigFile(configPath, { ...config, ...membership });
  clearSyncFiles(configPath);
}

/** Takes the membership out of the config file. Returns the one removed, if any. */
export function clearMembership(configPath: string): Membership | undefined {
  const membership = readMembership(configPath);
  const config = writableConfig(configPath);
  const keys: readonly string[] = [...MEMBERSHIP_KEYS, PIN_KEY];
  if (keys.some((key) => key in config)) {
    const rest = Object.fromEntries(Object.entries(config).filter(([key]) => !keys.includes(key)));
    writeConfigFile(configPath, rest);
  }
  clearSyncFiles(configPath);
  return membership;
}

/** Where config.json pins the team server's exception keys. */
const PIN_KEY = "exception_keys";

/**
 * Pins the public keys the team server signs exception grants with in config.json, as the
 * server lists them now: at join and on every sync, so a rotated key is pinned before the server
 * signs with it. Returns the keys pinned. Where managed settings are installed, the root-owned
 * trust file holds the pin the hook uses and this one is only what the next install writes there.
 */
export async function pinExceptionKeys(
  client: Pick<TeamClient, "exceptionKeys">,
  configPath: string,
): Promise<TrustedKey[]> {
  const listed = await client.exceptionKeys();
  const config = writableConfig(configPath);
  const server = config.server;
  if (typeof server !== "string") throw new Error(`${configPath} names no team server`);
  const keys = listed.keys.map(({ id, public_key }) => ({ id, public_key }));
  const before = configPin(config);
  if (JSON.stringify(before?.keys) !== JSON.stringify(keys)) {
    writeConfigFile(configPath, { ...config, [PIN_KEY]: { schema: TRUST_SCHEMA, server, keys } });
  }
  return keys;
}

/** The config file contents, refusing to go on when they would be lost by a write. */
export function writableConfig(configPath: string): Record<string, unknown> {
  const config = readConfigFile(configPath);
  if (!config) {
    throw new Error(`${configPath} is not a JSON object, so it was left alone. Fix or remove it.`);
  }
  return config;
}

/** Sync progress, kept next to the config file so the config holds the membership only. */
export interface SyncState {
  server: string;
  team: string;
  /** Last time events went up to the server. */
  last_sync?: string;
  /** When the whole local ledger went up, the first sync after joining. */
  history_synced_at?: string;
  /** sha256 of the team policy pulled on the last sync, or null when the team has none. */
  policy_hash?: string | null;
  /** sha256 over the org and team context layers pulled on the last sync. */
  context_hash?: string;
  /**
   * Repositories whose context was compiled with the pulled layers on this machine: a sync
   * that pulls changed layers compiles them again.
   */
  context_repos?: string[];
  /** Set by selfhost join --no-managed: syncs report the managed files but never write them. */
  managed_off?: boolean;
  /**
   * The admin commands the managed settings still need, as the last join or sync found them, so
   * selfhost status can print them again; and a hash of them with the team policy, so a sync
   * prints them once per policy version rather than on every sync.
   */
  managed_commands?: string[];
  managed_shown?: string;
  /** When the last laptop heartbeat went up, and a hash of what it said. */
  heartbeat_at?: string;
  heartbeat_hash?: string;
}

export const syncStatePath = (configPath: string) => join(dirname(configPath), "sync.json");

/** The team's selfhost.toml as pulled on the last sync. */
export const teamPolicyPath = (configPath: string) => join(dirname(configPath), "team-policy.toml");

/**
 * Context layers on this machine, next to the config file: org/<id>/ and team/<id>/ as pulled on
 * the last sync, and personal/, the person's own items, which never leave this machine unless
 * they propose one to the team.
 */
export const contextLayersDir = (configPath: string) => join(dirname(configPath), "context");

/** Sync progress for this membership; a file left by another membership is ignored. */
export function readSyncState(configPath: string, membership: Membership): SyncState {
  const fresh = { server: membership.server, team: membership.team };
  try {
    const state = JSON.parse(readFileSync(syncStatePath(configPath), "utf8")) as SyncState;
    return state.server === fresh.server && state.team === fresh.team ? state : fresh;
  } catch {
    return fresh;
  }
}

export function writeSyncState(configPath: string, state: SyncState): void {
  writeFileSync(syncStatePath(configPath), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function clearSyncFiles(configPath: string): void {
  rmSync(syncStatePath(configPath), { force: true });
  rmSync(teamPolicyPath(configPath), { force: true });
  for (const pulled of ["org", "team"]) {
    rmSync(join(contextLayersDir(configPath), pulled), { recursive: true, force: true });
  }
}
