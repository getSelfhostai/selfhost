import { TOOL_NAMES } from "@selfhost/compile";
import type { ContextAgent } from "@selfhost/schema";
import { markdownWithFrontMatter } from "../frontmatter.js";
import type { ContextSubagent } from "../types.js";
import { AGENT_NAMES, listed } from "./agents.js";
import { type Builder, hashHeader, headerText, type Placement, tomlMultiline } from "./output.js";

// Subagents. The source's tools are Claude Code tool names; each agent gets what it can take.
// - Claude Code: .claude/agents/<name>.md: name, description, tools, model.
//   https://code.claude.com/docs/en/sub-agents
// - Codex: .codex/agents/<name>.toml: name, description, developer_instructions, model. Tools
//   and sandbox come from the parent session.
//   https://learn.chatgpt.com/docs/agent-configuration/subagents
// - Cursor: .cursor/agents/<name>.md: name, description, model, readonly. No tool list.
//   https://cursor.com/docs/context/subagents
// - Copilot: .github/agents/<name>.agent.md: name, description, tools (aliases read, edit,
//   search, execute, web, agent, todo, and <server>/<tool> for MCP), model; body up to
//   30,000 characters. https://docs.github.com/en/copilot/reference/custom-agents-configuration
// - Gemini CLI: .gemini/agents/<name>.md: name, description, tools (Gemini's own tool names,
//   which selfhost does not map), model. https://geminicli.com/docs/core/subagents/
// - OpenCode: .opencode/agents/<name>.md: description, mode, model, and the tools map of the
//   1.x format (tool name to on or off), which OpenCode 2 still reads.
//   https://opencode.ai/docs/agents/ and https://opencode.ai/docs/migrate-v1/
// - Goose: .agents/agents/<name>.md: name, description, model. No tool list.
//   https://goose-docs.ai/docs/guides/context-engineering/custom-agents/

const CLAUDE = TOOL_NAMES.claude_code;
const SEARCH = ["Grep", "Glob", "LS"];
const READ_ONLY = new Set([
  ...CLAUDE.read,
  "NotebookRead",
  ...SEARCH,
  ...CLAUDE.fetch,
  "WebSearch",
]);

/** Copilot's tool aliases for Claude Code tool names. */
const COPILOT_ALIASES: Record<string, string> = {
  ...Object.fromEntries(CLAUDE.read.map((tool) => [tool, "read"])),
  NotebookRead: "read",
  ...Object.fromEntries(CLAUDE.edit.map((tool) => [tool, "edit"])),
  ...Object.fromEntries(SEARCH.map((tool) => [tool, "search"])),
  ...Object.fromEntries(CLAUDE.shell.map((tool) => [tool, "execute"])),
  ...Object.fromEntries(CLAUDE.fetch.map((tool) => [tool, "web"])),
  WebSearch: "web",
  Task: "agent",
  Agent: "agent",
  TodoWrite: "todo",
};

/** OpenCode 1.x tool names for Claude Code tool names. */
const OPENCODE_TOOLS: Record<string, readonly string[]> = {
  Read: ["read"],
  Write: ["write"],
  Edit: ["edit", "patch"],
  MultiEdit: ["edit", "patch"],
  Bash: ["bash"],
  Grep: ["grep"],
  Glob: ["glob"],
  LS: ["list"],
  WebFetch: ["webfetch"],
  TodoWrite: ["todowrite", "todoread"],
};

function copilotTool(tool: string): string | undefined {
  if (CLAUDE.mcp !== null && tool.startsWith(CLAUDE.mcp)) {
    const [server, name] = tool.slice(CLAUDE.mcp.length).split("__");
    return server && name ? `${server}/${name}` : server ? `${server}/*` : undefined;
  }
  return COPILOT_ALIASES[tool];
}

/** The model for one agent: the per-agent value, or the shared one. inherit only where it exists. */
function modelFor(subagent: ContextSubagent, agent: ContextAgent): string | undefined {
  const choice = subagent.model;
  const model = typeof choice === "string" ? choice : choice?.[agent];
  if (model === "inherit" && !["claude_code", "cursor", "gemini"].includes(agent)) return undefined;
  return model;
}

const noToolList = (agent: ContextAgent, rest: string) =>
  `${AGENT_NAMES[agent]} subagents have no tool list${rest}`;

