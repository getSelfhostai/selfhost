import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextAgent } from "@selfhost/schema";
import { formatField, lazyCheck, schemaErrors } from "@selfhost/schema";
import type { TSchema } from "@sinclair/typebox";
import type { TypeCheck } from "@sinclair/typebox/compiler";
import { markdownWithFrontMatter } from "./frontmatter.js";
import {
  CONTEXT_DIR,
  CommandFrontMatterSchema,
  ITEM_NAME_PATTERN,
  type McpFile,
  McpFileSchema,
  type McpServer,
  mcpServerProblem,
  RuleFrontMatterSchema,
  SkillFrontMatterSchema,
  SubagentFrontMatterSchema,
} from "./schema.js";
import type { ModelChoice } from "./types.js";

type Agents = readonly (ContextAgent | "all")[];

/** One item to add to a .selfhost/context source, as an importer has it. */
export type ContextItemInput =
  | {
      kind: "rule";
      name: string;
      agents?: Agents;
      globs?: readonly string[];
      description?: string;
      body: string;
    }
  | {
      kind: "skill";
      name: string;
      description: string;
      version: string;
      agents?: Agents;
      /** Other Agent Skills keys (license, allowed-tools, ...), kept as they are. */
      extra?: Record<string, unknown>;
      body: string;
      /** Files beside SKILL.md, by path inside the skill folder. */
      files?: readonly { path: string; content: string | Uint8Array; executable?: boolean }[];
    }
  | {
      kind: "command";
      name: string;
      description?: string;
      argumentHint?: string;
      agents?: Agents;
      body: string;
    }
  | {
      kind: "agent";
      name: string;
      description: string;
      tools?: readonly string[];
      model?: ModelChoice;
      agents?: Agents;
      body: string;
    }
  | { kind: "mcp"; name: string; server: McpServer };

/** A file of the source, by path relative to the repository root. */
export interface SourceFile {
  path: string;
  content: string | Uint8Array;
  executable?: boolean;
}

const checks = {
  rule: lazyCheck(RuleFrontMatterSchema),
  skill: lazyCheck(SkillFrontMatterSchema),
  command: lazyCheck(CommandFrontMatterSchema),
  agent: lazyCheck(SubagentFrontMatterSchema),
  mcp: lazyCheck(McpFileSchema),
};

function check(schema: () => TypeCheck<TSchema>, data: unknown, what: string): void {
  const errors = schemaErrors(schema(), data);
  if (errors.length > 0) {
    const list = errors.map((error) => `${formatField(error.segments)}: ${error.message}`);
    throw new Error(`${what} is not valid: ${list.join("; ")}`);
  }
}

function nameCheck(name: string, what: string): void {
  if (!new RegExp(ITEM_NAME_PATTERN).test(name)) {
    throw new Error(
      `${what}: the name must be lowercase letters and digits, with single - or _ between words`,
    );
  }
}

const defined = (data: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));

const text = (body: string) => `${body.replace(/\s+$/, "")}\n`;

/**
 * The source files for one item, validated against the format. Pure: nothing is read or
 * written. An MCP server becomes a whole mcp.json holding only that server; writeContextItem
 * merges it into an existing one.
 */
export function formatContextItem(item: ContextItemInput): SourceFile[] {
  const base = CONTEXT_DIR;
  switch (item.kind) {
    case "rule": {
      nameCheck(item.name, `rule ${item.name}`);
      const data = defined({
        agents: item.agents,
        globs: item.globs,
        description: item.description,
      });
      check(checks.rule, data, `rule ${item.name}`);
      const content =
        Object.keys(data).length === 0
          ? text(item.body)
          : markdownWithFrontMatter(data, text(item.body));
      return [{ path: `${base}/rules/${item.name}.md`, content }];
    }
    case "skill": {
      const data = defined({
        name: item.name,
        description: item.description,
        version: item.version,
        ...item.extra,
        agents: item.agents,
      });
      check(checks.skill, data, `skill ${item.name}`);
      const folder = `${base}/skills/${item.name}`;
      return [
        { path: `${folder}/SKILL.md`, content: markdownWithFrontMatter(data, text(item.body)) },
        ...(item.files ?? []).map((file) => {
          if (
            file.path === "SKILL.md" ||
            file.path.split("/").includes("..") ||
            file.path.startsWith("/")
          ) {
            throw new Error(
              `skill ${item.name}: ${file.path} is not a path inside the skill folder`,
            );
          }
          return {
            path: `${folder}/${file.path}`,
            content: file.content,
            ...(file.executable ? { executable: true } : {}),
          };
        }),
      ];
    }
    case "command": {
      nameCheck(item.name, `command ${item.name}`);
      const data = defined({
        description: item.description,
        "argument-hint": item.argumentHint,
        agents: item.agents,
      });
      check(checks.command, data, `command ${item.name}`);
      const content =
        Object.keys(data).length === 0
          ? text(item.body)
          : markdownWithFrontMatter(data, text(item.body));
      return [{ path: `${base}/commands/${item.name}.md`, content }];
    }
    case "agent": {
      const data = defined({
        name: item.name,
        description: item.description,
        tools: item.tools,
        model: item.model,
        agents: item.agents,
      });
      check(checks.agent, data, `subagent ${item.name}`);
      return [
        {
          path: `${base}/agents/${item.name}.md`,
          content: markdownWithFrontMatter(data, text(item.body)),
        },
      ];
    }
    case "mcp": {
      const file: McpFile = { mcpServers: { [item.name]: item.server } };
      check(checks.mcp, file, `MCP server ${item.name}`);
      const problem = mcpServerProblem(item.server);
      if (problem) throw new Error(`MCP server ${item.name} is not valid: ${problem.message}`);
      return [{ path: `${base}/mcp.json`, content: `${JSON.stringify(file, null, 2)}\n` }];
    }
  }
}

export interface WriteOptions {
  /** Replace an item that is already there. Default: refuse. */
  overwrite?: boolean;
}

/**
 * Adds one item to the .selfhost/context source under root and returns the paths written. An
 * MCP server is merged into mcp.json, keeping the other servers. Refuses to replace an existing
 * item unless `overwrite` is set.
 */
export function writeContextItem(
  root: string,
  item: ContextItemInput,
  options: WriteOptions = {},
): string[] {
  let files = formatContextItem(item);
  if (item.kind === "mcp") {
    const path = join(root, CONTEXT_DIR, "mcp.json");
    if (existsSync(path)) {
      const current = JSON.parse(readFileSync(path, "utf8")) as McpFile;
      if (current.mcpServers?.[item.name] !== undefined && !options.overwrite) {
        throw new Error(`${CONTEXT_DIR}/mcp.json already has a server named ${item.name}`);
      }
      const merged: McpFile = {
        ...current,
        mcpServers: { ...current.mcpServers, [item.name]: item.server },
      };
      check(checks.mcp, merged, `${CONTEXT_DIR}/mcp.json`);
      files = [
        { path: `${CONTEXT_DIR}/mcp.json`, content: `${JSON.stringify(merged, null, 2)}\n` },
      ];
    }
  } else if (!options.overwrite) {
    const first = files[0]?.path as string;
    const taken = item.kind === "skill" ? dirname(first) : first;
    if (existsSync(join(root, taken))) throw new Error(`${taken} already exists`);
  }
  for (const file of files) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
    if (file.executable) chmodSync(path, 0o755);
  }
  return files.map((file) => file.path);
}
