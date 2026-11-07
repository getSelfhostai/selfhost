import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { readText } from "./plan.js";
import type { AgentConfigPlan, FileChange } from "./types.js";

export interface AppliedChange {
  path: string;
  action: "created" | "updated" | "deleted";
  /** Copy of the previous content, next to the file; null for new files and selfhost's state. */
  backup: string | null;
}

/** Mode for files selfhost creates: settings can hold endpoints and headers. */
const NEW_FILE_MODE = 0o600;

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function freePath(base: string): string {
  let path = base;
  for (let n = 1; existsSync(path); n++) path = `${base}-${n}`;
  return path;
}

/** Writes through a symlink (dotfile managers) instead of replacing the link. */
function realTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return undefined;
  }
}

function writeWithMode(path: string, content: string, mode: number) {
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

interface Staged {
  change: FileChange;
  target: string;
  temp: string | null;
  backup: string | null;
}

/**
 * Applies a plan. Each file is written to a temporary file and renamed into place, keeping
 * its permissions, after a timestamped backup is saved next to it. A file that changed since
 * the plan was made stops the whole apply before anything is written; a failed rename puts
 * back the files already replaced.
 */
export function applyAgentConfig(
  plan: AgentConfigPlan,
  { now = new Date() }: { now?: Date } = {},
): AppliedChange[] {
  for (const change of plan.changes) {
    if (readText(change.path) !== change.before) {
      throw new Error(`${change.path} changed since the plan was made; run the command again`);
    }
  }

  const staged: Staged[] = [];
  try {
    for (const change of plan.changes) {
      const target = realTarget(change.path);
      const mode = modeOf(target) ?? NEW_FILE_MODE;
      let backup: string | null = null;
      if (change.before !== null && change.role === "config") {
        backup = freePath(`${change.path}.selfhost-backup-${stamp(now)}`);
        writeWithMode(backup, change.before, mode);
      }
      let temp: string | null = null;
      if (change.after !== null) {
        mkdirSync(dirname(target), { recursive: true });
        temp = `${target}.selfhost-${process.pid}-${randomBytes(4).toString("hex")}`;
        writeWithMode(temp, change.after, mode);
      }
      staged.push({ change, target, temp, backup });
    }
  } catch (error) {
    for (const { temp } of staged) if (temp) rmSync(temp, { force: true });
    throw error;
  }

  const done: Staged[] = [];
  try {
    for (const entry of staged) {
      if (entry.temp) renameSync(entry.temp, entry.target);
      else rmSync(entry.target, { force: true });
      done.push(entry);
    }
  } catch (error) {
    for (const { change, target } of done.reverse()) {
      if (change.before === null) rmSync(target, { force: true });
      else writeFileSync(target, change.before);
    }
    for (const { temp } of staged) if (temp) rmSync(temp, { force: true });
    throw error;
  }

  return staged.map(({ change, backup }) => ({
    path: change.path,
    action: change.after === null ? "deleted" : change.before === null ? "created" : "updated",
    backup,
  }));
}
