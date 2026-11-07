import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ImportOptions, LogFile, Vendor } from "./types.js";

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map(expandHome);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function jsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true });
    return entries.filter((entry) => entry.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}

/** `projects/` dirs: opts.claudeDir, else CLAUDE_CONFIG_DIR (comma-separated), else defaults. */
async function claudeProjectDirs(opts: ImportOptions): Promise<string[]> {
  const env = process.env.CLAUDE_CONFIG_DIR;
  const configDirs =
    opts.claudeDir !== undefined
      ? splitList(opts.claudeDir)
      : env !== undefined && env.trim() !== ""
        ? splitList(env)
        : [
            join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "claude"),
            join(homedir(), ".claude"),
          ];
  const dirs: string[] = [];
  for (const dir of configDirs) {
    const projects = (await isDirectory(join(dir, "projects")))
      ? join(dir, "projects")
      : basename(dir) === "projects" && (await isDirectory(dir))
        ? dir
        : undefined;
    if (projects !== undefined && !dirs.includes(projects)) dirs.push(projects);
  }
  return dirs;
}

/** Codex homes: opts.codexDir, else CODEX_HOME (comma-separated), else ~/.codex. */
function codexHomes(opts: ImportOptions): string[] {
  const env = process.env.CODEX_HOME;
  if (opts.codexDir !== undefined) return splitList(opts.codexDir);
  if (env !== undefined && env.trim() !== "") return splitList(env);
  return [join(homedir(), ".codex")];
}

async function claudeFiles(opts: ImportOptions): Promise<string[]> {
  const files: string[] = [];
  for (const dir of await claudeProjectDirs(opts)) {
    for (const file of await jsonlFiles(dir)) files.push(join(dir, file));
  }
  return files;
}

/** Active `sessions/` copies win over `archived_sessions/` ones with the same relative path. */
async function codexFiles(opts: ImportOptions): Promise<string[]> {
  const files: string[] = [];
  for (const home of codexHomes(opts)) {
    const seen = new Set<string>();
    for (const dir of [join(home, "sessions"), join(home, "archived_sessions")]) {
      for (const file of await jsonlFiles(dir)) {
        if (seen.has(file)) continue;
        seen.add(file);
        files.push(join(dir, file));
      }
    }
  }
  return files;
}

/**
 * Session logs on disk: `~/.claude/projects/**\/*.jsonl` (and `~/.config/claude`, or
 * CLAUDE_CONFIG_DIR) for Claude Code, `~/.codex/sessions/**\/*.jsonl` and
 * `archived_sessions/` (or CODEX_HOME) for Codex. Missing directories yield nothing.
 */
export async function discoverLogFiles(opts: ImportOptions): Promise<LogFile[]> {
  const vendors: Vendor[] = opts.vendor ? [opts.vendor] : ["claude_code", "codex"];
  const out: LogFile[] = [];
  for (const vendor of vendors) {
    const paths = vendor === "claude_code" ? await claudeFiles(opts) : await codexFiles(opts);
    for (const path of [...new Set(paths)].sort()) out.push({ vendor, path });
  }
  return out;
}
