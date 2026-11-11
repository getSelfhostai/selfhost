import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyContextPlan,
  buildContext,
  type ContextError,
  type ContextLayer,
  formatContextError,
  readContextDir,
  writeLayerDir,
} from "@selfhost/context";
import { type ContextLayerKind, TEAM_ID_PATTERN } from "@selfhost/schema";
import type { TeamClient } from "../team/client.js";
import {
  contextLayersDir,
  readMembership,
  readSyncState,
  type SyncState,
  writeSyncState,
} from "../team/config.js";

/** The name and path label of the person's own layer. */
export const PERSONAL = "personal";

/** The person's own items, in the .selfhost/context layout: ~/.selfhost/context/personal. */
export const personalDir = (configPath: string) => join(contextLayersDir(configPath), PERSONAL);

const PULLED = ["org", "team"] as const;
const LAYER_NAME = new RegExp(TEAM_ID_PATTERN);

export interface LocalLayers {
  /** The org and team layers as last pulled, then the person's own. */
  layers: ContextLayer[];
  /** Problems in them, with the file on this machine. */
  errors: ContextError[];
}

/** The context layers on this machine, besides the repository's own. */
export function localLayers(configPath: string): LocalLayers {
  const root = contextLayersDir(configPath);
  const result: LocalLayers = { layers: [], errors: [] };
  const add = (kind: ContextLayerKind, name: string, dir: string, label: string) => {
    const read = readContextDir(dir, label);
    if (read.ok) {
      result.layers.push({ kind, name, source: read.source });
      return;
    }
    // Problems name the file on this machine, so they can be found and fixed.
    for (const error of read.errors) {
      result.errors.push({ ...error, file: join(dir, error.file.slice(label.length + 1)) });
    }
  };
  for (const kind of PULLED) {
    const dir = join(root, kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (LAYER_NAME.test(name)) add(kind, name, join(dir, name), `${kind}:${name}`);
    }
  }
  const personal = personalDir(configPath);
  if (existsSync(personal)) add("personal", PERSONAL, personal, PERSONAL);
  return result;
}

export interface PulledContext {
  /** sha256 over the layers, as the server gives it. */
  hash: string;
  /** The hash differs from the last pull's. */
  changed: boolean;
  layers: { kind: "org" | "team"; name: string; files: number }[];
}

/** Saves the team's org and team context layers next to the config file. */
export async function pullContext(
  client: TeamClient,
  configPath: string,
  state: SyncState,
): Promise<PulledContext> {
  const pulled = await client.context();
  const root = contextLayersDir(configPath);
  for (const layer of pulled.layers) {
    if (!LAYER_NAME.test(layer.name)) {
      throw new Error(`The server named a context layer "${layer.name}", which is not an id`);
    }
  }
  for (const kind of PULLED) rmSync(join(root, kind), { recursive: true, force: true });
  for (const layer of pulled.layers) {
    writeLayerDir(join(root, layer.kind, layer.name), layer.files);
  }
  const changed = state.context_hash !== pulled.hash;
  state.context_hash = pulled.hash;
  writeSyncState(configPath, state);
  return {
    hash: pulled.hash,
    changed,
    layers: pulled.layers.map(({ kind, name, files }) => ({ kind, name, files: files.length })),
  };
}

/**
 * An MCP server in the org or team layer that starts a program on this machine. A sync pulls
 * those layers, so one of these runs here only once the person said yes to it.
 */
export interface CommandServer {
  /** `team:web mcp:db`, for messages. */
  label: string;
  /** The command and its arguments, as the agent would start it. */
  command: string;
  /** Changes when the server's settings change, so a changed one is asked about again. */
  fingerprint: string;
}

const approvedPath = (configPath: string) =>
  join(contextLayersDir(configPath), "approved-mcp-commands.json");

function readApproved(configPath: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(approvedPath(configPath), "utf8")) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeApproved(configPath: string, approved: Set<string>): void {
  mkdirSync(contextLayersDir(configPath), { recursive: true });
  writeFileSync(approvedPath(configPath), `${JSON.stringify([...approved].sort(), null, 2)}\n`, {
    mode: 0o600,
  });
}

const fingerprintOf = (layer: ContextLayer, server: ContextLayer["source"]["mcp"][number]) =>
  createHash("sha256")
    .update(JSON.stringify([layer.kind, layer.name, server.name, server.spec]))
    .digest("hex");

