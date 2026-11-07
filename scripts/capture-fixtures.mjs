#!/usr/bin/env node
// Copies the most recent Claude Code and Codex session logs from this machine,
// scrubs them, writes them under fixtures/captured/, then runs the scrub check.
//
// Scrubbing keeps structure (keys, nesting, value types, enum values, ids,
// timestamps, token counts, model ids, CLI versions) and replaces prompts,
// message text, file contents, tool inputs and outputs with placeholder text of
// the same length. Paths are rewritten to /home/dev/<project-N>, branches and
// commit hashes are pseudonymised, and emails and tokens are removed.
//
// Usage:
//   node scripts/capture-fixtures.mjs [--count 3] [--out fixtures/captured]
//       [--claude-dir ~/.claude] [--codex-dir ~/.codex] [--no-claude] [--no-codex]
//
// Review the output before committing it. The scrub check is a safety net, not a proof.

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { looksSensitive, scanDir } from "./scrub-check.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function parseArgs(argv) {
  const opts = {
    count: 3,
    out: join(REPO_ROOT, "fixtures", "captured"),
    claudeDir: process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), ".claude"),
    codexDir: process.env.CODEX_HOME || join(os.homedir(), ".codex"),
    claude: true,
    codex: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--count") opts.count = Number(argv[++i]);
    else if (a === "--out") opts.out = resolve(argv[++i]);
    else if (a === "--claude-dir") opts.claudeDir = resolve(argv[++i]);
    else if (a === "--codex-dir") opts.codexDir = resolve(argv[++i]);
    else if (a === "--no-claude") opts.claude = false;
    else if (a === "--no-codex") opts.codex = false;
    else if (a === "-h" || a === "--help") {
      console.log(
        readFileSync(fileURLToPath(import.meta.url), "utf8")
          .split("\n")
          .slice(1, 14)
          .join("\n")
          .replace(/^\/\/ ?/gm, ""),
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.count) || opts.count < 1) {
    console.error("--count must be a positive integer");
    process.exit(2);
  }
  return opts;
}

// ---------------------------------------------------------------- file discovery

function listFiles(dir, match, recursive) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && recursive) out.push(...listFiles(full, match, recursive));
    else if (entry.isFile() && match(entry.name)) out.push(full);
  }
  return out;
}

function newest(files, n) {
  return files
    .map((f) => [f, statSync(f).mtimeMs])
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([f]) => f);
}

function claudeSessions(claudeDir, n) {
  const projects = join(claudeDir, "projects");
  if (!existsSync(projects)) return [];
  const files = [];
  for (const d of readdirSync(projects, { withFileTypes: true })) {
    if (d.isDirectory())
      files.push(...listFiles(join(projects, d.name), (f) => f.endsWith(".jsonl"), false));
  }
  return newest(files, n);
}

function codexSessions(codexDir, n) {
  return newest(
    listFiles(join(codexDir, "sessions"), (f) => /^rollout-.*\.jsonl$/.test(f), true),
    n,
  );
}

// ---------------------------------------------------------------- scrubber

const SALT = randomBytes(16).toString("hex");
const HOME = os.homedir();

const ENUM_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const TZ_RE = /^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2})$/;

