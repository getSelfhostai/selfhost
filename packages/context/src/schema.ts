import { CONTEXT_AGENTS, NonEmpty, StringEnum } from "@selfhost/schema";
import { type Static, Type } from "@sinclair/typebox";

/** Where the source lives, next to selfhost.toml. */
export const CONTEXT_DIR = ".selfhost/context";

/** The lock file the compile writes and the repository commits. */
export const LOCK_PATH = ".selfhost/context.lock.json";

/** Agent Skills names: lowercase letters and digits in words joined by single hyphens. */
export const SKILL_NAME_PATTERN = "^[a-z0-9]+(-[a-z0-9]+)*$";

/** Rule, command and subagent names, from the file name: lowercase, digits, - and _. */
export const ITEM_NAME_PATTERN = "^[a-z0-9]+([-_][a-z0-9]+)*$";

/** MCP server names, as Claude Code's allowedMcpServers accepts them. */
export const SERVER_NAME_PATTERN = "^[A-Za-z0-9_-]+$";

/** Semantic version 2.0.0 (https://semver.org), no leading v. */
export const SEMVER_PATTERN =
  "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$";

const AGENT_SELECTORS = ["all", ...CONTEXT_AGENTS] as const;

const Agents = Type.Array(StringEnum(AGENT_SELECTORS), {
  minItems: 1,
  uniqueItems: true,
  description: "Agents the item is for: all (the default) or agent ids such as claude_code.",
});

const Globs = Type.Array(NonEmpty(), {
  minItems: 1,
  description: "Path globs from the repository root, like src/api/**/*.ts.",
});

const Description = NonEmpty({ maxLength: 1024 });

/** Front matter of rules/<name>.md. Every key is optional; a rule may have no front matter. */
export const RuleFrontMatterSchema = Type.Object(
  {
    agents: Type.Optional(Agents),
    globs: Type.Optional(Globs),
    description: Type.Optional(Description),
  },
  { additionalProperties: false, title: "ContextRule" },
);

/**
 * Front matter of skills/<name>/SKILL.md: the Agent Skills format (https://agentskills.io)
 * plus version and agents. Keys beyond these are kept and passed on to every agent.
 */
export const SkillFrontMatterSchema = Type.Object(
  {
    name: Type.String({ pattern: SKILL_NAME_PATTERN, maxLength: 64 }),
    description: Description,
    version: Type.String({ pattern: SEMVER_PATTERN, description: "Semantic version." }),
    license: Type.Optional(NonEmpty()),
    compatibility: Type.Optional(NonEmpty({ maxLength: 500 })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
    "allowed-tools": Type.Optional(Type.Union([NonEmpty(), Type.Array(NonEmpty())])),
    "disable-model-invocation": Type.Optional(Type.Boolean()),
    agents: Type.Optional(Agents),
  },
  { additionalProperties: true, title: "ContextSkill" },
);

/** Front matter of commands/<name>.md. The body is the prompt; $ARGUMENTS takes the input. */
export const CommandFrontMatterSchema = Type.Object(
  {
    description: Type.Optional(Description),
    "argument-hint": Type.Optional(NonEmpty()),
    agents: Type.Optional(Agents),
  },
  { additionalProperties: false, title: "ContextCommand" },
);

const ModelByAgent = Type.Object(
  Object.fromEntries(CONTEXT_AGENTS.map((agent) => [agent, Type.Optional(NonEmpty())])),
  { additionalProperties: false, minProperties: 1 },
);

/** Front matter of agents/<name>.md. The body is the subagent's system prompt. */
export const SubagentFrontMatterSchema = Type.Object(
  {
    name: Type.String({ pattern: ITEM_NAME_PATTERN, maxLength: 64 }),
    description: Description,
    tools: Type.Optional(
      Type.Array(NonEmpty(), {
        uniqueItems: true,
        description: "Claude Code tool names (Read, Grep, Bash, ...) and mcp__<server>__<tool>.",
      }),
    ),
    model: Type.Optional(
      Type.Union([NonEmpty(), ModelByAgent], {
        description: "A model for every agent, inherit, or a model per agent id.",
      }),
    ),
    agents: Type.Optional(Agents),
  },
  { additionalProperties: false, title: "ContextSubagent" },
);

const StringMap = Type.Record(Type.String(), Type.String());

export const McpServerSchema = Type.Object(
  {
    type: Type.Optional(StringEnum(["stdio", "http", "sse"] as const)),
    command: Type.Optional(NonEmpty()),
    args: Type.Optional(Type.Array(Type.String())),
    env: Type.Optional(StringMap),
    url: Type.Optional(NonEmpty()),
    headers: Type.Optional(StringMap),
    agents: Type.Optional(Agents),
  },
  { additionalProperties: false, title: "ContextMcpServer" },
);

/**
 * What the schema can't say about a server: it has a command or a url, never both, and its
 * type and fields fit that. `key` is the field at fault, if one is.
 */
export function mcpServerProblem(server: McpServer): { message: string; key?: string } | undefined {
  if ((server.command === undefined) === (server.url === undefined)) {
    return { message: "A server has either a command (stdio) or a url (http, sse)" };
  }
  const remote = server.url !== undefined;
  if (server.type !== undefined && (server.type === "stdio") === remote) {
    return {
      message: remote ? "type stdio needs a command, not a url" : `type ${server.type} needs a url`,
      key: "type",
    };
  }
  if (remote && (server.args !== undefined || server.env !== undefined)) {
    return { message: "args and env are for stdio servers", key: server.args ? "args" : "env" };
  }
  if (!remote && server.headers !== undefined) {
    return { message: "headers are for http and sse servers", key: "headers" };
  }
  return undefined;
}

/** mcp.json: the mcpServers shape Claude Code and Cursor share. */
export const McpFileSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    $comment: Type.Optional(Type.String()),
    mcpServers: Type.Record(Type.String({ pattern: SERVER_NAME_PATTERN }), McpServerSchema),
  },
  { additionalProperties: false, title: "ContextMcp" },
);

export type RuleFrontMatter = Static<typeof RuleFrontMatterSchema>;
export type SkillFrontMatter = Static<typeof SkillFrontMatterSchema>;
export type CommandFrontMatter = Static<typeof CommandFrontMatterSchema>;
export type SubagentFrontMatter = Static<typeof SubagentFrontMatterSchema>;
export type McpServer = Static<typeof McpServerSchema>;
export type McpFile = Static<typeof McpFileSchema>;
