import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTEXT_AGENTS,
  type ContextAgent,
  formatField,
  lazyCheck,
  type Segment,
  schemaErrors,
} from "@selfhost/schema";
import type { TSchema } from "@sinclair/typebox";
import type { TypeCheck } from "@sinclair/typebox/compiler";
import { parseLocated, splitFrontMatter } from "./frontmatter.js";
import type {
  CommandFrontMatter,
  McpFile,
  RuleFrontMatter,
  SkillFrontMatter,
  SubagentFrontMatter,
} from "./schema.js";
import {
  CONTEXT_DIR,
  CommandFrontMatterSchema,
  ITEM_NAME_PATTERN,
  McpFileSchema,
  mcpServerProblem,
  RuleFrontMatterSchema,
  SkillFrontMatterSchema,
  SubagentFrontMatterSchema,
} from "./schema.js";
import type {
  ContextCommand,
  ContextError,
  ContextMcpServer,
  ContextRule,
  ContextSkill,
  ContextSource,
  ContextSubagent,
  ModelChoice,
  RulerFile,
  SkillFile,
} from "./types.js";

export type ReadResult =
  | { ok: true; source: ContextSource; ruler: RulerFile[] }
  | { ok: false; errors: ContextError[] };

/** Files the OS or an editor drops into folders, never compiled. */
const IGNORED = new Set([".DS_Store", "Thumbs.db"]);

const TOP_LEVEL = new Set(["rules", "skills", "commands", "agents", "mcp.json", "README.md"]);

const KEYS: Record<string, string> = {
  rule: "agents, globs and description",
  command: "description, argument-hint and agents",
  agent: "name, description, tools, model and agents",
  mcp: "type, command, args, env, url, headers and agents",
};

const checks = {
  rule: lazyCheck(RuleFrontMatterSchema),
  skill: lazyCheck(SkillFrontMatterSchema),
  command: lazyCheck(CommandFrontMatterSchema),
  agent: lazyCheck(SubagentFrontMatterSchema),
  mcp: lazyCheck(McpFileSchema),
};

type Check = () => TypeCheck<TSchema>;

interface Read<T> {
  data: T;
  body: string;
  lineOf: (segments: readonly Segment[]) => number | undefined;
}

const posix = (...parts: string[]) => parts.filter((part) => part !== "").join("/");

function entries(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !IGNORED.has(name))
    .sort();
}

/** `all` (or no list) means every agent; the result is in CONTEXT_AGENTS order. */
export function resolveAgents(list: readonly string[] | undefined): ContextAgent[] {
  if (list === undefined || list.includes("all")) return [...CONTEXT_AGENTS];
  return CONTEXT_AGENTS.filter((agent) => list.includes(agent));
}

class Reader {
  errors: ContextError[] = [];

  constructor(
    private root: string,
    private dir: string,
    /** What file paths start with: .selfhost/context, or a layer's name like team:web. */
    private label: string = CONTEXT_DIR,
  ) {}

  fail(file: string, message: string, line?: number, field?: string): void {
    this.errors.push({
      file,
      ...(line === undefined ? {} : { line }),
      ...(field === undefined ? {} : { field }),
      message,
    });
  }