const ENUM_KEYS = new Set([
  "type",
  "subtype",
  "role",
  "model",
  "version",
  "cli_version",
  "stop_reason",
  "level",
  "operation",
  "userType",
  "entrypoint",
  "permissionMode",
  "permission_mode",
  "effort",
  "perTurnEffort",
  "requestedModel",
  "advisorModel",
  "service_tier",
  "speed",
  "inference_geo",
  "thinkingDisplay",
  "decision",
  "source",
  "reasonType",
  "reasonCode",
  "ruleSource",
  "grantScope",
  "kind",
  "promptSource",
  "turnOrigin",
  "hookEvent",
  "hookName",
  "originator",
  "model_provider",
  "approval_policy",
  "personality",
  "summary",
  "mode",
  "phase",
  "status",
  "plan_type",
  "limit_id",
  "namespace",
  "collaboration_mode_kind",
  "access",
  "trigger",
  "reason",
  "stopReason",
  "reasoning_effort",
  "multi_agent_version",
  "network",
  "thread_source",
  "memory_mode",
  "producer",
  "renderedRole",
  "media_type",
  "notification_type",
  "hook_event_name",
  "circuitBreaker",
  "comp_hash",
  "returnCodeInterpretation",
  "agent_type",
  "agent_role",
  "new_agent_role",
  "rate_limit_reached_type",
]);
const ID_KEY_RE = /(^id$|_id$|Id$|ID$|uuid$|Uuid$|UUID$|^requestRef$|^runId$|^leafUuid$)/;
const TIME_KEYS = new Set(["timestamp", "backupTime", "current_date", "date"]);
const PATH_KEYS = new Set([
  "cwd",
  "file_path",
  "filePath",
  "path",
  "workdir",
  "transcript_path",
  "agent_transcript_path",
  "realParentDir",
  "displayPath",
  "filename",
  "persistedOutputPath",
  "move_path",
  "notebook_path",
  "planFilePath",
  "scratchpad_dir",
  "workspace_roots",
  "changedFiles",
  "agent_path",
]);
const OPAQUE_KEYS = new Set(["signature", "encrypted_content", "base64", "data"]);
const TOOL_PARENT_TYPES = new Set([
  "tool_use",
  "function_call",
  "custom_tool_call",
  "function",
  "namespace",
  "server_tool_use",
  "tool_reference",
]);

// Leading programs (and subcommands) kept in shell commands so importers can still
// spot test runs and git commits. Everything after them is masked.
const PROGRAMS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "pip",
  "pytest",
  "uv",
  "cargo",
  "go",
  "make",
  "docker",
  "gh",
  "rg",
  "grep",
  "sed",
  "cat",
  "ls",
  "find",
  "head",
  "tail",
  "wc",
  "echo",
  "cd",
  "mkdir",
  "rm",
  "mv",
  "cp",
  "touch",
  "zsh",
  "bash",
  "sh",
  "vitest",
  "jest",
  "tsc",
  "eslint",
  "prettier",
  "curl",
]);
const SUBCOMMAND_PROGRAMS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "go",
  "docker",
  "gh",
  "uv",
]);

const KEEP_SEGMENTS = new Set([
  "src",
  "lib",
  "test",
  "tests",
  "spec",
  "app",
  "apps",
  "docs",
  "scripts",
  "bin",
  "packages",
  "components",
  "pages",
  "public",
  "dist",
  "build",
  "node_modules",
  ".github",
  "workflows",
  ".claude",
  ".codex",
  "projects",
  "sessions",
  "subagents",
  "tasks",
  "scratchpad",
  "plugins",
  "skills",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "README.md",
  "CLAUDE.md",
  "AGENTS.md",
  ".gitignore",
  "Dockerfile",
  "Makefile",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  ".env",
  "tmp",
]);

class Scrubber {
  constructor() {
    this.projects = new Map(); // real root -> project-N
    this.branches = new Map();
    this.repos = new Map();
    this.pseudo = new Map();
  }

  hash(s, n = 6) {
    return createHash("sha256")
      .update(SALT + s)
      .digest("hex")
      .slice(0, n);
  }

