import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentConfigPlan, AgentId } from "@selfhost/agents";

/**
 * What `selfhost init` changed in agent config files and the context files it imported, so
 * `selfhost init --undo` can put each file back byte for byte. `agents configure --remove` takes
 * selfhost's keys out instead, which rewrites the file in its own layout.
 */
export interface RecordedFile {
  /** null for a context file. */
  agent: AgentId | null;
  path: string;
  /** config is the agent's own file; state is selfhost's record of what it owns there; context
   * is a file init imported into `.selfhost/context/`. */
  role: "config" | "state" | "context";
  /** config: copy of the file from before init first changed it; null when init created it. */
  backup: string | null;
  /** state: selfhost's record from before init, null when there was none. */
  before: string | null;
  /** SHA-256 of what init last wrote, null for a file it deleted. Undo needs the file unchanged. */
  sha256: string | null;
}

interface InitRecord {
  schema: string;
  files: RecordedFile[];
}

const SCHEMA = "selfhost.init_record/v1";

/** `selfhost gateway connect` keeps the same kind of record of the files it changed. */
export const GATEWAY_RECORD_SCHEMA = "selfhost.gateway_record/v1";

export const recordPath = (home: string) => join(home, ".selfhost", "init.json");

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function readBytes(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const hashOf = (data: string | Buffer | null) => (data === null ? null : hash(data));

/** True when the file holds exactly these characters as UTF-8, so a backup can restore it. */
export function sameBytes(path: string, text: string): boolean {
  const bytes = readBytes(path);
  return bytes?.equals(Buffer.from(text, "utf8")) === true;
}

export function readRecord(path: string, schema = SCHEMA): RecordedFile[] {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<InitRecord>;
    return value.schema === schema && Array.isArray(value.files) ? value.files : [];
  } catch {
    return [];
  }
}

function writeRecord(path: string, files: RecordedFile[], schema = SCHEMA): void {
  if (files.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record: InitRecord = { schema, files };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Adds the changes of applied plans to the record. A file init changes again while it still
 * holds init's last write keeps its first backup, which has the bytes from before any init.
 */
export function recordApplied(
  path: string,
  plans: AgentConfigPlan[],
  backups: ReadonlyMap<string, string | null>,
  schema = SCHEMA,
): void {
  const files = readRecord(path, schema);
  for (const plan of plans) {
    for (const change of plan.changes) {
      const wrote = hashOf(change.after);
      const index = files.findIndex((file) => file.path === change.path);
      const earlier = files[index];
      if (earlier && earlier.sha256 === hashOf(change.before)) {
        earlier.sha256 = wrote;
        continue;
      }
      const entry: RecordedFile = {
        agent: plan.agent,
        path: change.path,
        role: change.role,
        backup: change.role === "config" ? (backups.get(change.path) ?? null) : null,
        before: change.role === "state" ? change.before : null,
        sha256: wrote,
      };
      if (earlier) files[index] = entry;
      else files.push(entry);
    }
  }
  writeRecord(path, files, schema);
}

/** Adds files init created in `.selfhost/context/`; undo deletes them while they are unchanged. */
export function recordCreated(path: string, created: string[]): void {
  const files = readRecord(path).filter((file) => !created.includes(file.path));
  for (const file of created) {
    files.push({
      agent: null,
      path: file,
      role: "context",
      backup: null,
      before: null,
      sha256: hashOf(readBytes(file)),
    });
  }
  writeRecord(path, files);
}

/** Removes the folders a deleted context file leaves empty, up to the `.selfhost` folder. */
function pruneEmpty(file: string): void {
  let dir = dirname(file);
  while (dir.includes(".selfhost")) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    if (basename(dir) === ".selfhost") return;
    dir = dirname(dir);
  }
}

export interface UndoFile {
  agent: AgentId | null;
  path: string;
  role: RecordedFile["role"];
  action: "restored" | "deleted" | "left";
  /** The backup the bytes came from. */
  backup: string | null;
  /** Why a file was left as is. */
  message: string | null;
}

/** `selfhost init --undo --json`. */
export interface UndoReport {
  schema: "selfhost.init_undo/v1";
  dry_run: boolean;
  record: string;
  files: UndoFile[];
  /** Files left as is; their record entries are kept for another try. */
  left: number;
}

/**
 * Puts back every file `selfhost init` changed, byte for byte, as long as it still holds what
 * init wrote, and deletes the context files it imported. selfhost's own record for an agent goes
 * back only with that agent's files.
 */
export function undoInit(home: string, dryRun: boolean): UndoReport {
  const path = recordPath(home);
  return {
    schema: "selfhost.init_undo/v1",
    dry_run: dryRun,
    record: path,
    ...undoRecorded(path, dryRun),
  };
}

/**
 * Puts back the files in a record, byte for byte, while each still holds what selfhost last
 * wrote. `only` picks the agents to undo; the others stay in the record as they are.
 */
export function undoRecorded(
  path: string,
  dryRun: boolean,
  { schema = SCHEMA, only }: { schema?: string; only?: ReadonlySet<AgentId | null> } = {},
): { files: UndoFile[]; left: number } {
  const recorded = readRecord(path, schema);
  const files = only ? recorded.filter((file) => only.has(file.agent)) : recorded;
  const results: UndoFile[] = [];
  const kept: RecordedFile[] = only ? recorded.filter((file) => !only.has(file.agent)) : [];
  const left = kept.length;
  const blocked = new Set<AgentId | null>();
  const order = [
    ...files.filter((file) => file.role === "config"),
    ...files.filter((file) => file.role === "state"),
    ...files.filter((file) => file.role === "context"),
  ];
  for (const file of order) {
    const result = (action: UndoFile["action"], message: string | null = null): UndoFile => ({
      agent: file.agent,
      path: file.path,
      role: file.role,
      action,
      backup: file.backup,
      message,
    });
    const leave = (message: string) => {
      results.push(result("left", message));
      kept.push(file);
      blocked.add(file.agent);
    };
    if (file.role === "state" && blocked.has(file.agent)) {
      leave("kept while the agent's settings file is not restored");
      continue;
    }
    if (hashOf(readBytes(file.path)) !== file.sha256) {
      leave(
        file.backup
          ? `changed since selfhost init; the original is in ${file.backup}`
          : "changed since selfhost init",
      );
      continue;
    }
    let original: string | Buffer | null = file.role === "state" ? file.before : null;
    if (file.role === "config" && file.backup) {
      original = readBytes(file.backup);
      if (original === null) {
        leave(`the backup ${file.backup} is missing`);
        continue;
      }
    }
    if (!dryRun) {
      if (original === null) rmSync(file.path, { force: true });
      else writeFileSync(file.path, original);
      if (file.role === "context") pruneEmpty(file.path);
    }
    results.push(result(original === null ? "deleted" : "restored"));
  }
  if (!dryRun) writeRecord(path, kept, schema);
  return { files: results, left: kept.length - left };
}
