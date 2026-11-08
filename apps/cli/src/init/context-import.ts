import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { CONTEXT_READERS, type ContextReader } from "@selfhost/agents";
import { buildContext, type ContextLock, LOCK_PATH, parseLock } from "@selfhost/context";
import { CONTEXT_AGENTS, maskSecrets } from "@selfhost/schema";
import { type ContextDoc, fileFolder, type McpServer, stringList } from "../scan/context/files.js";
import {
  CONTEXT_SOURCE_DIR,
  type ContextSource,
  contextSourceFiles,
  type SourceMcpServer,
  type SourceRule,
} from "./context-source.js";

export { CONTEXT_SOURCE_DIR };

/** One file an import writes. */
export interface ImportFile {
  /** Absolute path under `.selfhost/context/`. */
  path: string;
  data: string | Buffer;
  /** The context files it came from, as the scan shows them. */
  from: string[];
  /** create: written. exists: a different file is there and is left alone. same: already
   * there with these bytes. */
  action: "create" | "exists" | "same";
}

/**
 * A context file the import moved into the source. When the compile writes the same path
 * (CLAUDE.md, AGENTS.md, .mcp.json, a skill in .claude/skills, ...), it is recorded in the
 * context lock once its source file is in place, so selfhost context compile replaces it with
 * the compiled copy instead of refusing to touch a file it did not write.
 */
export interface TakeOver {
  /** Repository-relative, /-separated; a skill's folder ends with /. */
  path: string;
  /** The source files (relative to .selfhost/context) that now hold its content. */
  sources: string[];
}

export interface ContextImportPlan {
  /** The repository root. */
  root: string;
  /** `<repo>/.selfhost/context`. */
  dir: string;
  files: ImportFile[];
  takeOver: TakeOver[];
  /** Context files that are not imported, and why. */
  skipped: { path: string; reason: string }[];
  /** What the import changed on the way: merged copies, secrets left out. */
  notes: string[];
}

const RULE_KINDS = new Set([
  "claude_md",
  "agents_md",
  "gemini_md",
  "instructions",
  "rule",
  "hints",
]);
const MAX_SKILL_FILE_BYTES = 1_000_000;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** a-z, 0-9 and dashes. */
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "rule";

/** Instruction files that apply to the folder they are in; the rest apply to the repository. */
const FOLDER_KINDS = new Set(["claude_md", "agents_md", "gemini_md", "hints"]);

/** The folder a rule applies to, relative to the root; "" for the whole repository. */
function scopeFolder(doc: ContextDoc, root: string): string {
  if (!FOLDER_KINDS.has(doc.file.kind)) return "";
  return relative(root, fileFolder(doc.file.path, root)).split(sep).join("/");
}

/** The rule name for an instruction file, from its name and the folder it applies to. */
function ruleName(doc: ContextDoc, root: string): string {
  const name = basename(doc.file.path)
    .replace(/^\./, "")
    .replace(/\.instructions\.md$/, "")
    .replace(/\.(md|mdc)$/, "");
  const folder = scopeFolder(doc, root);
  return slug(folder ? `${folder}-${name}` : name);
}

function ruleGlobs(doc: ContextDoc, root: string): string[] {
  const front = doc.front;
  const globs = [
    ...stringList(front.globs),
    ...stringList(front.paths),
    ...stringList(front.applyTo),
  ];
  if (globs.length > 0) return globs;
  const folder = scopeFolder(doc, root);
  return folder ? [`${folder}/**`] : [];
}

/** Readers as the rule's agents list; none when every agent reads it. */
const agentsField = (readers: readonly ContextReader[]) =>
  CONTEXT_READERS.every((reader) => readers.includes(reader)) ? undefined : [...readers];

/**
 * Who a rule is for. The repository's own instruction files (CLAUDE.md, AGENTS.md, GEMINI.md,
 * .goosehints, .github/copilot-instructions.md) are instructions for the repository, so the rule
 * is for every agent, whichever agents happen to load that file name today. A file in one
 * agent's own rules folder (.cursor/rules, .claude/rules, .github/instructions) stays with the
 * agents that read it. An `agents` list in the front matter always wins.
 */
