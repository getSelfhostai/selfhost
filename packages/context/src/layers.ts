import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CONTEXT_FILE_PATTERN,
  CONTEXT_ITEM_PATTERN,
  CONTEXT_LAYER_KINDS,
  type ContextConflict,
  type ContextFile,
  type ContextLayerKind,
} from "@selfhost/schema";
import { itemsOf } from "./compile/index.js";
import { itemId } from "./compile/output.js";
import type { McpFile } from "./schema.js";
import { type ReadResult, readContextDir } from "./source.js";
import type { ContextItem, ContextSource } from "./types.js";

/**
 * Layers of context: the org's and the team's (from the team server), the repository's own
 * .selfhost/context, and the person's (on their laptop). They merge in that order. Later layers
 * add items; when two layers have the same item the earlier one's is used, so the org's items
 * are a floor nobody replaces, and the merge names every item that lost.
 */
export interface ContextLayer {
  kind: ContextLayerKind;
  /** The org id, team id, repository folder or person. */
  name: string;
  source: ContextSource;
}

export interface MergedContext {
  source: ContextSource;
  /** Items a later layer defined again, each with the item that was used instead. */
  conflicts: ContextConflict[];
}

const rank = (kind: ContextLayerKind) => CONTEXT_LAYER_KINDS.indexOf(kind);

/** Skills and commands share names: Cursor runs commands as skills. */
const slotOf = (item: ContextItem) =>
  item.kind === "skill" || item.kind === "command" ? `invocable:${item.name}` : itemId(item);

function add(source: ContextSource, item: ContextItem): void {
  switch (item.kind) {
    case "rule":
      source.rules.push(item);
      break;
    case "skill":
      source.skills.push(item);
      break;
    case "command":
      source.commands.push(item);
      break;
    case "agent":
      source.agents.push(item);
      break;
    case "mcp":
      source.mcp.push(item);
      break;
  }
}

const emptySource = (): ContextSource => ({
  rules: [],
  skills: [],
  commands: [],
  agents: [],
  mcp: [],
});

/** Merges layers org, team, repo, personal (in that order whatever order they are given in). */
export function mergeLayers(layers: readonly ContextLayer[]): MergedContext {
  const ordered = [...layers].sort((a, b) => rank(a.kind) - rank(b.kind));
  const kept = new Map<string, { item: ContextItem; layer: ContextLayer }>();
  const source = emptySource();
  const conflicts: ContextConflict[] = [];
  for (const layer of ordered) {
    for (const item of itemsOf(layer.source)) {
      const winner = kept.get(slotOf(item));
      if (!winner) {
        kept.set(slotOf(item), { item, layer });
        add(source, item);
        continue;
      }
      const side = (entry: { item: ContextItem; layer: ContextLayer }) => ({
        item: itemId(entry.item),
        layer: entry.layer.kind,
        name: entry.layer.name,
        path: entry.item.path,
      });
      const lost = side({ item, layer });
      const used = side(winner);
      const floor = winner.layer.kind === "org" ? " (the org floor, which always wins)" : "";
      conflicts.push({
        lost,
        kept: used,
        message: `${lost.item} from the ${lost.layer} layer (${lost.path}) is not used: the ${used.layer} layer${floor} has ${used.item} (${used.path}), and the earlier layer wins.`,
      });
    }
  }
  return { source, conflicts };
}

// Layer files: a layer as the server stores it and the laptop writes it, in the .selfhost/context
// layout (rules/<name>.md, skills/<name>/..., commands/, agents/, mcp.json).

const FILE_PATH = new RegExp(CONTEXT_FILE_PATTERN);
const ITEM_ID = new RegExp(CONTEXT_ITEM_PATTERN);
const IGNORED = new Set([".DS_Store", "Thumbs.db"]);

