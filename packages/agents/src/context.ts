import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { locate } from "./locations.js";
import type { LocateOptions } from "./types.js";

export type ContextKind =
  | "claude_md"
  | "claude_local_md"
  | "agents_md"
  | "gemini_md"
  | "instructions"
  | "skill"
  | "subagent"
  | "command"
  | "rule"
  | "hints"
  | "mcp";

/**
 * Agents that read context files. Wider than the agents selfhost configures: Copilot and Gemini
 * CLI read the same repository files, so they count when asking who sees a rule.
 */
export const CONTEXT_READERS = [
  "claude_code",
  "codex",
  "cursor",
  "copilot",
  "gemini",
  "opencode",
  "goose",
] as const;

export type ContextReader = (typeof CONTEXT_READERS)[number];

export const CONTEXT_READER_NAMES: Record<ContextReader, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  goose: "Goose",
};

export interface ContextFile {
  path: string;
  kind: ContextKind;
  scope: "repo" | "home";
  /** The agent the file belongs to; "shared" for AGENTS.md and Agent Skills. */
  agent: ContextReader | "shared";
  /**
   * Every agent that reads the file with default settings, after one file hides another: Claude
   * Code skips AGENTS.md when a CLAUDE.md is in the same folder or above, OpenCode skips CLAUDE.md
   * next to an AGENTS.md, and Codex reads AGENTS.override.md instead of AGENTS.md. Empty when
   * another file hides it from every agent.
   */
  readers: ContextReader[];
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

/** File names an agent loads from every folder of the repository it works in. */
const FOLDER_FILES: [name: string, kind: ContextKind, agent: ContextFile["agent"]][] = [
  ["CLAUDE.md", "claude_md", "claude_code"],
  ["CLAUDE.local.md", "claude_local_md", "claude_code"],
  ["AGENTS.md", "agents_md", "shared"],
  ["AGENTS.override.md", "agents_md", "codex"],
  ["GEMINI.md", "gemini_md", "gemini"],
  [".goosehints", "hints", "goose"],
];

/** Readers of AGENTS.md in a repository folder, before Claude Code's and Codex's checks. */
const AGENTS_MD_READERS: ContextReader[] = ["codex", "cursor", "copilot", "opencode", "goose"];

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
    for (const [name, kind, agent] of FOLDER_FILES) add(join(dir, name), kind, agent);
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
  add(join(root, ".github", "copilot-instructions.md"), "instructions", "copilot");
  markdown(join(root, ".github", "instructions"), "instructions", "copilot", add, [
    ".instructions.md",
  ]);
  add(join(root, ".mcp.json"), "mcp", "claude_code");
  add(join(root, ".cursor", "mcp.json"), "mcp", "cursor");
  add(join(root, ".codex", "config.toml"), "mcp", "codex");
  add(join(root, "opencode.json"), "mcp", "opencode");
  add(join(root, "opencode.jsonc"), "mcp", "opencode");
  add(join(root, ".vscode", "mcp.json"), "mcp", "copilot");
  add(join(root, ".gemini", "settings.json"), "mcp", "gemini");
}

function homeFiles(options: LocateOptions, add: Add) {
  const loc = locate(options);
  const claude = loc.claude_code.configDir;
  add(join(claude, "CLAUDE.md"), "claude_md", "claude_code");
  skills(join(claude, "skills"), "claude_code", add);
  markdown(join(claude, "agents"), "subagent", "claude_code", add);
  markdown(join(claude, "commands"), "command", "claude_code", add);
  markdown(join(claude, "rules"), "rule", "claude_code", add);
  add(loc.claude_code.globalConfig, "mcp", "claude_code");

  const codex = loc.codex.home;
  add(join(codex, "AGENTS.md"), "agents_md", "codex");
  add(join(codex, "AGENTS.override.md"), "agents_md", "codex");
  skills(join(codex, "skills"), "codex", add);
  skills(join(options.home, ".agents", "skills"), "shared", add);
  add(loc.codex.config, "mcp", "codex");

  const opencode = loc.opencode.configDir;
  add(join(opencode, "AGENTS.md"), "agents_md", "opencode");
  for (const folder of ["skill", "skills"]) skills(join(opencode, folder), "opencode", add);
  for (const folder of ["agent", "agents"])
    markdown(join(opencode, folder), "subagent", "opencode", add);
  for (const folder of ["command", "commands"]) {
    markdown(join(opencode, folder), "command", "opencode", add);
  }
  add(loc.opencode.config, "mcp", "opencode");

  add(join(loc.goose.configDir, ".goosehints"), "hints", "goose");
  add(join(loc.goose.configDir, "AGENTS.md"), "agents_md", "goose");
  add(loc.goose.config, "mcp", "goose");
  skills(join(loc.cursor.dir, "skills"), "cursor", add);
  add(loc.cursor.mcp, "mcp", "cursor");

  add(loc.copilot.instructions, "instructions", "copilot");
  markdown(join(loc.copilot.dir, "instructions"), "instructions", "copilot", add, [
    ".instructions.md",
  ]);
  add(loc.copilot.mcp, "mcp", "copilot");
  add(join(loc.gemini.dir, "GEMINI.md"), "gemini_md", "gemini");
  add(loc.gemini.settings, "mcp", "gemini");
}

const truthy = (value: string | undefined) => value !== undefined && /^(1|true)$/i.test(value);

