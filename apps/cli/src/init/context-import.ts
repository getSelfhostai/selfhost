import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { CONTEXT_READERS, type ContextReader } from "@selfhost/agents";
import { maskSecrets } from "@selfhost/schema";
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

export interface ContextImportPlan {
  /** `<repo>/.selfhost/context`. */
  dir: string;
  files: ImportFile[];
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
const agentsField = (readers: ContextReader[]) =>
  CONTEXT_READERS.every((reader) => readers.includes(reader)) ? undefined : [...readers];

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
      if (same) {
        const agents = new Set([...(same.agents ?? CONTEXT_READERS), ...file.readers]);
        same.agents = agentsField(CONTEXT_READERS.filter((reader) => agents.has(reader)));
        from.get(`rules/${same.name}.md`)?.push(doc.display);
        notes.push(`${doc.display} is a copy of rules/${same.name}.md, so it was merged into it.`);
        continue;
      }
      const description = text(doc.front.description);
      const rule: SourceRule = {
        name: unique(ruleName(doc, root), file.agent, names.rules),
        ...(agentsField(file.readers) ? { agents: agentsField(file.readers) } : {}),
        ...(globs.length ? { globs } : {}),
        ...(description ? { description } : {}),
        body: doc.body.replace(/^\s*\n/, ""),
      };
      rulesByText.set(key, rule);
      source.rules.push(rule);
      from.set(`rules/${rule.name}.md`, [doc.display]);
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
    } else if (file.kind === "mcp") {
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
  return { dir, files, skipped, notes };
}

/** Writes the plan's new files, never replacing one, and returns the paths it wrote. */
export function applyContextImport(plan: ContextImportPlan): string[] {
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
  return written;
}