  registerProject(cwd) {
    if (typeof cwd !== "string" || !cwd.startsWith("/")) return;
    const norm = cwd.replace(/\/+$/, "");
    const home = norm.match(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)$/);
    if (home || norm === HOME) return;
    if (!this.projects.has(norm)) this.projects.set(norm, `project-${this.projects.size + 1}`);
  }

  projectName(cwd) {
    return this.projects.get((cwd || "").replace(/\/+$/, ""));
  }

  encodeDir(p) {
    return p.replace(/[^A-Za-z0-9]/g, "-");
  }

  segment(seg) {
    if (!seg || seg === "." || seg === "..") return seg;
    if (KEEP_SEGMENTS.has(seg)) return seg;
    if (/^\d{1,4}$/.test(seg)) return seg;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jsonl?)?$/i.test(seg))
      return seg;
    if (/^rollout-[0-9T-]+-[0-9a-f-]{36}\.jsonl$/.test(seg)) return seg;
    if (/^agent-[0-9a-f]{6,}\.jsonl$/.test(seg)) return seg;
    if (seg.startsWith("-")) {
      for (const [root, name] of this.projects)
        if (seg === this.encodeDir(root)) return this.encodeDir(`/home/dev/${name}`);
      return `-home-dev-dir-${this.hash(seg)}`;
    }
    if (!this.pseudo.has(seg)) {
      const ext = seg.match(/(\.[A-Za-z0-9]{1,8})$/);
      const isFile = Boolean(ext) && !seg.startsWith(".");
      this.pseudo.set(
        seg,
        isFile
          ? `file-${this.hash(seg)}${ext[1]}`
          : `${seg.startsWith(".") ? "." : ""}dir-${this.hash(seg)}`,
      );
    }
    return this.pseudo.get(seg);
  }

  segments(rest) {
    return rest
      .split("/")
      .map((s) => this.segment(s))
      .join("/");
  }

  path(p) {
    if (typeof p !== "string" || !p) return p;
    let s = p.replace(/\\/g, "/");
    if (s.startsWith("~/")) s = HOME + s.slice(1);
    const roots = [...this.projects.keys()].sort((a, b) => b.length - a.length);
    for (const root of roots) {
      if (s === root || s.startsWith(`${root}/`))
        return `/home/dev/${this.projects.get(root)}${this.segments(s.slice(root.length))}`;
    }
    const home = s.match(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/);
    if (home) return `/home/dev${this.segments(s.slice(home[1].length))}`;
    const tmp = s.match(
      /^(\/private\/var\/folders\/[^/]+\/[^/]+|\/var\/folders\/[^/]+\/[^/]+|\/private\/tmp|\/tmp)(?=\/|$)/,
    );
    if (tmp) return `/tmp${this.segments(s.slice(tmp[1].length))}`;
    if (/^\/(usr|bin|sbin|etc|opt\/homebrew)\//.test(s)) return s;
    if (s.startsWith("/")) return this.segments(s);
    return this.segments(s);
  }

  branch(b) {
    if (typeof b !== "string") return b;
    if (["main", "master", "develop", "development", "HEAD", ""].includes(b)) return b;
    if (!this.branches.has(b)) this.branches.set(b, `branch-${this.branches.size + 1}`);
    return this.branches.get(b);
  }

  repo(u) {
    if (typeof u !== "string" || !u) return u;
    if (!this.repos.has(u))
      this.repos.set(u, `https://github.com/example/repo-${this.repos.size + 1}.git`);
    return this.repos.get(u);
  }

  mask(s) {
    // Same length and line structure, nothing readable.
    return s.replace(/[^\s]/g, "x");
  }

  text(s) {
    // Fixed CLI templates keep their wording; only their paths change.
    const templates = [
      /^(The file )(\S+)( has been updated successfully\.)$/,
      /^(File created successfully at: )(\S+)$/,
    ];
    for (const re of templates) {
      const m = s.match(re);
      if (m) return m[1] + this.path(m[2]) + (m[3] ?? "");
    }
    const lines = s.split("\n");
    const numbered = lines.filter((l) => /^\d+\t/.test(l)).length;
    if (lines.length > 1 && numbered >= lines.length * 0.8) {
      return lines
        .map((l) => l.replace(/^(\d+\t)(.*)$/, (_, n, rest) => n + this.mask(rest)))
        .map((l) => (/^\d+\t/.test(l) ? l : this.mask(l)))
        .join("\n");
    }
    const header =
      /^(Error: )?Exit code \d+$|^Chunk ID: [0-9a-f]+$|^Wall time: [0-9.]+ seconds$|^Process exited with code -?\d+$|^Process running with session ID \d+$|^Original token count: \d+$|^Output:$|^Exit code: -?\d+$|^Success\. Updated the following files:$/;
    if (lines.some((l) => header.test(l))) {
      return lines.map((l) => (header.test(l) ? l : this.mask(l))).join("\n");
    }
    return this.mask(s);
  }

  command(s) {
    return s
      .split(/(\s*(?:&&|\|\||;|\||\n)\s*)/)
      .map((part, i) => {
        if (i % 2 === 1) return part;
        const tokens = part.split(/(\s+)/);
        let kept = 0;
        if (PROGRAMS.has(tokens[0])) {
          kept = 1;
          if (SUBCOMMAND_PROGRAMS.has(tokens[0]) && /^[a-z][a-z-]{1,20}$/.test(tokens[2] ?? ""))
            kept = 3;
        }
        return tokens.map((t, j) => (j < kept || /^\s+$/.test(t) ? t : this.mask(t))).join("");
      })
      .join("");
  }

  patchBody(s) {
    return s
      .split("\n")
      .map((l) => {
        let m = l.match(/^(\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: )(.*)$/);
        if (m) return m[1] + this.path(m[2]);
        if (/^\*\*\* (Begin|End) Patch$|^\*\*\* End of File$/.test(l)) return l;
        if (l.startsWith("@@")) return "@@";
        m = l.match(/^([+\- ])(.*)$/);
        if (m) return m[1] + this.mask(m[2]);
        return this.mask(l);
      })
      .join("\n");
  }

  diffLines(lines) {
    return lines.map((l) =>
      typeof l === "string"
        ? l.match(/^[+\- \\]/)
          ? l[0] + this.mask(l.slice(1))
          : this.mask(l)
        : this.value(l),
    );
  }

  unifiedDiff(s) {
    return s
      .split("\n")
      .map((l) =>
        /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(l)
          ? l.replace(/^(@@ [^@]+ @@).*$/, "$1")
          : l.match(/^[+\- ]/)
            ? l[0] + this.mask(l.slice(1))
            : this.mask(l),
      )
      .join("\n");
  }

  key(k, parentKey) {
    if (k.includes("/") || parentKey === "trackedFileBackups" || parentKey === "changes")
      return this.path(k);
    if (/^[A-Za-z0-9_$\-.:@]{1,80}$/.test(k)) return k;
    return `key-${this.hash(k)}`;
  }

  string(s, key, parent) {
    if (s === "<synthetic>") return s;
    if (key === "gitBranch" || key === "branch") return this.branch(s);
    if (key === "commit_hash") return this.hash(s, 40);
    if (key === "repository_url") return this.repo(s);
    if (key === "timezone" && TZ_RE.test(s)) return s;
    if (key === "originator" && /^[A-Za-z0-9_. -]{1,40}$/.test(s)) return s;
    if (PATH_KEYS.has(key)) return this.path(s);
    if (OPAQUE_KEYS.has(key)) return "A".repeat(s.length);
    if (TIME_KEYS.has(key) && ISO_RE.test(s)) return s;
    if (ID_KEY_RE.test(key) && ID_RE.test(s)) return s;
    if (key === "name" && parent && TOOL_PARENT_TYPES.has(parent.type) && ENUM_RE.test(s)) return s;
    if (ENUM_KEYS.has(key) && ENUM_RE.test(s)) return s;
    if (key === "arguments") {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === "object") return JSON.stringify(this.value(parsed));
      } catch {}
    }
    if (key === "input" && parent && parent.name === "apply_patch") return this.patchBody(s);
    if (key === "command" || key === "cmd") return this.command(s);
    if (key === "unified_diff") return this.unifiedDiff(s);
    if (key === "output") {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === "object") return JSON.stringify(this.value(parsed));
      } catch {}
    }
    return this.text(s);
  }

  value(v, key = "", parent = null) {
    if (v === null || typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "string") {
      const out = this.string(v, key, parent);
      return looksSensitive(out) ? this.mask(out) : out;
    }
    if (Array.isArray(v)) {
      if (key === "lines") return this.diffLines(v);
      return v.map((x) => this.value(x, key, parent));
    }
    const out = {};
    for (const [k, x] of Object.entries(v)) out[this.key(k, key)] = this.value(x, k, v);
    return out;
  }
}