const byPath = (a: ContextFile, b: ContextFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Why a path can't be a layer file, or undefined when it can. */
export function layerPathProblem(path: string): string | undefined {
  const parts = path.split("/");
  if (!FILE_PATH.test(path) || parts.some((part) => part === "" || part === "." || part === "..")) {
    return `${path} is not a file of a context folder: mcp.json, or a file under rules/, skills/, commands/ or agents/`;
  }
  return undefined;
}

/**
 * Every file of a context folder, for sending it as a layer. Files must be UTF-8 text; links
 * and other entries are refused, as the compile refuses them.
 */
export function readLayerDir(dir: string): ContextFile[] {
  if (!existsSync(dir)) return [];
  const files: ContextFile[] = [];
  const walk = (current: string, relative: string) => {
    for (const entry of readdirSync(current).sort()) {
      if (IGNORED.has(entry) || (relative === "" && entry === "README.md")) continue;
      const path = join(current, entry);
      const rel = relative === "" ? entry : `${relative}/${entry}`;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        walk(path, rel);
        continue;
      }
      if (!stat.isFile()) throw new Error(`${path}: only plain files go in a context layer`);
      const problem = layerPathProblem(rel);
      if (problem) throw new Error(problem);
      const bytes = readFileSync(path);
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) {
        throw new Error(`${path} is not UTF-8 text; a context layer holds text files only`);
      }
      files.push({ path: rel, text, ...((stat.mode & 0o111) !== 0 ? { executable: true } : {}) });
    }
  };
  walk(dir, "");
  return files.sort(byPath);
}

/** Replaces the folder with the layer's files. */
export function writeLayerDir(dir: string, files: readonly ContextFile[]): void {
  for (const file of files) {
    const problem = layerPathProblem(file.path);
    if (problem) throw new Error(problem);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const path = join(dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.text);
    if (file.executable) chmodSync(path, 0o755);
  }
}

/** Reads a layer's files as a source, validated like .selfhost/context; paths start with label. */
export function readLayerFiles(files: readonly ContextFile[], label: string): ReadResult {
  const problems = files.flatMap((file) => {
    const problem = layerPathProblem(file.path);
    return problem ? [{ file: `${label}/${file.path}`, message: problem }] : [];
  });
  if (problems.length > 0) return { ok: false, errors: problems };
  const dir = mkdtempSync(join(tmpdir(), "selfhost-layer-"));
  try {
    writeLayerDir(dir, files);
    return readContextDir(dir, label);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** sha256 of a layer's files, whatever order they are in. */
export function layerHash(files: readonly ContextFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort(byPath)) {
    hash.update(file.path).update("\0").update(file.text).update("\0");
    hash.update(file.executable ? "x" : "-").update("\0");
  }
  return hash.digest("hex");
}

export interface ItemRef {
  kind: ContextItem["kind"];
  name: string;
}

/** kind:name, as the coverage names items; undefined when it is not one. */
export function parseItemId(id: string): ItemRef | undefined {
  if (!ITEM_ID.test(id)) return undefined;
  const at = id.indexOf(":");
  return { kind: id.slice(0, at) as ItemRef["kind"], name: id.slice(at + 1) };
}

const FOLDERS = { rule: "rules", command: "commands", agent: "agents" } as const;

function mcpServers(files: readonly ContextFile[]): McpFile["mcpServers"] {
  const file = files.find((candidate) => candidate.path === "mcp.json");
  if (!file) return {};
  return (JSON.parse(file.text) as McpFile).mcpServers ?? {};
}

const mcpFile = (servers: McpFile["mcpServers"]): ContextFile => ({
  path: "mcp.json",
  text: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
});

/** The files of one item in a layer: an MCP server as an mcp.json holding only it. */
export function itemFiles(files: readonly ContextFile[], { kind, name }: ItemRef): ContextFile[] {
  if (kind === "mcp") {
    const server = mcpServers(files)[name];
    return server === undefined ? [] : [mcpFile({ [name]: server })];
  }
  if (kind === "skill") return files.filter((file) => file.path.startsWith(`skills/${name}/`));
  return files.filter((file) => file.path === `${FOLDERS[kind]}/${name}.md`);
}

/** The layer's files with one item added, replacing any item of the same name. */
export function withItem(
  files: readonly ContextFile[],
  ref: ItemRef,
  item: readonly ContextFile[],
): ContextFile[] {
  if (ref.kind === "mcp") {
    const servers = { ...mcpServers(files), ...mcpServers(item) };
    return [...files.filter((file) => file.path !== "mcp.json"), mcpFile(servers)].sort(byPath);
  }
  const own = new Set(itemFiles(files, ref).map((file) => file.path));
  return [...files.filter((file) => !own.has(file.path)), ...item].sort(byPath);
}
