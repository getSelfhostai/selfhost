import { existsSync, readdirSync, rmSync } from "node:fs";
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

/** One repository a sync compiled again with the layers it pulled. */
export interface RepoCompile {
  root: string;
  /** Files written or removed. */
  changed: number;
  /** Why nothing was written there. */
  error?: string;
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
  const { layers, errors } = localLayers(configPath);
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
      results.push({ root, changed });
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
