import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextAgent } from "@selfhost/schema";
import { type ContextPlan, planContext } from "./apply.js";
import { type CompileResult, compileContext } from "./compile/index.js";
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
  buildLock,
  type ContextLock,
  ContextLockSchema,
  lockFile,
  parseLock,
  versionWarnings,
} from "./lock.js";
export * from "./schema.js";
export { formatContextError, type ReadResult, readContextSource, resolveAgents } from "./source.js";
export type * from "./types.js";
export {
  type ContextItemInput,
  formatContextItem,
  type SourceFile,
  type WriteOptions,
  writeContextItem,
} from "./write.js";

export interface BuildOptions {
  /** Agents to compile for. Default: the ones the lock names, else every agent. */
  agents?: readonly ContextAgent[];
  /** Folder to write into instead of root, which still holds the source. */
  out?: string;
  /** Replace files selfhost did not write. */
  force?: boolean;
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
    };

/**
 * Reads root/.selfhost/context, compiles it and plans the writes into root (or `out`), with
 * the lock among the files. Writes nothing: applyContextPlan does, and a check is a plan
 * with drift.
 */
export async function buildContext(root: string, options: BuildOptions = {}): Promise<BuildResult> {
  const read = readContextSource(root);
  if (!read.ok) return read;
  const target = options.out ?? root;
  const warnings: string[] = [];
  const lockPath = join(target, LOCK_PATH);
  let previous: ContextLock | undefined;
  if (existsSync(lockPath)) {
    previous = parseLock(readFileSync(lockPath, "utf8"));
    if (!previous) warnings.push(`${LOCK_PATH} is not a lock this selfhost reads; it is replaced.`);
  }
  const result = await compileContext(read.source, {
    agents: options.agents ?? previous?.agents,
    ruler: read.ruler,
  });
  const lock = buildLock(read.source, result);
  warnings.push(...versionWarnings(previous, lock));
  const plan = planContext(target, [...result.files, lockFile(lock)], previous, {
    force: options.force,
  });
  return { ok: true, source: read.source, result, lock, previous, target, plan, warnings };
}
