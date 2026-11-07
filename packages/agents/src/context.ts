import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { locate } from "./locations.js";
import type { AgentId, LocateOptions } from "./types.js";

export type ContextKind =
  | "claude_md"
  | "claude_local_md"
  | "agents_md"
  | "skill"
  | "subagent"
  | "command"
  | "rule"
  | "hints";

export interface ContextFile {
  path: string;
  kind: ContextKind;
  scope: "repo" | "home";
  /** The agent that reads the file natively; "shared" for AGENTS.md and Agent Skills. */
  agent: AgentId | "shared";
  size: number;
}

export interface ContextOptions extends LocateOptions {
  /** Where to start looking for the repository; its git root is searched. */
  cwd?: string;
}

/** Folders never searched for nested CLAUDE.md and AGENTS.md files. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".git",
  ".venv",
  "venv",
]);

const MAX_DEPTH = 4;
const MAX_ENTRIES = 20_000;

function fileSize(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** The nearest directory with a .git entry, or cwd when there is none. */
export function repoRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

type Add = (path: string, kind: ContextKind, agent: ContextFile["agent"]) => void;

/** `<dir>/<name>/SKILL.md` for every skill folder in dir. */
function skills(dir: string, agent: ContextFile["agent"], add: Add) {
  for (const name of list(dir)) add(join(dir, name, "SKILL.md"), "skill", agent);
}

/** Markdown files in dir, recursing into subfolders (commands and rules allow nesting). */
function markdown(
  dir: string,
  kind: ContextKind,
  agent: ContextFile["agent"],
  add: Add,
  extensions = [".md"],
  depth = 0,
) {
  if (depth > 3) return;
  for (const name of list(dir)) {
    const path = join(dir, name);
    if (isDir(path)) markdown(path, kind, agent, add, extensions, depth + 1);
    else if (extensions.some((ext) => name.endsWith(ext))) add(path, kind, agent);
  }
}

/** Every directory under root, to a fixed depth, skipping dependency and build folders. */
function walk(root: string): string[] {
  const dirs = [root];
  let budget = MAX_ENTRIES;
  const visit = (dir: string, depth: number) => {
    if (depth >= MAX_DEPTH) return;
    for (const name of list(dir)) {
      if (--budget < 0) return;
      if (SKIP_DIRS.has(name) || (name.startsWith(".") && name !== ".claude")) continue;
      const path = join(dir, name);
      if (!isDir(path)) continue;
      dirs.push(path);
      visit(path, depth + 1);
    }
  };
  visit(root, 0);
  return dirs;
}

function repoFiles(root: string, add: Add) {
  for (const dir of walk(root)) {
    add(join(dir, "CLAUDE.md"), "claude_md", "claude_code");
    add(join(dir, "CLAUDE.local.md"), "claude_local_md", "claude_code");
    add(join(dir, "AGENTS.md"), "agents_md", "shared");
  }
  const claude = join(root, ".claude");
  skills(join(claude, "skills"), "claude_code", add);
  markdown(join(claude, "agents"), "subagent", "claude_code", add);
  markdown(join(claude, "commands"), "command", "claude_code", add);
  markdown(join(claude, "rules"), "rule", "claude_code", add);
  skills(join(root, ".agents", "skills"), "shared", add);
  skills(join(root, ".codex", "skills"), "codex", add);
  for (const folder of ["skill", "skills"])
    skills(join(root, ".opencode", folder), "opencode", add);
  for (const folder of ["agent", "agents"]) {
    markdown(join(root, ".opencode", folder), "subagent", "opencode", add);
  }
  for (const folder of ["command", "commands"]) {
    markdown(join(root, ".opencode", folder), "command", "opencode", add);
  }
  markdown(join(root, ".cursor", "rules"), "rule", "cursor", add, [".mdc", ".md"]);
  add(join(root, ".cursorrules"), "rule", "cursor");
  skills(join(root, ".cursor", "skills"), "cursor", add);
  add(join(root, ".goosehints"), "hints", "goose");
}

function homeFiles(options: LocateOptions, add: Add) {
  const loc = locate(options);
  const claude = loc.claude_code.configDir;
  add(join(claude, "CLAUDE.md"), "claude_md", "claude_code");
  skills(join(claude, "skills"), "claude_code", add);
  markdown(join(claude, "agents"), "subagent", "claude_code", add);
  markdown(join(claude, "commands"), "command", "claude_code", add);
  markdown(join(claude, "rules"), "rule", "claude_code", add);

  const codex = loc.codex.home;
  add(join(codex, "AGENTS.md"), "agents_md", "codex");
  add(join(codex, "AGENTS.override.md"), "agents_md", "codex");
  skills(join(codex, "skills"), "codex", add);
  skills(join(options.home, ".agents", "skills"), "shared", add);

  const opencode = loc.opencode.configDir;
  add(join(opencode, "AGENTS.md"), "agents_md", "opencode");
  for (const folder of ["skill", "skills"]) skills(join(opencode, folder), "opencode", add);
  for (const folder of ["agent", "agents"])
    markdown(join(opencode, folder), "subagent", "opencode", add);
  for (const folder of ["command", "commands"]) {
    markdown(join(opencode, folder), "command", "opencode", add);
  }

  add(join(loc.goose.configDir, ".goosehints"), "hints", "goose");
  skills(join(loc.cursor.dir, "skills"), "cursor", add);
}

/**
 * Lists the context files agents already load: CLAUDE.md, AGENTS.md, skills, subagents,
 * commands, rules and hints, in the repository and in the home config. Detection only; the
 * files are not read.
 */
export function findContextFiles(options: ContextOptions): ContextFile[] {
  const files: ContextFile[] = [];
  const seen = new Set<string>();
  const collect =
    (scope: ContextFile["scope"]): Add =>
    (path, kind, agent) => {
      if (seen.has(path)) return;
      const size = fileSize(path);
      if (size === undefined) return;
      seen.add(path);
      files.push({ path, kind, scope, agent, size });
    };
  if (options.cwd !== undefined) {
    const root = repoRoot(options.cwd);
    // A repository at the home directory would list the home config twice.
    if (relative(options.home, root) !== "") repoFiles(root, collect("repo"));
  }
  homeFiles(options, collect("home"));
  return files;
}

export const CONTEXT_KIND_LABELS: Record<ContextKind, string> = {
  claude_md: "CLAUDE.md",
  claude_local_md: "CLAUDE.local.md",
  agents_md: "AGENTS.md",
  skill: "skill",
  subagent: "subagent",
  command: "command",
  rule: "rule",
  hints: "hints",
};