  /** A regular file or folder, not a link: a link could point outside the repository. */
  kind(path: string, file: string): "file" | "dir" | undefined {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      this.fail(file, "Symbolic links are not compiled; put the file itself here");
      return undefined;
    }
    if (stat.isDirectory()) return "dir";
    if (stat.isFile()) return "file";
    this.fail(file, "Not a file or folder");
    return undefined;
  }

  /** Validates parsed data against a schema and reports each problem at its line. */
  validate<T>(
    check: Check,
    data: unknown,
    file: string,
    lineOf: (segments: readonly Segment[]) => number | undefined,
    keys: string | undefined,
  ): data is T {
    const errors = schemaErrors(check(), data);
    for (const error of errors) {
      const unknownKey = error.message === "Unexpected property";
      const message =
        unknownKey && keys !== undefined ? `Unknown key; the keys are ${keys}` : error.message;
      this.fail(file, message, lineOf(error.segments), formatField(error.segments));
    }
    return errors.length === 0;
  }

  /** Reads front matter and validates it; undefined after reporting the problems. */
  markdown<T>(
    path: string,
    file: string,
    check: Check,
    keys: string | undefined,
  ): Read<T> | undefined {
    const split = splitFrontMatter(readFileSync(path, "utf8"));
    if ("error" in split) {
      this.fail(file, split.error, split.line);
      return undefined;
    }
    const located = parseLocated(split.yaml ?? "", split.offset);
    for (const error of located.errors) this.fail(file, error.message, error.line);
    if (located.errors.length > 0) return undefined;
    const data = located.data ?? {};
    if (typeof data !== "object" || Array.isArray(data)) {
      this.fail(file, "The front matter must be a mapping of keys to values", 2);
      return undefined;
    }
    if (!this.validate<T>(check, data, file, located.lineOf, keys)) return undefined;
    return { data: data as T, body: split.body, lineOf: located.lineOf };
  }

  /** The .md files of a folder, by name; other entries are reported. */
  markdownFiles(folder: string): { name: string; path: string; file: string }[] {
    const dir = join(this.dir, folder);
    if (!existsSync(dir)) return [];
    const out: { name: string; path: string; file: string }[] = [];
    for (const entry of entries(dir)) {
      const path = join(dir, entry);
      const file = posix(this.label, folder, entry);
      const kind = this.kind(path, file);
      if (kind === undefined) continue;
      if (kind === "dir" || !entry.endsWith(".md")) {
        this.fail(file, `Only .md files go in ${folder}/, one per item`);
        continue;
      }
      const name = entry.slice(0, -3);
      if (!new RegExp(ITEM_NAME_PATTERN).test(name)) {
        this.fail(
          file,
          "The file name must be lowercase letters and digits, with single - or _ between words",
        );
        continue;
      }
      out.push({ name, path, file });
    }
    return out;
  }

  rules(): ContextRule[] {
    return this.markdownFiles("rules").flatMap(({ name, path, file }) => {
      const read = this.markdown<RuleFrontMatter>(path, file, checks.rule, KEYS.rule);
      if (!read) return [];
      if (read.body === "") {
        this.fail(file, "The rule has no text");
        return [];
      }
      return [
        {
          kind: "rule" as const,
          name,
          path: file,
          agents: resolveAgents(read.data.agents),
          globs: read.data.globs ?? [],
          ...(read.data.description ? { description: read.data.description } : {}),
          body: read.body,
        },
      ];
    });
  }

  commands(): ContextCommand[] {
    return this.markdownFiles("commands").flatMap(({ name, path, file }) => {
      const read = this.markdown<CommandFrontMatter>(path, file, checks.command, KEYS.command);
      if (!read) return [];
      if (read.body === "") {
        this.fail(file, "The command has no prompt");
        return [];
      }
      return [
        {
          kind: "command" as const,
          name,
          path: file,
          agents: resolveAgents(read.data.agents),
          ...(read.data.description ? { description: read.data.description } : {}),
          ...(read.data["argument-hint"] ? { argumentHint: read.data["argument-hint"] } : {}),
          body: read.body,
        },
      ];
    });
  }

  subagents(): ContextSubagent[] {
    return this.markdownFiles("agents").flatMap(({ name, path, file }) => {
      const read = this.markdown<SubagentFrontMatter>(path, file, checks.agent, KEYS.agent);
      if (!read) return [];
      if (read.data.name !== name) {
        this.fail(file, `name must match the file name (${name})`, read.lineOf(["name"]), "name");
        return [];
      }
      if (read.body === "") {
        this.fail(file, "The subagent has no system prompt");
        return [];
      }
      return [
        {
          kind: "agent" as const,
          name,
          path: file,
          agents: resolveAgents(read.data.agents),
          description: read.data.description,
          ...(read.data.tools ? { tools: read.data.tools } : {}),
          ...(read.data.model ? { model: read.data.model as ModelChoice } : {}),
          body: read.body,
        },
      ];
    });
  }

  skillFiles(dir: string, folder: string, base = ""): SkillFile[] {
    const files: SkillFile[] = [];
    for (const entry of entries(dir)) {
      const relative = posix(base, entry);
      if (relative === "SKILL.md") continue;
      const path = join(dir, entry);
      const kind = this.kind(path, posix(folder, relative));
      if (kind === "dir") files.push(...this.skillFiles(path, folder, relative));
      else if (kind === "file") {
        files.push({
          path: relative,
          content: new Uint8Array(readFileSync(path)),
          executable: (lstatSync(path).mode & 0o111) !== 0,
        });
      }
    }
    return files;
  }

  skills(): ContextSkill[] {
    const dir = join(this.dir, "skills");
    if (!existsSync(dir)) return [];
    const skills: ContextSkill[] = [];
    for (const entry of entries(dir)) {
      const path = join(dir, entry);
      const folder = posix(this.label, "skills", entry);
      const kind = this.kind(path, folder);
      if (kind === undefined) continue;
      if (kind === "file") {
        this.fail(folder, "Each skill is a folder with a SKILL.md: skills/<name>/SKILL.md");
        continue;
      }
      const file = posix(folder, "SKILL.md");
      if (!existsSync(join(path, "SKILL.md"))) {
        this.fail(file, "The skill folder has no SKILL.md");
        continue;
      }
      const read = this.markdown<SkillFrontMatter>(
        join(path, "SKILL.md"),
        file,
        checks.skill,
        undefined,
      );
      if (!read) continue;
      if (read.data.name !== entry) {
        this.fail(
          file,
          `name must match the folder name (${entry})`,
          read.lineOf(["name"]),
          "name",
        );
        continue;
      }
      if (read.body === "") {
        this.fail(file, "The skill has no instructions");
        continue;
      }
      skills.push({
        kind: "skill",
        name: entry,
        path: folder,
        agents: resolveAgents(read.data.agents),
        version: read.data.version,
        description: read.data.description,
        frontMatter: read.data as Record<string, unknown>,
        body: read.body,
        files: this.skillFiles(path, folder),
      });
    }
    return skills;
  }

  mcp(): ContextMcpServer[] {
    const path = join(this.dir, "mcp.json");
    const file = posix(this.label, "mcp.json");
    if (!existsSync(path)) return [];
    if (this.kind(path, file) !== "file") return [];
    const text = readFileSync(path, "utf8");
    try {
      JSON.parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const position = /position (\d+)/.exec(message)?.[1];
      const line =
        position === undefined ? undefined : text.slice(0, Number(position)).split("\n").length;
      this.fail(file, `Not valid JSON: ${message.replace(/ \(line \d+ column \d+\)$/, "")}`, line);
      return [];
    }
    const located = parseLocated(text);
    if (!this.validate<McpFile>(checks.mcp, located.data, file, located.lineOf, KEYS.mcp))
      return [];
    const parsed = located.data as McpFile;
    const servers: ContextMcpServer[] = [];
    for (const [name, server] of Object.entries(parsed.mcpServers)) {
      const at = (key?: string) =>
        located.lineOf(key ? ["mcpServers", name, key] : ["mcpServers", name]);
      const problem = mcpServerProblem(server);
      if (problem) {
        const field = `mcpServers.${name}${problem.key ? `.${problem.key}` : ""}`;
        this.fail(file, problem.message, at(problem.key), field);
        continue;
      }
      servers.push({
        kind: "mcp",
        name,
        path: file,
        agents: resolveAgents(server.agents),
        spec: {
          ...(server.type === undefined ? {} : { type: server.type }),
          ...(server.command === undefined ? {} : { command: server.command }),
          ...(server.args === undefined ? {} : { args: server.args }),
          ...(server.env === undefined ? {} : { env: server.env }),
          ...(server.url === undefined ? {} : { url: server.url }),
          ...(server.headers === undefined ? {} : { headers: server.headers }),
        },
      });
    }
    return servers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  read(): ContextSource {
    for (const entry of entries(this.dir)) {
      if (!TOP_LEVEL.has(entry)) {
        this.fail(
          posix(this.label, entry),
          `Unknown entry; ${this.label} holds rules/, skills/, commands/, agents/ and mcp.json`,
        );
      }
    }
    const source: ContextSource = {
      rules: this.rules(),
      skills: this.skills(),
      commands: this.commands(),
      agents: this.subagents(),
      mcp: this.mcp(),
    };
    const skillNames = new Set(source.skills.map((skill) => skill.name));
    for (const command of source.commands) {
      if (skillNames.has(command.name)) {
        this.fail(
          command.path,
          `A skill is also named ${command.name}; Cursor runs commands as skills, so the names must differ`,
        );
      }
    }
    return source;
  }

  /** Markdown in .ruler/, in the order Ruler concatenates it: AGENTS.md first, then by path. */
  ruler(): RulerFile[] {
    const dir = join(this.root, ".ruler");
    if (!existsSync(dir)) return [];
    const files: RulerFile[] = [];
    const walk = (current: string, relative: string) => {
      for (const entry of entries(current)) {
        const path = join(current, entry);
        const rel = posix(relative, entry);
        const stat = lstatSync(path);
        // Ruler keeps skills and subagents in these folders, not rules.
        if (stat.isDirectory() && (rel === "skills" || rel === "agents")) continue;
        if (stat.isDirectory()) walk(path, rel);
        else if (stat.isFile() && entry.endsWith(".md")) {
          files.push({ path: posix(".ruler", rel), text: readFileSync(path, "utf8") });
        }
      }
    };
    walk(dir, "");
    const primary =
      files.find((file) => file.path === ".ruler/AGENTS.md") ??
      files.find((file) => file.path === ".ruler/instructions.md");
    const rest = files
      .filter((file) => file !== primary)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return primary ? [primary, ...rest] : rest;
  }
}