/** The pulled layers' MCP servers that run a command. The person's own layer is theirs. */
export function commandServers(layers: readonly ContextLayer[]): CommandServer[] {
  return layers
    .filter((layer) => layer.kind === "org" || layer.kind === "team")
    .flatMap((layer) =>
      layer.source.mcp
        .filter((server) => server.spec.command !== undefined)
        .map((server) => ({
          label: `${layer.kind}:${layer.name} mcp:${server.name}`,
          command: [server.spec.command, ...(server.spec.args ?? [])].join(" "),
          fingerprint: fingerprintOf(layer, server),
        })),
    );
}

/**
 * The layers with every org or team MCP server that runs a command the person has not said yes
 * to taken out. With `confirm` (a terminal) each new one is asked about, and a yes is kept for
 * next time; without it (a sync, a script) new ones are skipped and listed.
 */
export async function trustedLayers(
  configPath: string,
  layers: ContextLayer[],
  confirm?: (question: string) => Promise<boolean>,
): Promise<{ layers: ContextLayer[]; skipped: CommandServer[] }> {
  const approved = readApproved(configPath);
  const pending = commandServers(layers).filter((server) => !approved.has(server.fingerprint));
  if (pending.length === 0) return { layers, skipped: [] };
  const skipped: CommandServer[] = [];
  let added = false;
  for (const server of pending) {
    const yes = confirm
      ? await confirm(
          `${server.label} starts \`${server.command}\` on this machine whenever an agent loads it. Allow it? [y/N] `,
        )
      : false;
    if (yes) {
      approved.add(server.fingerprint);
      added = true;
    } else {
      skipped.push(server);
    }
  }
  if (added) writeApproved(configPath, approved);
  const out = new Set(skipped.map((server) => server.fingerprint));
  const kept = layers.map((layer) => {
    if (layer.kind !== "org" && layer.kind !== "team") return layer;
    const mcp = layer.source.mcp.filter((server) => !out.has(fingerprintOf(layer, server)));
    return { ...layer, source: { ...layer.source, mcp } };
  });
  return { layers: kept, skipped };
}

/** One repository a sync compiled again with the layers it pulled. */
export interface RepoCompile {
  root: string;
  /** Files written or removed. */
  changed: number;
  /** Why nothing was written there. */
  error?: string;
  /** Org or team MCP servers that run a command, left out until the person allows them. */
  skipped_mcp?: string[];
}

/**
 * Compiles the context of these repositories again with this machine's layers, as selfhost
 * context compile does there. A repository with a problem, or a file selfhost did not write in
 * the way, is left as it is and says why.
 */
export async function compileRepos(
  configPath: string,
  roots: readonly string[],
): Promise<RepoCompile[]> {
  const local = localLayers(configPath);
  const errors = local.errors;
  // A sync asks nobody: a new MCP server that runs a command waits for selfhost context compile.
  const { layers, skipped } = await trustedLayers(configPath, local.layers);
  const skippedMcp = skipped.map((server) => server.label);
  const results: RepoCompile[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const fail = (error: string) => results.push({ root, changed: 0, error });
    const [problem] = errors;
    if (problem) {
      fail(`a context layer has a problem: ${formatContextError(problem)}`);
      continue;
    }
    const built = await buildContext(root, { layers });
    if (!built.ok) {
      fail(built.errors.map(formatContextError).join("; "));
    } else if (built.plan.conflicts.length > 0) {
      fail(
        `it would replace files selfhost did not write (${built.plan.conflicts.map((c) => c.path).join(", ")}); run selfhost context compile there`,
      );
    } else {
      applyContextPlan(root, built.plan);
      const changed = built.plan.files.filter((file) => file.action !== "unchanged").length;
      results.push({
        root,
        changed,
        ...(skippedMcp.length > 0 ? { skipped_mcp: skippedMcp } : {}),
      });
    }
  }
  return results;
}

/** Remembers a repository compiled with pulled layers, so the next sync that changes them recompiles it. */
export function rememberRepo(configPath: string, root: string): void {
  const membership = readMembership(configPath);
  if (!membership) return;
  const state = readSyncState(configPath, membership);
  const repos = state.context_repos ?? [];
  if (repos.includes(root)) return;
  writeSyncState(configPath, { ...state, context_repos: [...repos, root] });
}