function ruleAgents(doc: ContextDoc): ContextReader[] | undefined {
  const declared = stringList(doc.front.agents);
  if (declared.length > 0) {
    if (declared.includes("all")) return undefined;
    return agentsField(CONTEXT_READERS.filter((reader) => declared.includes(reader)));
  }
  const repoWide =
    FOLDER_KINDS.has(doc.file.kind) ||
    (doc.file.kind === "instructions" && basename(doc.file.path) === "copilot-instructions.md");
  return repoWide ? undefined : agentsField(doc.file.readers);
}

/** A unique name: the base, then base-<agent>, then numbered. */
function unique(base: string, agent: string, taken: Set<string>): string {
  let name = taken.has(base) ? `${base}-${slug(agent)}` : base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

/** A body that only pulls in other files with `@path` adds nothing of its own. */
const onlyImports = (body: string) =>
  body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .every((line) => /^(@\S+\s*)+$/.test(line));

/** The other files in a skill folder, for copying with it. */
function skillFiles(dir: string): { path: string; data: Buffer }[] {
  const out: { path: string; data: Buffer }[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    if (entry === "SKILL.md") continue;
    const path = join(dir, entry);
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info?.isFile() || info.size > MAX_SKILL_FILE_BYTES) continue;
    out.push({ path: entry.split(sep).join("/"), data: readFileSync(path) });
  }
  return out;
}

const looksSecret = (name: string, value: string) => maskSecrets(`${name}=${value}`).masked;
const envName = (...parts: string[]) =>
  parts
    .map((part) => slug(part).replaceAll("-", "_"))
    .join("_")
    .toUpperCase();

/**
 * The server as the source writes it, with secret-looking env and header values replaced by
 * `${NAME}` references, so no secret is copied into the repository. Undefined when a secret is
 * in the command, args or url, where it cannot be swapped out.
 */
