import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  extractBlock,
  insertBlock,
  isPlainObject,
  openDoc,
  type Plain,
  type TomlBlock,
} from "@selfhost/agents";
import { parse as parseToml } from "smol-toml";
import { type GeneratedFile, HEADER_MARK, hasHeader, sourceLabel } from "./compile/output.js";
import { type ContextLock, sha256 } from "./lock.js";
import { CONTEXT_DIR, LOCK_PATH } from "./schema.js";

/** selfhost's block in .codex/config.toml; the rest of the file stays the person's. */
export const CONTEXT_BLOCK: TomlBlock = {
  start: "# >>> selfhost context >>>",
  end: "# <<< selfhost context <<<",
  note: `# ${HEADER_MARK} ${CONTEXT_DIR}/mcp.json. Edits inside this block are replaced: change the source, then run selfhost context compile.`,
};

export type FileAction = "create" | "update" | "unchanged" | "delete";

export interface PlannedFile {
  path: string;
  action: FileAction;
  sources: string[];
  /** The whole file after the change; null deletes it. */
  after: string | Uint8Array | null;
  /** Written with the executable bit (a skill's script). */
  executable?: boolean;
}

/**
 * Why a file on disk is not what the source compiles to. missing: not there. outdated: the
 * source changed since the last compile. edited: someone changed the file. stale: the source no
 * longer compiles to it.
 */
export type DriftProblem = "missing" | "outdated" | "edited" | "stale";

export interface Drift {
  path: string;
  problem: DriftProblem;
  message: string;
}

/** A file selfhost would replace that it did not write. */
export interface Conflict {
  path: string;
  message: string;
  /** --force replaces the file anyway; false when replacing can't fix it. */
  forceable: boolean;
}

export interface ContextPlan {
  files: PlannedFile[];
  drift: Drift[];
  conflicts: Conflict[];
}

export interface PlanOptions {
  /** Replace files selfhost did not write. */
  force?: boolean;
  /**
   * Files from the last compile that belong to agents this compile leaves out: they stay as
   * they are and keep their lock entry.
   */
  keep?: ReadonlySet<string>;
}

function read(path: string): Buffer | null {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return readFileSync(path);
}

/** The JSON object with value at key, nesting objects as needed. */
function nested(key: readonly string[], value: unknown): Plain {
  return key.reduceRight<Plain>((inner, part) => ({ [part]: inner }), value as Plain);
}

/** The block's text without the note line insertBlock puts first. */
function blockBody(block: string | null): string | null {
  if (block === null) return null;
  const note = `${CONTEXT_BLOCK.note}\n`;
  return block.startsWith(note) ? block.slice(note.length) : block;
}

interface State {
  /** The file as it should be, or the current text when only the owned part matters. */
  after: string | Uint8Array | null;
  equal: boolean;
  /** selfhost's part is present in the file at all. */
  present: boolean;
  /** Hash of selfhost's part as it is on disk, to tell an edit from a source change. */
  hash: string | null;
  /** The file holds something selfhost did not write in the place it writes. */
  foreign: boolean;
  error?: { message: string; forceable: boolean };
}