/**
 * Reads and validates .selfhost/context under root, and the Markdown in root/.ruler that Ruler
 * would put in every rules file. Every problem is reported with its file and line. A missing
 * .selfhost/context is an error unless `allowMissing`, which reads it as empty (the repository
 * adds nothing to the other layers).
 */
export function readContextSource(
  root: string,
  options: { allowMissing?: boolean } = {},
): ReadResult {
  const dir = join(root, CONTEXT_DIR);
  if (!existsSync(dir)) {
    if (options.allowMissing) {
      const source = { rules: [], skills: [], commands: [], agents: [], mcp: [] };
      return { ok: true, source, ruler: new Reader(root, dir).ruler() };
    }
    return {
      ok: false,
      errors: [
        {
          file: CONTEXT_DIR,
          message:
            "There is no .selfhost/context folder. Create it next to selfhost.toml with rules/, skills/, commands/, agents/ or mcp.json.",
        },
      ],
    };
  }
  const reader = new Reader(root, dir);
  const source = reader.read();
  const ruler = reader.ruler();
  if (reader.errors.length > 0) return { ok: false, errors: reader.errors };
  return { ok: true, source, ruler };
}

/**
 * Reads and validates a context folder in the .selfhost/context layout that is not a
 * repository's own, such as a layer pulled from the team server. File paths in items and errors
 * start with `label` instead of .selfhost/context.
 */
export function readContextDir(dir: string, label: string): ReadResult {
  const reader = new Reader(dir, dir, label);
  const source = reader.read();
  if (reader.errors.length > 0) return { ok: false, errors: reader.errors };
  return { ok: true, source, ruler: [] };
}

/** `file:line: field: message`, the way compilers print problems. */
export function formatContextError(error: ContextError): string {
  const where = error.line === undefined ? error.file : `${error.file}:${error.line}`;
  return `${where}: ${error.field ? `${error.field}: ` : ""}${error.message}`;
}
