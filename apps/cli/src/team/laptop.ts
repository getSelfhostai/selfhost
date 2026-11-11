import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compilePolicy } from "@selfhost/compile";
import { stableEventId } from "@selfhost/ledger";
import {
  EVENT_SCHEMA,
  HEARTBEAT_EVENT_KIND,
  LAPTOP_HEARTBEAT_SCHEMA,
  LAPTOP_PLATFORMS,
  type LaptopHeartbeat,
  type LaptopPlatform,
  type LedgerEvent,
  parseConfig,
} from "@selfhost/schema";
import {
  installManaged,
  knownPath,
  type LaptopAgentsScope,
  type ManagedReport,
  managedDir,
  managedFiles,
  managedSummary,
  vendorsHere,
} from "../policy/managed.js";
import type { TeamClient } from "./client.js";
import { type Membership, type SyncState, teamPolicyPath, writeSyncState } from "./config.js";

/**
 * What a laptop in a team does about the team config beyond syncing: installs the managed
 * settings the pulled team policy compiles to (where it may write; the admin command for the
 * rest), and reports a heartbeat with the config version it runs. Join and every sync do both.
 */
export interface LaptopIo {
  platform: NodeJS.Platform;
  /** Where system paths start: undefined for the real ones. Tests pass a temporary folder. */
  systemRoot?: string;
  hostname: string;
  /** The selfhost CLI version, reported in heartbeats. */
  version: string;
  now?: () => Date;
  /**
   * Where to look for the agents on this laptop: managed files go only to vendors found there.
   * Undefined installs every vendor's.
   */
  agents?: LaptopAgentsScope;
}

/** The `managed` and `heartbeat` parts of `selfhost join --json` and the sync report. */
export interface LaptopReport {
  managed: ManagedReport | null;
  /** Why the team policy could not be compiled into managed files. */
  managed_error?: string;
  /**
   * true when an earlier join or sync already printed the admin commands for this policy's
   * managed settings: a sync then says so in one line instead of printing them again.
   */
  managed_shown_before?: boolean;
  heartbeat: { sent: boolean; machine: string; error?: string };
}

/** A heartbeat goes up at least this often while syncs run, and whenever what it says changes. */
export const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;

const machinePath = (configPath: string) => join(dirname(configPath), "machine.json");

/**
 * This laptop's id: random, made the first time it is needed and kept next to the config file,
 * so it stays the same across leaving and joining again. It says nothing about the hardware.
 */