// ---------------------------------------------------------------- capture

function readJsonl(file) {
  const rows = [];
  let bad = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
  return { rows, bad };
}

function writeJsonl(file, rows) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

function captureClaude(files, scrubber, out) {
  const results = [];
  for (const file of files) {
    const { rows, bad } = readJsonl(file);
    const cwds = rows.map((r) => r?.cwd).filter(Boolean);
    for (const c of cwds) scrubber.registerProject(c);
    const scrubbed = rows.map((r) => scrubber.value(r));
    const project =
      scrubber.projectName(cwds[0]) || `dir-${scrubber.hash(basename(dirname(file)))}`;
    const dest = join(
      out,
      "claude-code",
      "projects",
      scrubber.encodeDir(`/home/dev/${project}`),
      basename(file),
    );
    writeJsonl(dest, scrubbed);
    const versions = [
      ...new Set(
        rows.map((r) => r?.version).filter((v) => typeof v === "string" && ENUM_RE.test(v)),
      ),
    ];
    results.push({
      path: relative(out, dest),
      cliVersions: versions,
      lines: scrubbed.length,
      unparsedLinesDropped: bad,
    });
  }
  return results;
}

function captureCodex(files, scrubber, out, codexDir) {
  const results = [];
  for (const file of files) {
    const { rows, bad } = readJsonl(file);
    for (const r of rows) {
      if (r && (r.type === "session_meta" || r.type === "turn_context") && r.payload)
        scrubber.registerProject(r.payload.cwd);
    }
    const scrubbed = rows.map((r) => scrubber.value(r));
    const rel = relative(join(codexDir, "sessions"), file);
    const dest = join(out, "codex", "sessions", rel);
    writeJsonl(dest, scrubbed);
    const versions = [
      ...new Set(
        rows
          .filter((r) => r && r.type === "session_meta")
          .map((r) => r.payload?.cli_version)
          .filter((v) => typeof v === "string" && ENUM_RE.test(v)),
      ),
    ];
    results.push({
      path: relative(out, dest),
      cliVersions: versions,
      lines: scrubbed.length,
      unparsedLinesDropped: bad,
    });
  }
  return results;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (existsSync(opts.out)) rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(opts.out, { recursive: true });
  const scrubber = new Scrubber();
  const manifest = {
    capturedAt: new Date().toISOString().slice(0, 10),
    scrubbed: true,
    claudeCode: [],
    codex: [],
  };
  if (opts.claude)
    manifest.claudeCode = captureClaude(
      claudeSessions(opts.claudeDir, opts.count),
      scrubber,
      opts.out,
    );
  if (opts.codex)
    manifest.codex = captureCodex(
      codexSessions(opts.codexDir, opts.count),
      scrubber,
      opts.out,
      opts.codexDir,
    );
  manifest.cliVersions = {
    claudeCode: [...new Set(manifest.claudeCode.flatMap((f) => f.cliVersions))],
    codex: [...new Set(manifest.codex.flatMap((f) => f.cliVersions))],
  };
  writeFileSync(join(opts.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `captured ${manifest.claudeCode.length} Claude Code and ${manifest.codex.length} Codex session(s) into ${relative(process.cwd(), opts.out) || "."}`,
  );

  const { files, findings } = scanDir(opts.out);
  if (findings.length) {
    console.error(
      `scrub-check failed with ${findings.length} finding(s); fix the scrubber before committing:`,
    );
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`scrub-check: ${files} file(s) clean`);
}

main();