/** Folders from dir up to root, dir first. */
function folders(dir: string, root: string): string[] {
  const out = [dir];
  let current = dir;
  while (current !== root && current.startsWith(root + sep)) {
    current = dirname(current);
    out.push(current);
  }
  return out;
}

/**
 * Who reads each file, from the vendors' docs (November 2026):
 *
 * - Claude Code: https://code.claude.com/docs/en/memory (AGENTS.md only with no CLAUDE.md,
 *   .claude/CLAUDE.md or CLAUDE.local.md in the folder or above)
 * - Codex: AGENTS.override.md, else AGENTS.md, per folder and in CODEX_HOME
 * - Cursor: .cursor/rules, AGENTS.md, and the CLI reads CLAUDE.md at the root
 * - Copilot: .github/copilot-instructions.md, .github/instructions, AGENTS.md, and CLAUDE.md,
 *   .claude/CLAUDE.md and GEMINI.md at the root
 * - OpenCode: AGENTS.md, else CLAUDE.md; ~/.config/opencode/AGENTS.md, else ~/.claude/CLAUDE.md;
 *   .claude/skills and .agents/skills (OPENCODE_DISABLE_CLAUDE_CODE turns the .claude ones off)
 * - Goose: AGENTS.md and .goosehints in each folder and in its config folder
 * - Gemini CLI: GEMINI.md in each folder and ~/.gemini/GEMINI.md
 */
function readersOf(
  file: Omit<ContextFile, "readers">,
  present: ReadonlySet<string>,
  root: string | undefined,
  options: ContextOptions,
): ContextReader[] {
  const env = options.env ?? {};
  const noClaudeCompat = truthy(env.OPENCODE_DISABLE_CLAUDE_CODE);
  const has = (path: string) => present.has(path);
  const name = basename(file.path);
  if (file.scope === "home") {
    const loc = locate(options);
    if (file.kind === "claude_md") {
      const opencode =
        !noClaudeCompat &&
        !truthy(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT) &&
        !has(join(loc.opencode.configDir, "AGENTS.md"));
      return opencode ? ["claude_code", "opencode"] : ["claude_code"];
    }
    if (file.path === join(loc.codex.home, "AGENTS.md")) {
      return has(join(loc.codex.home, "AGENTS.override.md")) ? [] : ["codex"];
    }
    if (file.kind === "skill" && file.agent === "claude_code" && !noClaudeCompat) {
      return ["claude_code", "opencode"];
    }
    if (file.agent === "shared") return ["codex", "opencode"];
    return [file.agent];
  }

  const top = root ?? dirname(file.path);
  const dir = dirname(file.path);
  // .claude/CLAUDE.md and .claude/AGENTS.md count as the root's own files.
  const level = basename(dir) === ".claude" && dirname(dir) === top ? top : dir;
  const claudeFilesAt = (folder: string) =>
    has(join(folder, "CLAUDE.md")) ||
    has(join(folder, "CLAUDE.local.md")) ||
    has(join(folder, ".claude", "CLAUDE.md"));
  const atRoot = level === top;
  if (file.kind === "claude_md") {
    const readers: ContextReader[] = ["claude_code"];
    if (atRoot && name === "CLAUDE.md" && level === dir) readers.push("cursor");
    if (atRoot) readers.push("copilot");
    if (!has(join(level, "AGENTS.md")) && level === dir && !noClaudeCompat) {
      readers.push("opencode");
    }
    return readers;
  }
  if (file.kind === "agents_md" && name === "AGENTS.override.md") return ["codex"];
  if (file.kind === "agents_md") {
    const claude = !folders(level, top).some(claudeFilesAt);
    // Only Claude Code looks in .claude/ for AGENTS.md.
    if (level !== dir) return claude ? ["claude_code"] : [];
    const readers = AGENTS_MD_READERS.filter(
      (reader) => reader !== "codex" || !has(join(level, "AGENTS.override.md")),
    );
    return claude ? ["claude_code", ...readers] : readers;
  }
  if (file.kind === "gemini_md") return atRoot ? ["gemini", "copilot"] : ["gemini"];
  if (file.kind === "skill" && file.agent === "claude_code" && !noClaudeCompat) {
    return ["claude_code", "opencode"];
  }
  if (file.agent === "shared") return ["codex", "opencode"];
  return [file.agent];
}

/**
 * Lists the context files agents already load: CLAUDE.md, AGENTS.md, GEMINI.md, Copilot
 * instructions, skills, subagents, commands, rules, hints and MCP configs, in the repository and
 * in the home config, with who reads each one. Detection only; the files are not read.
 */
export function findContextFiles(options: ContextOptions): ContextFile[] {
  const files: Omit<ContextFile, "readers">[] = [];
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
  let root: string | undefined;
  if (options.cwd !== undefined) {
    root = repoRoot(options.cwd);
    // A repository at the home directory would list the home config twice.
    if (relative(options.home, root) !== "") repoFiles(root, collect("repo"));
    else root = undefined;
  }
  homeFiles(options, collect("home"));
  return files.map((file) => ({ ...file, readers: readersOf(file, seen, root, options) }));
}

export const CONTEXT_KIND_LABELS: Record<ContextKind, string> = {
  claude_md: "CLAUDE.md",
  claude_local_md: "CLAUDE.local.md",
  agents_md: "AGENTS.md",
  gemini_md: "GEMINI.md",
  instructions: "instructions",
  skill: "skill",
  subagent: "subagent",
  command: "command",
  rule: "rule",
  hints: "hints",
  mcp: "MCP config",
};