/** `path` is where the file is on disk, `name` its repository path for messages. */
function stateOf(file: GeneratedFile, current: Buffer | null, path: string, name: string): State {
  const content = file.content;
  const text = current?.toString("utf8") ?? null;
  switch (content.kind) {
    case "text":
    case "bytes": {
      const after = content.kind === "text" ? content.text : content.bytes;
      const executable = content.kind === "bytes" && content.executable;
      const equal =
        (current?.equals(Buffer.from(after)) ?? false) &&
        (!executable || (statSync(path).mode & 0o111) !== 0);
      return {
        after,
        equal,
        present: current !== null,
        hash: current === null ? null : sha256(current),
        foreign: current !== null && !(content.kind === "text" && text !== null && hasHeader(text)),
      };
    }
    case "json_key": {
      if (text === null) {
        const after = `${JSON.stringify(nested(content.key, content.value), null, 2)}\n`;
        return { after, equal: false, present: false, hash: null, foreign: false };
      }
      const opened = openDoc("json", text, name);
      if (!opened.ok) {
        return {
          after: text,
          equal: false,
          present: true,
          hash: null,
          foreign: true,
          error: {
            message: `${opened.error}, so selfhost can't set ${content.key.join(".")} in it.`,
            forceable: false,
          },
        };
      }
      const value = opened.doc.get(content.key);
      const equal = JSON.stringify(value) === JSON.stringify(content.value);
      if (!equal) opened.doc.set(content.key, content.value);
      return {
        after: equal ? text : opened.doc.toString(),
        equal,
        present: value !== undefined,
        hash: value === undefined ? null : sha256(JSON.stringify(value)),
        foreign: value !== undefined,
      };
    }
    case "toml_block": {
      const extracted = extractBlock(text ?? "", name, CONTEXT_BLOCK);
      if (!extracted.ok) {
        return {
          after: text,
          equal: false,
          present: true,
          hash: null,
          foreign: true,
          error: { message: extracted.error, forceable: false },
        };
      }
      let error: State["error"];
      try {
        const base = parseToml(extracted.base) as Plain;
        const ours = Object.keys(
          (parseToml(content.body) as { mcp_servers?: Plain }).mcp_servers ?? {},
        );
        const theirs = isPlainObject(base.mcp_servers) ? Object.keys(base.mcp_servers) : [];
        const clash = ours.filter((name) => theirs.includes(name));
        if (clash.length > 0) {
          error = {
            message: `${name} defines ${clash.map((name) => `[mcp_servers.${name}]`).join(", ")} outside selfhost's block. Remove ${clash.length === 1 ? "it" : "them"} there: ${CONTEXT_DIR}/mcp.json has the server now.`,
            forceable: false,
          };
        }
      } catch (cause) {
        error = {
          message: `${name} is not valid TOML (${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}).`,
          forceable: false,
        };
      }
      const body = blockBody(extracted.block);
      const equal = body === content.body;
      return {
        after: equal ? text : insertBlock(extracted.base, content.body, CONTEXT_BLOCK),
        equal,
        present: body !== null,
        hash: body === null ? null : sha256(body),
        foreign: false,
        ...(error ? { error } : {}),
      };
    }
  }
}

/** What a drift message calls a file: selfhost's key or block in a shared file, else the path. */
interface Described {
  path: string;
  sources: readonly string[];
  key?: readonly string[];
  block?: boolean;
}

function describe(file: GeneratedFile): Described {
  return {
    path: file.path,
    sources: file.sources,
    ...(file.content.kind === "json_key" ? { key: file.content.key } : {}),
    ...(file.content.kind === "toml_block" ? { block: true } : {}),
  };
}

function label(file: Described): string {
  if (file.key) return `${file.path} (${file.key.join(".")})`;
  if (file.block) return `selfhost's block in ${file.path}`;
  return file.path;
}

function driftMessage(problem: DriftProblem, file: Described): string {
  const what = label(file);
  const sources = sourceLabel(file.sources);
  if (file.path === LOCK_PATH && problem !== "missing") {
    return `${what} does not match ${CONTEXT_DIR}. Run selfhost context compile.`;
  }
  switch (problem) {
    case "missing":
      return `${what} is missing. Run selfhost context compile.`;
    case "outdated":
      return `${what} is out of date: ${sources} changed since the last compile. Run selfhost context compile.`;
    case "edited":
      return `${what} was edited by hand. Make the change in ${sources} instead, then run selfhost context compile.`;
    case "stale":
      return `${what} is no longer compiled from ${CONTEXT_DIR}. Run selfhost context compile to remove it.`;
  }
}

/** What taking selfhost's part out of a file it no longer compiles leaves. */
function removal(
  entry: ContextLock["files"][string],
  path: string,
  current: Buffer,
): { after: string | null; present: boolean } {
  const text = current.toString("utf8");
  if (entry.key) {
    const opened = openDoc("json", text, path);
    if (!opened.ok || !opened.doc.has(entry.key)) return { after: text, present: false };
    opened.doc.delete(entry.key);
    const rest = opened.doc.toJS();
    return { after: Object.keys(rest).length === 0 ? null : opened.doc.toString(), present: true };
  }
  if (entry.header === "block") {
    const extracted = extractBlock(text, path, CONTEXT_BLOCK);
    if (!extracted.ok || extracted.block === null) return { after: text, present: false };
    return { after: extracted.base.trim() === "" ? null : extracted.base, present: true };
  }
  return { after: null, present: true };
}

