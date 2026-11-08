import { readFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import {
  type ContextFile,
  type ContextOptions,
  findContextFiles,
  repoRoot,
} from "@selfhost/agents";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { tilde } from "../../agents.js";

/**
 * How much of a file every session loads. always: all of it. description: the name and
 * description only, as for skills, subagents, commands and rules the agent pulls in by
 * description. on_demand: nothing until the agent works on matching files or someone asks.
 */
export type LoadMode = "always" | "description" | "on_demand";

/** One MCP server as an agent's config starts it. Values stay in memory and are never printed. */
export interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
}

/** A context file read into memory. Its text is only used here and never written out. */
export interface ContextDoc {
  file: ContextFile;
  /** Relative to the repository root for repository files, ~/... for home files. */
  display: string;
  load: LoadMode;
  /** The whole file. Empty for MCP configs and for files that could not be read. */
  text: string;
  /** Front matter fields, when the file has a YAML block at the top. */
  front: Record<string, unknown>;
  /** The text after the front matter. */
  body: string;
  /** What every session loads of the file. */
  alwaysText: string;
  /** MCP configs: the servers in the file. */
  servers: McpServer[];
}

/** Files larger than this are listed but not read. */
const MAX_READ_BYTES = 1_000_000;

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** `key: value` lines, for front matter that is not valid YAML (Cursor's `globs: *.ts`). */
function looseFrontMatter(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match?.[1]) out[match[1]] = match[2]?.trim().replace(/^["']|["']$/g, "") ?? "";
  }
  return out;
}

export function splitFrontMatter(text: string): { front: Record<string, unknown>; body: string } {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { front: {}, body: text };
  const block = match[1] ?? "";
  let front: Record<string, unknown>;
  try {
    const parsed = parseYaml(block) as unknown;
    front =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    front = looseFrontMatter(block);
  }
  return { front, body: text.slice(match[0].length) };
}

/** A front matter value as a list of strings: `a, b`, `[a, b]` or a YAML list. */
export function stringList(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  if (typeof value !== "string") return [];
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The folder a repository file applies to: its own, or the root for .claude/ files. */
export function fileFolder(path: string, root: string): string {
  const dir = dirname(path);
  return basename(dir) === ".claude" && dirname(dir) === root ? root : dir;
}

const ALWAYS_GLOBS = new Set(["**", "**/*", "*"]);

function loadMode(file: ContextFile, front: Record<string, unknown>, root?: string): LoadMode {
  switch (file.kind) {
    case "mcp":
      return "always";
    case "skill":
    case "subagent":
    case "command":
      return "description";
    case "rule": {
      if (file.path.endsWith(".cursorrules")) return "always";
      if (file.agent === "claude_code") {
        return stringList(front.paths).length > 0 ? "on_demand" : "always";
      }
      // Cursor: always apply, by file pattern, by description, or only when mentioned.
      if (front.alwaysApply === true || front.alwaysApply === "true") return "always";
      if (stringList(front.globs).length > 0) return "on_demand";
      return text(front.description) ? "description" : "on_demand";
    }
    case "instructions": {
      if (file.path.endsWith("copilot-instructions.md")) return "always";
      const globs = stringList(front.applyTo);
      return globs.some((glob) => ALWAYS_GLOBS.has(glob)) ? "always" : "on_demand";
    }
    default:
      // Instruction files load at the start for the root and the home config, and on demand in
      // subfolders, when the agent works on files there.
      if (file.scope === "home" || root === undefined) return "always";
      return fileFolder(file.path, root) === root ? "always" : "on_demand";
  }
}

/** The part of a file every session pays for. */
function alwaysPart(doc: Pick<ContextDoc, "file" | "load" | "front" | "body">): string {
  if (doc.load === "on_demand" || doc.file.kind === "mcp") return "";
  if (doc.load === "always") return doc.body;
  const name = text(doc.front.name) || basename(doc.file.path).replace(/\.(md|mdc)$/, "");
  const description = text(doc.front.description);
  return description ? `${name}: ${description}` : name;
}

/** Removes // and /* comments outside strings, for JSONC. */
function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (inString) {
      out += char;
      if (char === "\\") out += source[++i] ?? "";
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && next === "*") {
      i = source.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function strings(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => typeof entry === "string" || typeof entry === "number")
      .map(([key, entry]) => [key, String(entry)]),
  );
}

const argList = (value: unknown) => (Array.isArray(value) ? value.map(String) : undefined);

/** Claude Code, Cursor, Gemini CLI, Copilot CLI and VS Code all use this shape. */
function standardServer(name: string, spec: Record<string, unknown>): McpServer {
  const url = text(spec.url) || text(spec.httpUrl) || text(spec.serverUrl);
  return {
    name,
    ...(text(spec.command) ? { command: text(spec.command) } : {}),
    ...(argList(spec.args) ? { args: argList(spec.args) } : {}),
    ...(url ? { url } : {}),
    env: strings(spec.env),
    headers: strings(spec.headers),
  };
}

function codexServer(name: string, spec: Record<string, unknown>): McpServer {
  const headers = strings(spec.http_headers);
  for (const [header, variable] of Object.entries(strings(spec.env_http_headers))) {
    headers[header] = `\${${variable}}`;
  }
  const bearer = text(spec.bearer_token_env_var);
  if (bearer) headers.Authorization = `Bearer \${${bearer}}`;
  return { ...standardServer(name, spec), headers };
}

function opencodeServer(name: string, spec: Record<string, unknown>): McpServer {
  const command = argList(spec.command) ?? [];
  return {
    name,
    ...(command[0] ? { command: command[0], args: command.slice(1) } : {}),
    ...(text(spec.url) ? { url: text(spec.url) } : {}),
    env: strings(spec.environment),
    headers: strings(spec.headers),
  };
}

function gooseServer(name: string, spec: Record<string, unknown>): McpServer | undefined {
  if (spec.type === "builtin" || spec.type === "platform" || spec.enabled === false) {
    return undefined;
  }
  return {
    name,
    ...(text(spec.cmd) ? { command: text(spec.cmd) } : {}),
    ...(argList(spec.args) ? { args: argList(spec.args) } : {}),
    ...(text(spec.uri) ? { url: text(spec.uri) } : {}),
    env: strings(spec.envs),
    headers: strings(spec.headers),
  };
}

function servers(
  table: unknown,
  read: (name: string, spec: Record<string, unknown>) => McpServer | undefined,
): McpServer[] {
  if (!isObject(table)) return [];
  return Object.entries(table)
    .filter((entry): entry is [string, Record<string, unknown>] => isObject(entry[1]))
    .map(([name, spec]) => read(name, spec))
    .filter((server): server is McpServer => server !== undefined)
    .filter((server) => server.command !== undefined || server.url !== undefined);
}

/** The MCP servers in one agent config file, in that agent's own layout. */
export function mcpServers(file: ContextFile, source: string): McpServer[] {
  const name = basename(file.path);
  if (name.endsWith(".toml")) {
    return servers(parseToml(source).mcp_servers, codexServer);
  }
  if (name.endsWith(".yaml") || name.endsWith(".yml")) {
    return servers((parseYaml(source) as Record<string, unknown> | null)?.extensions, gooseServer);
  }
  const config = JSON.parse(stripJsonComments(source)) as Record<string, unknown>;
  if (name.startsWith("opencode")) {
    const mcp = config.mcp;
    const table = isObject(mcp) && isObject(mcp.servers) ? mcp.servers : mcp;
    return servers(table, opencodeServer);
  }
  if (file.agent === "copilot" && file.scope === "repo") {
    return servers(config.servers, standardServer);
  }
  return servers(config.mcpServers, standardServer);
}

export interface ReadContextOptions extends ContextOptions {
  /** Where the repository files were looked for; the root of the paths shown. */
  root?: string;
}

/**
 * Finds every context file with packages/agents and reads it: front matter, how much of it
 * loads every session, and for MCP configs the servers. MCP configs with no servers (most
 * ~/.claude.json and ~/.codex/config.toml files) are left out.
 */
export function readContext(options: ReadContextOptions): ContextDoc[] {
  const root = options.cwd !== undefined ? repoRoot(options.cwd) : undefined;
  const docs: ContextDoc[] = [];
  for (const file of findContextFiles(options)) {
    const display =
      file.scope === "repo" && root ? relative(root, file.path) : tilde(file.path, options.home);
    let source = "";
    if (file.size <= MAX_READ_BYTES) {
      try {
        source = readFileSync(file.path, "utf8");
      } catch {
        source = "";
      }
    }
    if (file.kind === "mcp") {
      let found: McpServer[] = [];
      try {
        found = mcpServers(file, source);
      } catch {
        found = [];
      }
      if (found.length === 0) continue;
      docs.push({
        file,
        display,
        load: "always",
        text: "",
        front: {},
        body: "",
        alwaysText: "",
        servers: found.sort((a, b) => a.name.localeCompare(b.name)),
      });
      continue;
    }
    const { front, body } = splitFrontMatter(source);
    const load = loadMode(file, front, file.scope === "repo" ? root : undefined);
    const doc = { file, display, load, text: source, front, body, servers: [] };
    docs.push({ ...doc, alwaysText: alwaysPart(doc) });
  }
  return docs;
}