export function machineId(configPath: string): string {
  const path = machinePath(configPath);
  try {
    const { id } = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown };
    if (typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)) return id;
  } catch {}
  const id = randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ id }, null, 2)}\n`, { mode: 0o600 });
  return id;
}

/**
 * Compiles the pulled team policy and installs its managed files, or with `off` only reports
 * where they stand. Undefined report when no team policy was pulled.
 */
export function installTeamManaged(
  configPath: string,
  membership: Membership,
  laptop: LaptopIo,
  off: boolean,
): { report: ManagedReport | null; error?: string } {
  const path = teamPolicyPath(configPath);
  if (!existsSync(path)) return { report: null };
  const parsed = parseConfig(readFileSync(path, "utf8"));
  if (!parsed.ok) {
    return { report: null, error: `The team policy pulled from ${membership.server} is invalid.` };
  }
  const config = parsed.config;
  const team = Object.hasOwn(config.teams, membership.team) ? membership.team : undefined;
  const result = compilePolicy(config, team ? { team } : {});
  const all = managedFiles(result, laptop.platform);
  const here = laptop.agents ? vendorsHere(laptop.agents) : undefined;
  const files = here ? all.filter((file) => here.has(file.vendor)) : all;
  const notHere = [...new Set(all.map((file) => file.vendor))].filter(
    (vendor) => here !== undefined && !here.has(vendor),
  );
  const report = installManaged(files, {
    platform: laptop.platform,
    ...(laptop.systemRoot === undefined ? {} : { root: laptop.systemRoot }),
    staging: managedDir(configPath),
    known: knownPath(configPath),
    write: !off,
  });
  return { report: notHere.length > 0 ? { ...report, not_here: notHere } : report };
}

const platformOf = (platform: string): LaptopPlatform =>
  (LAPTOP_PLATFORMS as readonly string[]).includes(platform)
    ? (platform as LaptopPlatform)
    : "other";

export function heartbeat(
  machine: string,
  laptop: LaptopIo,
  policyHash: string | null,
  managed: ManagedReport | null,
): LaptopHeartbeat {
  return {
    schema: LAPTOP_HEARTBEAT_SCHEMA,
    machine,
    ...(laptop.hostname ? { hostname: laptop.hostname.slice(0, 255) } : {}),
    platform: platformOf(laptop.platform),
    selfhost_version: laptop.version,
    policy_hash: policyHash,
    managed: managedSummary(managed ?? undefined),
  };
}

export function heartbeatEvent(person: string, beat: LaptopHeartbeat, now: Date): LedgerEvent {
  const ts = now.toISOString();
  return {
    id: stableEventId(ts, `${HEARTBEAT_EVENT_KIND}:${beat.machine}:${ts}`),
    schema: EVENT_SCHEMA,
    ts,
    source: "cli",
    kind: HEARTBEAT_EVENT_KIND,
    actor: { kind: "person", id: person },
    data: { heartbeat: beat },
  };
}

const hashOf = (beat: LaptopHeartbeat) =>
  createHash("sha256").update(JSON.stringify(beat)).digest("hex");

/**
 * Keeps the admin commands the managed settings still need, for selfhost status, and whether
 * they were printed for this version of the team policy already. Returns true when they were and
 * this is a sync (`always` false), which then does not print them again.
 */
function rememberCommands(
  configPath: string,
  state: SyncState,
  commands: string[],
  always: boolean,
): boolean {
  const key =
    commands.length > 0
      ? createHash("sha256")
          .update(`${state.policy_hash ?? ""}\n${commands.join("\n")}`)
          .digest("hex")
      : undefined;
  const before = state.managed_shown;
  const same = (state.managed_commands ?? []).join("\n") === commands.join("\n") && before === key;
  if (!same) {
    if (commands.length > 0) state.managed_commands = commands;
    else delete state.managed_commands;
    if (key === undefined) delete state.managed_shown;
    else state.managed_shown = key;
    writeSyncState(configPath, state);
  }
  return !always && key !== undefined && before === key;
}

/**
 * The laptop part of a join or sync: installs the managed files of the pulled team policy, then
 * sends a heartbeat. On sync (`always` false) the heartbeat goes only when what it says changed
 * or the last one is an hour old. A failed heartbeat is reported, never thrown: the next sync
 * sends it.
 */
export async function reportLaptop(
  client: TeamClient,
  configPath: string,
  membership: Membership,
  state: SyncState,
  laptop: LaptopIo,
  always: boolean,
): Promise<LaptopReport> {
  const installed = installTeamManaged(configPath, membership, laptop, state.managed_off === true);
  const shownBefore = rememberCommands(configPath, state, installed.report?.commands ?? [], always);
  const machine = machineId(configPath);
  const now = laptop.now?.() ?? new Date();
  const beat = heartbeat(machine, laptop, state.policy_hash ?? null, installed.report);
  const hash = hashOf(beat);
  const last = state.heartbeat_at ? Date.parse(state.heartbeat_at) : Number.NaN;
  const due =
    always || state.heartbeat_hash !== hash || !(now.getTime() - last < HEARTBEAT_INTERVAL_MS);
  const report: LaptopReport = {
    managed: installed.report,
    ...(installed.error === undefined ? {} : { managed_error: installed.error }),
    ...(shownBefore ? { managed_shown_before: true } : {}),
    heartbeat: { sent: false, machine },
  };
  if (!due) return report;
  try {
    await client.pushEvents([heartbeatEvent(membership.person, beat, now)]);
    report.heartbeat.sent = true;
    state.heartbeat_at = now.toISOString();
    state.heartbeat_hash = hash;
    writeSyncState(configPath, state);
  } catch (error) {
    report.heartbeat.error = error instanceof Error ? error.message : String(error);
  }
  return report;
}