function one(
  builder: Builder,
  subagent: ContextSubagent,
  agent: ContextAgent,
): Omit<Placement, "agent"> {
  const header = headerText([subagent.path]);
  const model = modelFor(subagent, agent);
  const tools = subagent.tools;
  const base = { name: subagent.name, description: subagent.description };
  const write = (path: string, text: string, kind: "front_matter" | "comment" = "front_matter") => {
    builder.add({ path, sources: [subagent.path], header: kind, content: { kind: "text", text } });
    return [path];
  };
  const result = (files: string[], gaps: string[]): Omit<Placement, "agent"> => ({
    status: gaps.length > 0 ? "partial" : "compiled",
    files,
    detail: gaps.join(" "),
  });
  switch (agent) {
    case "claude_code": {
      const data = {
        ...base,
        ...(tools ? { tools: tools.join(", ") } : {}),
        ...(model ? { model } : {}),
      };
      return result(
        write(
          `.claude/agents/${subagent.name}.md`,
          markdownWithFrontMatter(data, subagent.body, header),
        ),
        [],
      );
    }
    case "codex": {
      const lines = [
        hashHeader([subagent.path]).trimEnd(),
        `name = ${JSON.stringify(subagent.name)}`,
        `description = ${JSON.stringify(subagent.description)}`,
        ...(model ? [`model = ${JSON.stringify(model)}`] : []),
        `developer_instructions = ${tomlMultiline(subagent.body)}`,
      ];
      const files = write(
        `.codex/agents/${subagent.name}.toml`,
        `${lines.join("\n")}\n`,
        "comment",
      );
      return result(
        files,
        tools
          ? [
              "Codex subagents take their tools and sandbox from the parent session, so tools is not compiled.",
            ]
          : [],
      );
    }
    case "cursor": {
      const readonly = tools?.every((tool) => READ_ONLY.has(tool)) ?? false;
      const data = {
        ...base,
        ...(model ? { model } : {}),
        ...(readonly ? { readonly: true } : {}),
      };
      const files = write(
        `.cursor/agents/${subagent.name}.md`,
        markdownWithFrontMatter(data, subagent.body, header),
      );
      if (!tools) return result(files, []);
      return result(files, [
        noToolList(
          agent,
          readonly
            ? ": readonly: true keeps it to reading, with every read tool."
            : ", so it gets every tool.",
        ),
      ]);
    }
    case "copilot": {
      const mapped = tools?.map((tool) => [tool, copilotTool(tool)] as const);
      const unmapped =
        mapped?.filter(([, alias]) => alias === undefined).map(([tool]) => tool) ?? [];
      const aliases = [...new Set(mapped?.flatMap(([, alias]) => (alias ? [alias] : [])) ?? [])];
      const data = { ...base, ...(mapped ? { tools: aliases } : {}), ...(model ? { model } : {}) };
      const files = write(
        `.github/agents/${subagent.name}.agent.md`,
        markdownWithFrontMatter(data, subagent.body, header),
      );
      const gaps: string[] = [];
      if (unmapped.length > 0)
        gaps.push(`Copilot has no alias for ${listed(unmapped)}, so the subagent goes without.`);
      if (aliases.length > 0) {
        gaps.push(
          `Copilot grants tools by alias (${listed(aliases)}), which can cover more tools than the list names.`,
        );
      }
      if (subagent.body.length > 30_000)
        gaps.push("Copilot reads the first 30,000 characters of the prompt.");
      return result(files, gaps);
    }
    case "gemini": {
      const data = { ...base, ...(model ? { model } : {}) };
      const files = write(
        `.gemini/agents/${subagent.name}.md`,
        markdownWithFrontMatter(data, subagent.body, header),
      );
      return result(
        files,
        tools
          ? ["selfhost does not map tool names to Gemini CLI's, so the subagent gets every tool."]
          : [],
      );
    }
    case "opencode": {
      const known = [...new Set(Object.values(OPENCODE_TOOLS).flat())];
      const granted = new Set(tools?.flatMap((tool) => OPENCODE_TOOLS[tool] ?? []));
      const off = tools
        ? Object.fromEntries(
            known.filter((tool) => !granted.has(tool)).map((tool) => [tool, false]),
          )
        : {};
      const data = {
        description: subagent.description,
        mode: "subagent",
        ...(model ? { model } : {}),
        ...(Object.keys(off).length > 0 ? { tools: off } : {}),
      };
      const files = write(
        `.opencode/agents/${subagent.name}.md`,
        markdownWithFrontMatter(data, subagent.body, header),
      );
      return result(
        files,
        tools
          ? [
              `OpenCode turns off the ${listed(known)} tools the list leaves out; its other tools stay on.`,
            ]
          : [],
      );
    }
    case "goose": {
      const data = { ...base, ...(model ? { model } : {}) };
      const files = write(
        `.agents/agents/${subagent.name}.md`,
        markdownWithFrontMatter(data, subagent.body, header),
      );
      return result(files, tools ? [noToolList(agent, ", so it gets every tool.")] : []);
    }
  }
}

export function compileSubagent(
  builder: Builder,
  subagent: ContextSubagent,
  targets: readonly ContextAgent[],
): void {
  for (const agent of subagent.agents.filter((candidate) => targets.includes(candidate))) {
    builder.place(subagent, { agent, ...one(builder, subagent, agent) });
  }
}