function sourceServer(server: McpServer, replaced: string[]): SourceMcpServer | undefined {
  if (
    [server.command ?? "", server.url ?? "", ...(server.args ?? [])].some(
      (value) => maskSecrets(value).masked,
    )
  ) {
    return undefined;
  }
  const scrub = (values: Record<string, string>, prefix: string[]) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        if (value.includes("${") || !looksSecret(key, value)) return [key, value];
        const variable = envName(...prefix, key);
        replaced.push(variable);
        return [
          key,
          key.toLowerCase() === "authorization" ? `Bearer \${${variable}}` : `\${${variable}}`,
        ];
      }),
    );
  if (server.command) {
    const env = scrub(server.env, []);
    return {
      command: server.command,
      ...(server.args?.length ? { args: server.args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  const headers = scrub(server.headers, [server.name]);
  return { url: server.url ?? "", ...(Object.keys(headers).length ? { headers } : {}) };
}

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function existing(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * What importing the repository's context files into `.selfhost/context/` would write. Exact
 * copies become one rule read by the agents of both. Personal files (the home folder and
 * CLAUDE.local.md) stay where they are. Nothing is written here.
 */
export function planContextImport(docs: ContextDoc[], root: string): ContextImportPlan {
  const dir = join(root, ...CONTEXT_SOURCE_DIR.split("/"));
  const source: ContextSource = { rules: [], skills: [], commands: [], agents: [], mcpServers: {} };
  const from = new Map<string, string[]>();
  const skipped: ContextImportPlan["skipped"] = [];
  const notes: string[] = [];
  const names = {
    rules: new Set<string>(),
    skills: new Set<string>(),
    commands: new Set<string>(),
    agents: new Set<string>(),
  };
  const rulesByText = new Map<string, SourceRule>();
  const claimed = new Map<string, string[]>();
  /** Records that a context file (or a skill's folder) now has its content in this source file. */
  const claim = (doc: ContextDoc, sourcePath: string, folder = false) => {
    const rel = relative(root, folder ? dirname(doc.file.path) : doc.file.path);
    const path = `${rel.split(sep).join("/")}${folder ? "/" : ""}`;
    claimed.set(path, [...(claimed.get(path) ?? []), sourcePath]);
  };
  const serverFrom = new Map<string, { display: string; spec: string }>();
  const replaced: string[] = [];

  for (const doc of docs) {
    const { file } = doc;
    if (file.scope === "home") {
      skipped.push({ path: doc.display, reason: "personal, in the home folder" });
      continue;
    }
    if (file.kind === "claude_local_md") {
      skipped.push({ path: doc.display, reason: "personal, kept out of git" });
      continue;
    }
    // An empty agents list would mean every agent; a file nobody reads stays out instead.
    if (file.readers.length === 0) {
      skipped.push({ path: doc.display, reason: "another file hides it from every agent" });
      continue;
    }
    if (RULE_KINDS.has(file.kind)) {
      if (doc.body.trim() === "" || onlyImports(doc.body)) {
        skipped.push({ path: doc.display, reason: "no text of its own" });
        continue;
      }
      const globs = ruleGlobs(doc, root);
      const key = `${globs.join(",")}\n${doc.body.trim()}`;
      const same = rulesByText.get(key);
      const agents = ruleAgents(doc);
      if (same) {
        const both = new Set([...(same.agents ?? CONTEXT_READERS), ...(agents ?? CONTEXT_READERS)]);
        same.agents = agentsField(CONTEXT_READERS.filter((reader) => both.has(reader)));
        from.get(`rules/${same.name}.md`)?.push(doc.display);
        claim(doc, `rules/${same.name}.md`);
        notes.push(`${doc.display} is a copy of rules/${same.name}.md, so it was merged into it.`);
        continue;
      }
      const description = text(doc.front.description);
      const rule: SourceRule = {
        name: unique(ruleName(doc, root), file.agent, names.rules),
        ...(agents ? { agents } : {}),
        ...(globs.length ? { globs } : {}),
        ...(description ? { description } : {}),
        body: doc.body.replace(/^\s*\n/, ""),
      };
      rulesByText.set(key, rule);
      source.rules.push(rule);
      from.set(`rules/${rule.name}.md`, [doc.display]);
      claim(doc, `rules/${rule.name}.md`);
    } else if (file.kind === "skill") {
      const folder = dirname(file.path);
      const name = unique(slug(text(doc.front.name) || basename(folder)), file.agent, names.skills);
      const metadata = doc.front.metadata as Record<string, unknown> | undefined;
      const version = text(doc.front.version) || text(metadata?.version);
      source.skills.push({
        name,
        description: text(doc.front.description),
        ...(version ? { version } : {}),
        body: doc.body.replace(/^\s*\n/, ""),
        files: skillFiles(folder),
      });
      from.set(`skills/${name}`, [doc.display]);
      claim(doc, `skills/${name}/SKILL.md`, true);
    } else if (file.kind === "command") {
      const commands =
        /[\\/]commands?[\\/](.*)\.md$/.exec(file.path)?.[1] ?? basename(file.path, ".md");
      const name = unique(slug(commands), file.agent, names.commands);
      const description = text(doc.front.description);
      // `argument-hint: [title]` reads as a YAML list; put the brackets back.
      const hint = doc.front["argument-hint"];
      const argumentHint = Array.isArray(hint)
        ? hint.map((item) => `[${String(item)}]`).join(" ")
        : text(hint);
      source.commands.push({
        name,
        ...(description ? { description } : {}),
        ...(argumentHint ? { argumentHint } : {}),
        body: doc.body.replace(/^\s*\n/, ""),
      });
      from.set(`commands/${name}.md`, [doc.display]);
      claim(doc, `commands/${name}.md`);
    } else if (file.kind === "subagent") {
      const name = unique(
        slug(text(doc.front.name) || basename(file.path, ".md")),
        file.agent,
        names.agents,
      );
      const tools = doc.front.tools;
      const model = text(doc.front.model);
      source.agents.push({
        name,
        description: text(doc.front.description),
        ...(typeof tools === "string" || Array.isArray(tools)
          ? { tools: tools as string | string[] }
          : {}),
        ...(model ? { model } : {}),
        body: doc.body.replace(/^\s*\n/, ""),
      });
      from.set(`agents/${name}.md`, [doc.display]);
      claim(doc, `agents/${name}.md`);
    } else if (file.kind === "mcp") {
      const secrets = replaced.length;
      for (const server of doc.servers) {
        const spec = JSON.stringify([
          server.command,
          server.args ?? [],
          server.url,
          server.env,
          server.headers,
        ]);
        const earlier = serverFrom.get(server.name);
        if (earlier) {
          if (earlier.spec !== spec) {
            notes.push(
              `MCP server ${server.name} is set up differently in ${earlier.display} and ${doc.display}; the one from ${earlier.display} was kept.`,
            );
          }
          continue;
        }
        const written = sourceServer(server, replaced);
        if (!written) {
          skipped.push({
            path: `${doc.display} (MCP server ${server.name})`,
            reason: "a secret is in its command, args or url; add it by hand",
          });
          continue;
        }
        serverFrom.set(server.name, { display: doc.display, spec });
        source.mcpServers[server.name] = written;
      }
      if (doc.servers.some((server) => serverFrom.get(server.name)?.display === doc.display)) {
        from.set("mcp.json", [...(from.get("mcp.json") ?? []), doc.display]);
      }
      // Only a file whose every server was copied as it is, no secret swapped out, is handed over.
      if (
        replaced.length === secrets &&
        doc.servers.every((server) => serverFrom.get(server.name)?.display === doc.display)
      ) {
        claim(doc, "mcp.json");
      }
    }
  }
  if (replaced.length > 0) {
    notes.push(
      `Secret values in MCP env and headers were not copied; mcp.json reads them from ${[...new Set(replaced)].map((name) => `\${${name}}`).join(", ")}.`,
    );
  }

  const files = contextSourceFiles(source).map((entry): ImportFile => {
    const path = join(dir, ...entry.path.split("/"));
    const before = existing(path);
    const key = entry.path.startsWith("skills/")
      ? entry.path.split("/").slice(0, 2).join("/")
      : entry.path;
    return {
      path,
      data: entry.data,
      from: from.get(key) ?? [],
      action: before === null ? "create" : sha(before) === sha(entry.data) ? "same" : "exists",
    };
  });
  const takeOver = [...claimed].map(([path, sources]) => ({ path, sources }));
  return { root, dir, files, takeOver, skipped, notes };
}

/**
 * Records in the context lock the files the import handed over to the compile: each file the
 * compile would refuse to replace because selfhost did not write it, when it is one the import
 * read and its source file is in place. Each goes in with the hash it has now, so the next
 * compile replaces it. Returns the lock's path when this made a new lock, for the init record.
 */
async function recordTakeOver(plan: ContextImportPlan): Promise<string | undefined> {
  const inPlace = new Set(
    plan.files
      .filter((file) => file.action !== "exists")
      .map((file) => relative(plan.dir, file.path).split(sep).join("/")),
  );
  const lockPath = join(plan.root, ...LOCK_PATH.split("/"));
  const current = existsSync(lockPath) ? parseLock(readFileSync(lockPath, "utf8")) : undefined;
  if (existsSync(lockPath) && !current) return undefined;
  const built = await buildContext(plan.root);
  if (!built.ok) return undefined;
  const refused = new Set(built.plan.conflicts.map((conflict) => conflict.path));
  const imported = (path: string) =>
    plan.takeOver.find((entry) =>
      entry.path.endsWith("/") ? path.startsWith(entry.path) : entry.path === path,
    );
  const lock: ContextLock = current ?? {
    schema: "selfhost.context_lock/v1",
    agents: [...CONTEXT_AGENTS],
    skills: {},
    files: {},
  };
  let recorded = 0;
  for (const file of built.result.files) {
    if (!refused.has(file.path) || (file.content.kind !== "text" && file.content.kind !== "bytes"))
      continue;
    const entry = imported(file.path);
    if (!entry?.sources.every((source) => inPlace.has(source))) continue;
    const bytes = existing(join(plan.root, ...file.path.split("/")));
    if (bytes === null) continue;
    lock.files[file.path] = { sources: file.sources, header: file.header, sha256: sha(bytes) };
    recorded += 1;
  }
  if (recorded === 0) return undefined;
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return current ? undefined : lockPath;
}

/**
 * Writes the plan's new files, never replacing one, and returns the paths it wrote (a new
 * context lock among them). The files the import moved into the source (CLAUDE.md and the
 * like) are recorded in the context lock, so the next selfhost context compile takes them over.
 */
export async function applyContextImport(plan: ContextImportPlan): Promise<string[]> {
  const written: string[] = [];
  for (const file of plan.files) {
    if (file.action !== "create") continue;
    mkdirSync(dirname(file.path), { recursive: true });
    try {
      writeFileSync(file.path, file.data, { flag: "wx" });
      written.push(file.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      file.action = "exists";
    }
  }
  const lock = await recordTakeOver(plan);
  return lock ? [...written, lock] : written;
}
