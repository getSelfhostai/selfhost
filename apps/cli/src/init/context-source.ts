import { SEMVER_PATTERN } from "@selfhost/context";
import { stringify } from "yaml";

/**
 * The one context source, `.selfhost/context/` at the repository root, that every agent's
 * context files are compiled from:
 *
 *   rules/<name>.md          Markdown; front matter agents (default all), globs, description
 *   skills/<name>/SKILL.md   Agent Skills: front matter name, description, version
 *   commands/<name>.md       front matter description, argument-hint; the body is the prompt
 *   agents/<name>.md         front matter name, description, tools, model; body is the prompt
 *   mcp.json                 {"mcpServers": {"<name>": {command, args, env} or {url, headers}}}
 *
 * This file writes that layout and nothing else, so `selfhost init` can import into it.
 */

export const CONTEXT_SOURCE_DIR = ".selfhost/context";

export interface SourceRule {
  name: string;
  /** Agent ids; omitted means every agent. */
  agents?: string[];
  globs?: string[];
  description?: string;
  body: string;
}

export interface SourceSkill {
  name: string;
  description: string;
  version?: string;
  body: string;
  /** The skill folder's other files (scripts, references), relative to the folder. */
  files?: { path: string; data: Buffer }[];
}

export interface SourceCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  body: string;
}

export interface SourceAgent {
  name: string;
  description: string;
  tools?: string | string[];
  model?: string;
  body: string;
}

export type SourceMcpServer =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> };

export interface ContextSource {
  rules: SourceRule[];
  skills: SourceSkill[];
  commands: SourceCommand[];
  agents: SourceAgent[];
  mcpServers: Record<string, SourceMcpServer>;
}

export interface SourceFile {
  /** Relative to `.selfhost/context/`, with forward slashes. */
  path: string;
  data: string | Buffer;
}

function markdown(front: Record<string, unknown>, body: string): string {
  const fields = Object.fromEntries(
    Object.entries(front).filter(
      ([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0),
    ),
  );
  const text = body.endsWith("\n") ? body : `${body}\n`;
  if (Object.keys(fields).length === 0) return text;
  return `---\n${stringify(fields, { lineWidth: 0 })}---\n\n${text.replace(/^\n+/, "")}`;
}

/**
 * The context source requires a semantic version on every skill, so one with none, or with a
 * version that is not semver (such as "1.0"), starts at 1.0.0.
 */
function splitTools(tools: string): string[] {
  return tools
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool !== "");
}

function skillVersion(version: string | undefined): string {
  return version !== undefined && new RegExp(SEMVER_PATTERN).test(version) ? version : "1.0.0";
}

/** The files of the source, in a stable order. */
export function contextSourceFiles(source: ContextSource): SourceFile[] {
  const files: SourceFile[] = [];
  for (const rule of source.rules) {
    files.push({
      path: `rules/${rule.name}.md`,
      data: markdown(
        { agents: rule.agents, globs: rule.globs, description: rule.description },
        rule.body,
      ),
    });
  }
  for (const skill of source.skills) {
    files.push({
      path: `skills/${skill.name}/SKILL.md`,
      data: markdown(
        { name: skill.name, description: skill.description, version: skillVersion(skill.version) },
        skill.body,
      ),
    });
    for (const extra of skill.files ?? []) {
      files.push({ path: `skills/${skill.name}/${extra.path}`, data: extra.data });
    }
  }
  for (const command of source.commands) {
    files.push({
      path: `commands/${command.name}.md`,
      data: markdown(
        { description: command.description, "argument-hint": command.argumentHint },
        command.body,
      ),
    });
  }
  for (const agent of source.agents) {
    files.push({
      path: `agents/${agent.name}.md`,
      data: markdown(
        {
          name: agent.name,
          description: agent.description,
          // Claude Code writes tools as one comma-separated string; the source keeps a list.
          tools: typeof agent.tools === "string" ? splitTools(agent.tools) : agent.tools,
          model: agent.model,
        },
        agent.body,
      ),
    });
  }
  if (Object.keys(source.mcpServers).length > 0) {
    files.push({
      path: "mcp.json",
      data: `${JSON.stringify({ mcpServers: source.mcpServers }, null, 2)}\n`,
    });
  }
  return files;
}
