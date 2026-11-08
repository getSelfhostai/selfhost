import {
  CONTEXT_AGENTS,
  type ContextAgent,
  type ContextAgentCoverage,
  type ContextCoverage,
  type ContextItemCoverage,
} from "@selfhost/schema";
import type { ContextItem, ContextSource, RulerFile } from "../types.js";
import { AGENT_DOCS, AGENT_NAMES, listed, namesOf, readerKey, readersOf } from "./agents.js";
import { compileCommand } from "./commands.js";
import { McpCompiler } from "./mcp.js";
import { Builder, type GeneratedFile, itemId } from "./output.js";
import { RulesCompiler } from "./rules.js";
import { compileSkill } from "./skills.js";
import { compileSubagent } from "./subagents.js";

export interface CompileOptions {
  /** Agents to compile for; default every agent, in CONTEXT_AGENTS order. */
  agents?: readonly ContextAgent[];
  /** Markdown from the repository's .ruler/ folder, which Ruler puts in every rules file. */
  ruler?: readonly RulerFile[];
}

/** What one skill compiled to, per agent: the lock records it. */
export interface SkillResult {
  name: string;
  version: string;
  /** The source folder. */
  path: string;
  agents: Partial<Record<ContextAgent, { status: ContextItemCoverage["status"]; files: string[] }>>;
}

export interface CompileResult {
  agents: ContextAgent[];
  /** Every file the source compiles to, sorted by path. */
  files: GeneratedFile[];
  coverage: ContextCoverage;
  skills: SkillResult[];
}

export function itemsOf(source: ContextSource): ContextItem[] {
  return [...source.rules, ...source.skills, ...source.commands, ...source.agents, ...source.mcp];
}

/** Notes that hold for an agent whenever it gets items of a kind. */
function kindNotes(agent: ContextAgent, kinds: Set<string>): string[] {
  const notes: string[] = [];
  if (agent === "claude_code" && kinds.has("mcp")) {
    notes.push("Claude Code asks once before it starts each server in .mcp.json.");
  }
  if (agent === "codex" && kinds.has("mcp")) {
    notes.push("Codex loads .codex/config.toml, and its MCP servers, only in projects you trust.");
  }
  if (agent === "opencode" && (kinds.has("mcp") || kinds.has("agent"))) {
    notes.push(
      "MCP servers and subagent tools use OpenCode's 1.x layout (mcp.<name>, tools), which OpenCode 2 also reads.",
    );
  }
  if (agent === "goose" && kinds.has("rule")) {
    notes.push("Goose loads AGENTS.md and .goosehints only with its Developer extension on.");
  }
  return notes;
}

/**
 * Compiles a context source into each agent's own files and says, per item and agent, what the
 * agent gets. Rules files are written through Ruler (in a scratch folder); everything else is
 * built here. Nothing in the repository is read or written: see planContext for that.
 */
export async function compileContext(
  source: ContextSource,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const wanted = new Set(options.agents ?? CONTEXT_AGENTS);
  const targets = CONTEXT_AGENTS.filter((agent) => wanted.has(agent));
  const builder = new Builder();
  const rules = new RulesCompiler(builder, targets, options.ruler ?? []);
  for (const rule of source.rules) rules.route(rule);
  for (const skill of source.skills) compileSkill(builder, skill, targets);
  for (const command of source.commands) compileCommand(builder, command, targets);
  for (const subagent of source.agents) compileSubagent(builder, subagent, targets);
  const mcp = new McpCompiler(builder);
  for (const server of source.mcp) mcp.add(server, targets);
  await rules.finish();
  mcp.finish();

  const items = itemsOf(source);
  const coverage: ContextItemCoverage[] = [];
  for (const item of items) {
    const id = itemId(item);
    const placements = builder.placements.get(id) ?? [];
    for (const agent of targets) {
      const placement = placements.find((candidate) => candidate.agent === agent);
      if (placement) {
        const { status, files, detail } = placement;
        coverage.push({ item: id, kind: item.kind, agent, status, files, detail });
        continue;
      }
      const seen = [...builder.carries]
        .filter(([path, ids]) => ids.has(id) && readersOf(path).includes(agent))
        .map(([path]) => path);
      coverage.push({
        item: id,
        kind: item.kind,
        agent,
        status: "not_applicable",
        files: seen,
        detail:
          seen.length > 0
            ? `Only for ${namesOf(item.agents)}, but ${AGENT_NAMES[agent]} reads it in ${listed(seen)}.`
            : `Only for ${namesOf(item.agents)}.`,
      });
    }
  }

  const agents: ContextAgentCoverage[] = targets.map((agent) => {
    const own = new Set(
      [...builder.placements.values()]
        .flat()
        .filter((placement) => placement.agent === agent)
        .flatMap((placement) => placement.files),
    );
    const kinds = new Set(
      items.filter((item) => item.agents.includes(agent)).map((item) => item.kind),
    );
    const extra = [
      ...new Set(
        [...builder.files.keys()]
          .filter((path) => !own.has(path) && readersOf(path).includes(agent))
          .map((path) => readerKey(path) as string),
      ),
    ];
    const notes = kindNotes(agent, kinds);
    if (extra.length > 0) {
      notes.push(
        `${AGENT_NAMES[agent]} also loads ${listed(extra)}, written for other agents, so it sees those items there too.`,
      );
    }
    return { agent, docs: AGENT_DOCS[agent], notes };
  });

  const skills: SkillResult[] = source.skills.map((skill) => ({
    name: skill.name,
    version: skill.version,
    path: skill.path,
    agents: Object.fromEntries(
      coverage
        .filter((entry) => entry.item === itemId(skill))
        .map((entry) => [entry.agent, { status: entry.status, files: entry.files }]),
    ),
  }));

  return {
    agents: targets,
    files: [...builder.files.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    coverage: { schema: "selfhost.context_coverage/v1", agents, items: coverage },
    skills,
  };
}
