import type { McpServerSpec } from "@selfhost/agents";
import type { ContextAgent } from "@selfhost/schema";

/** A problem in the source, located by file (repository-relative) and, when known, line. */
export interface ContextError {
  file: string;
  /** 1-based line in the file. */
  line?: number;
  /** The front matter key or JSON field, like globs[0] or mcpServers.github.url. */
  field?: string;
  message: string;
}

interface ItemBase {
  name: string;
  /** Repository-relative source path: the file, or for a skill its folder. */
  path: string;
  /** Agents the item is for, in CONTEXT_AGENTS order. */
  agents: ContextAgent[];
}

/** rules/<name>.md */
export interface ContextRule extends ItemBase {
  kind: "rule";
  /** Path globs the rule applies to; empty for a rule that always applies. */
  globs: string[];
  description?: string;
  body: string;
}

/** A file in a skill's folder besides SKILL.md, shipped with the skill as it is. */
export interface SkillFile {
  /** Path inside the skill folder, /-separated. */
  path: string;
  content: Uint8Array;
  /** The file is executable (a script), and the copies stay so. */
  executable: boolean;
}

/** skills/<name>/SKILL.md and the files beside it. */
export interface ContextSkill extends ItemBase {
  kind: "skill";
  version: string;
  description: string;
  /** Every front matter key as written, agents included. */
  frontMatter: Record<string, unknown>;
  body: string;
  files: SkillFile[];
}

/** commands/<name>.md */
export interface ContextCommand extends ItemBase {
  kind: "command";
  description?: string;
  argumentHint?: string;
  /** The prompt; $ARGUMENTS stands for what the person types after the command. */
  body: string;
}

/** A model for every agent, or one per agent id. */
export type ModelChoice = string | Partial<Record<ContextAgent, string>>;

/** agents/<name>.md */
export interface ContextSubagent extends ItemBase {
  kind: "agent";
  description: string;
  /** Claude Code tool names; undefined gives the subagent every tool. */
  tools?: string[];
  model?: ModelChoice;
  /** The system prompt. */
  body: string;
}

/** One server in mcp.json. */
export interface ContextMcpServer extends ItemBase {
  kind: "mcp";
  spec: McpServerSpec;
}

export type ContextItem =
  | ContextRule
  | ContextSkill
  | ContextCommand
  | ContextSubagent
  | ContextMcpServer;

export interface ContextSource {
  rules: ContextRule[];
  skills: ContextSkill[];
  commands: ContextCommand[];
  agents: ContextSubagent[];
  mcp: ContextMcpServer[];
}

/** A Markdown file in the repository's .ruler/ folder, which Ruler puts in every rules file. */
export interface RulerFile {
  path: string;
  text: string;
}