/**
 * Compares the files a compile produced with what is under root, and plans the writes. The
 * previous lock says which files selfhost wrote before: they may be replaced and, once the
 * source no longer compiles to them, removed. Any other existing file is a conflict.
 */
export function planContext(
  root: string,
  files: readonly GeneratedFile[],
  previous: ContextLock | undefined,
  options: PlanOptions = {},
): ContextPlan {
  const plan: ContextPlan = { files: [], drift: [], conflicts: [] };
  for (const file of files) {
    const current = read(join(root, file.path));
    const state = stateOf(file, current, join(root, file.path), file.path);
    const known = previous?.files[file.path];
    if (state.error) {
      plan.conflicts.push({
        path: file.path,
        message: state.error.message,
        forceable: state.error.forceable,
      });
    }
    if (state.equal) {
      plan.files.push({
        path: file.path,
        action: "unchanged",
        sources: file.sources,
        after: state.after,
      });
      continue;
    }
    const problem: DriftProblem = !state.present
      ? "missing"
      : known !== undefined && state.hash === known.sha256
        ? "outdated"
        : "edited";
    plan.drift.push({ path: file.path, problem, message: driftMessage(problem, describe(file)) });
    const notOurs = known === undefined || (known.adopted === true && state.hash !== known.sha256);
    if (state.foreign && notOurs && file.path !== LOCK_PATH && !state.error) {
      plan.conflicts.push({
        path: file.path,
        message: `${label(describe(file))} exists and selfhost did not write it. Move what it holds into ${CONTEXT_DIR}, or run again with --force to replace it.`,
        forceable: true,
      });
    }
    plan.files.push({
      path: file.path,
      action: current === null ? "create" : "update",
      sources: file.sources,
      after: state.after,
      ...(file.content.kind === "bytes" && file.content.executable ? { executable: true } : {}),
    });
  }
  const wanted = new Set(files.map((file) => file.path));
  for (const [path, entry] of Object.entries(previous?.files ?? {})) {
    if (wanted.has(path) || options.keep?.has(path)) continue;
    const current = read(join(root, path));
    if (current === null) continue;
    const removed = removal(entry, path, current);
    if (!removed.present) continue;
    const stale: Described = {
      path,
      sources: entry.sources,
      ...(entry.key ? { key: entry.key } : {}),
      ...(entry.header === "block" ? { block: true } : {}),
    };
    plan.drift.push({ path, problem: "stale", message: driftMessage("stale", stale) });
    // A whole file goes only while it holds what selfhost last wrote there. A key or a block
    // comes out of a shared file whatever else it holds.
    const whole = !entry.key && entry.header !== "block";
    if (whole && (entry.adopted === true || sha256(current) !== entry.sha256)) {
      plan.conflicts.push({
        path,
        message: `${path} is no longer compiled from ${CONTEXT_DIR}, but selfhost did not write what it holds now${entry.adopted ? " (selfhost init took it over as it was)" : " (it was edited by hand)"}. Delete it yourself, or run again with --force to remove it.`,
        forceable: true,
      });
    }
    plan.files.push({
      path,
      action: removed.after === null ? "delete" : "update",
      sources: entry.sources,
      after: removed.after,
    });
  }
  plan.conflicts = plan.conflicts.filter((conflict) => !(options.force && conflict.forceable));
  plan.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return plan;
}

/** Removes empty folders from dir up to, not including, root. */
function prune(root: string, dir: string): void {
  let current = dir;
  while (current.startsWith(root) && current !== root) {
    if (!existsSync(current) || readdirSync(current).length > 0) return;
    rmdirSync(current);
    current = dirname(current);
  }
}

/** Writes a plan. Call it only when the plan has no conflicts. */
export function applyContextPlan(root: string, plan: ContextPlan): void {
  if (plan.conflicts.length > 0) throw new Error("the plan has conflicts; nothing was written");
  for (const file of plan.files) {
    const path = join(root, file.path);
    if (file.action === "create" || file.action === "update") {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.after as string | Uint8Array);
      if (file.executable) chmodSync(path, 0o755);
    } else if (file.action === "delete") {
      rmSync(path, { force: true });
      prune(root, dirname(path));
    }
  }
}
