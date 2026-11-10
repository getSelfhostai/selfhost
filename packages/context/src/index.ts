import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  CONTEXT_AGENTS,
  CONTEXT_LAYER_KINDS,
  type ContextAgent,
  type ContextConflict,
  type ContextLayerKind,
} from "@selfhost/schema";
import { type ContextPlan, planContext } from "./apply.js";
import { type CompileResult, compileContext } from "./compile/index.js";
import { type ContextLayer, mergeLayers } from "./layers.js";
import { contradictions } from "./lint.js";
import { buildLock, type ContextLock, lockFile, parseLock, versionWarnings } from "./lock.js";
import { LOCK_PATH } from "./schema.js";
import { readContextSource } from "./source.js";
import type { ContextError, ContextSource } from "./types.js";

export {
  applyContextPlan,
  CONTEXT_BLOCK,
  type Conflict,
  type ContextPlan,
  type Drift,
  type DriftProblem,
  type FileAction,
  type PlannedFile,
  type PlanOptions,
  planContext,
} from "./apply.js";
export { AGENT_DOCS, AGENT_NAMES, READERS, readersOf } from "./compile/agents.js";
export {
  type CompileOptions,
  type CompileResult,
  compileContext,
  itemsOf,
  type SkillResult,
} from "./compile/index.js";
export {
  type Content,
  type GeneratedFile,
  HEADER_MARK,
  type Header,
  hasHeader,
} from "./compile/output.js";
export { RULES_FILES, type RulesFile } from "./compile/ruler.js";
export {
  type ContextLayer,
  type ItemRef,
  itemFiles,
  layerHash,
  layerPathProblem,
  type MergedContext,
  mergeLayers,
  parseItemId,
  readLayerDir,
  readLayerFiles,
  withItem,
  writeLayerDir,
} from "./layers.js";
export { contradictions } from "./lint.js";
export {
  buildLock,
  type ContextLock,
  ContextLockSchema,
  lockFile,
  parseLock,
  versionWarnings,
} from "./lock.js";
export * from "./schema.js";
export {
  formatContextError,
  type ReadResult,
  readContextDir,
  readContextSource,
  resolveAgents,
} from "./source.js";
export type * from "./types.js";
export {
  type ContextItemInput,
  formatContextItem,
  type SourceFile,
  type WriteOptions,
  writeContextItem,
} from "./write.js";

export interface BuildOptions {
  /**
   * Agents to compile for. Default: the ones the lock names, else `detected` with the agents the
   * items name, else every agent.
   */
  agents?: readonly ContextAgent[];
  /** The agents found on this machine, for a first compile with no --agent. */
  detected?: readonly ContextAgent[];
  /** Folder to write into instead of root, which still holds the source. */
  out?: string;
  /** Replace files selfhost did not write. */
  force?: boolean;
  /**
   * The org, team and personal layers to merge with the repository's own (see mergeLayers).
   * With layers, a repository without .selfhost/context adds nothing instead of failing.
   */
  layers?: readonly ContextLayer[];
}

export type BuildResult =
  | { ok: false; errors: ContextError[] }
  | {
      ok: true;
      source: ContextSource;
      result: CompileResult;
      lock: ContextLock;
      /** The lock of the last compile into the target, if there was one. */
      previous: ContextLock | undefined;
      /** Where the files go: root, or the out folder. */
      target: string;
      plan: ContextPlan;
      warnings: string[];
      /** The layers merged, in order, the repository's included. */
      layers: { kind: ContextLayerKind; name: string }[];
      /** Items a later layer defined again; the earlier layer's item is used. */
      conflicts: ContextConflict[];
    };

/**
 * The agents a first compile writes for: those found on the machine and those an item names in
 * its own agents list. undefined (every agent) when neither names one, with a warning.
 */
function defaultAgents(
  source: ContextSource,
  detected: readonly ContextAgent[] | undefined,
  warnings: string[],
): ContextAgent[] | undefined {
  if (detected === undefined) return undefined;
  const items = [
    ...source.rules,
    ...source.skills,
    ...source.commands,
    ...source.agents,
    ...source.mcp,
  ];
  const named = items.flatMap((item) =>
    item.agents.length < CONTEXT_AGENTS.length ? item.agents : [],
  );
  const wanted = new Set<ContextAgent>([...detected, ...named]);
  if (wanted.size === 0) {
    warnings.push(
      "No agent was found on this machine and no item names one, so the files are written for every agent. Pass --agent to choose.",
    );
    return undefined;
  }
  return CONTEXT_AGENTS.filter((agent) => wanted.has(agent));
}

/**
 * Reads root/.selfhost/context, compiles it and plans the writes into root (or `out`), with
 * the lock among the files. Writes nothing: applyContextPlan does, and a check is a plan
 * with drift.
 */
export async function buildContext(root: string, options: BuildOptions = {}): Promise<BuildResult> {
  const extra = options.layers ?? [];
  const read = readContextSource(root, { allowMissing: extra.length > 0 });
  if (!read.ok) return read;
  const layers: ContextLayer[] = [
    ...extra,
    { kind: "repo", name: basename(root), source: read.source },
  ];
  const { source, conflicts } = mergeLayers(layers);
  const target = options.out ?? root;
  const warnings: string[] = [];
  const lockPath = join(target, LOCK_PATH);
  let previous: ContextLock | undefined;
  if (existsSync(lockPath)) {
    previous = parseLock(readFileSync(lockPath, "utf8"));
    if (!previous) warnings.push(`${LOCK_PATH} is not a lock this selfhost reads; it is replaced.`);
  }
  const result = await compileContext(source, {
    agents: options.agents ?? previous?.agents ?? defaultAgents(source, options.detected, warnings),
    ruler: read.ruler,
  });
  warnings.push(...contradictions(source));
  const lock = buildLock(source, result);
  warnings.push(...versionWarnings(previous, lock));
  const plan = planContext(target, [...result.files, lockFile(lock)], previous, {
    force: options.force,
  });
  return {
    ok: true,
    source,
    result,
    lock,
    previous,
    target,
    plan,
    warnings,
    layers: CONTEXT_LAYER_KINDS.flatMap((kind) =>
      layers.filter((layer) => layer.kind === kind).map(({ name }) => ({ kind, name })),
    ),
    conflicts,
  };
}
