import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * What `selfhost migrate` wrote, so `selfhost migrate conductor --undo` can put each
 * selfhost.toml back byte for byte. The text from before is kept here rather than in a backup
 * file next to selfhost.toml, where it could be committed by accident. Like the record of
 * `selfhost init` (init/record.ts), a file is only put back while it still holds what was
 * written.
 */
export interface MigratedFile {
  path: string;
  /** The file before the first migrate changed it; null when migrate created it. */
  before: string | null;
  /** SHA-256 of what migrate last wrote. */
  sha256: string;
}

interface MigrateRecord {
  schema: "selfhost.migrate_record/v1";
  files: MigratedFile[];
}

const SCHEMA = "selfhost.migrate_record/v1";

/** Next to the team membership: ~/.selfhost/migrate.json by default. */
export const migrateRecordPath = (configPath: string) => join(dirname(configPath), "migrate.json");

const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readRecord(path: string): MigratedFile[] {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<MigrateRecord>;
    return value.schema === SCHEMA && Array.isArray(value.files) ? value.files : [];
  } catch {
    return [];
  }
}

function writeRecord(path: string, files: MigratedFile[]): void {
  if (files.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record: MigrateRecord = { schema: SCHEMA, files };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Writes `after` through a temporary file and a rename, keeping the file's permissions. Stops
 * before writing when the file no longer holds `before`.
 */
export function writeChecked(path: string, before: string | null, after: string): void {
  if (readText(path) !== before) {
    throw new Error(`${path} changed while migrate was running; run it again`);
  }
  let mode = 0o644;
  try {
    mode = statSync(path).mode & 0o7777;
  } catch {
    // A new file.
  }
  const temp = `${path}.selfhost-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(temp, after, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Adds a write to the record. A file written again keeps its first `before`. */
export function recordWrite(
  recordPath: string,
  path: string,
  before: string | null,
  after: string,
): void {
  const files = readRecord(recordPath);
  const earlier = files.find((file) => file.path === path);
  if (earlier && before !== null && earlier.sha256 === hash(before)) {
    earlier.sha256 = hash(after);
  } else {
    const entry = { path, before, sha256: hash(after) };
    if (earlier) files[files.indexOf(earlier)] = entry;
    else files.push(entry);
  }
  writeRecord(recordPath, files);
}

export interface UndoneFile {
  path: string;
  action: "restored" | "deleted" | "left";
  /** Why a file was left as is. */
  message: string | null;
}

/** `selfhost migrate conductor --undo --json`. */
export interface MigrateUndoReport {
  schema: "selfhost.migrate_undo/v1";
  dry_run: boolean;
  record: string;
  files: UndoneFile[];
  /** Files left as is; they stay in the record for another try. */
  left: number;
}

/** Puts back every selfhost.toml migrate changed, as long as it still holds what migrate wrote. */
export function undoMigrate(recordPath: string, dryRun: boolean): MigrateUndoReport {
  const files: UndoneFile[] = [];
  const kept: MigratedFile[] = [];
  for (const file of readRecord(recordPath)) {
    const current = readText(file.path);
    if (current === null || hash(current) !== file.sha256) {
      files.push({
        path: file.path,
        action: "left",
        message: current === null ? "it no longer exists" : "it was edited after migrate wrote it",
      });
      kept.push(file);
      continue;
    }
    if (!dryRun) {
      if (file.before === null) rmSync(file.path, { force: true });
      else writeChecked(file.path, current, file.before);
    }
    files.push({
      path: file.path,
      action: file.before === null ? "deleted" : "restored",
      message: null,
    });
  }
  if (!dryRun) writeRecord(recordPath, kept);
  return {
    schema: "selfhost.migrate_undo/v1",
    dry_run: dryRun,
    record: recordPath,
    files,
    left: kept.length,
  };
}
