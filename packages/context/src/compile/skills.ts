import type { ContextAgent } from "@selfhost/schema";
import { markdownWithFrontMatter } from "../frontmatter.js";
import type { ContextSkill } from "../types.js";
import { AGENT_NAMES, listed } from "./agents.js";
import { type Builder, headerText } from "./output.js";

// Skills use the Agent Skills format (https://agentskills.io/specification) everywhere. Claude
// Code reads them only from .claude/skills (https://code.claude.com/docs/en/skills); every other
// agent reads .agents/skills: Codex (https://learn.chatgpt.com/docs/build-skills), Cursor
// (https://cursor.com/docs/context/skills), Copilot's cloud agent, CLI and VS Code local
// sessions (https://docs.github.com/en/copilot/concepts/agents/about-agent-skills), Gemini CLI
// (https://geminicli.com/docs/cli/skills/), OpenCode (https://opencode.ai/docs/skills/) and
// Goose (https://goose-docs.ai/docs/guides/context-engineering/using-skills/).

/** Keys every agent can carry: they describe the skill and change nothing about how it runs. */
const DESCRIPTIVE = new Set(["name", "description", "license", "compatibility", "metadata"]);

/** Keys of selfhost's source that never reach an agent's copy (version goes into metadata). */
const SOURCE_ONLY = new Set(["version", "agents"]);

/** The keys that change how a skill runs, per agent, from the docs above. */
const RUN_KEYS: Record<ContextAgent, readonly string[]> = {
  claude_code: [
    "allowed-tools",
    "disable-model-invocation",
    "user-invocable",
    "argument-hint",
    "arguments",
    "when_to_use",
    "disallowed-tools",
    "model",
    "effort",
    "context",
    "agent",
    "background",
    "hooks",
    "paths",
    "shell",
  ],
  codex: [],
  cursor: ["disable-model-invocation", "paths", "globs", "icon", "color"],
  copilot: ["allowed-tools", "argument-hint", "user-invocable", "disable-model-invocation"],
  gemini: [],
  opencode: ["disable-model-invocation"],
  goose: [],
};

/** The SKILL.md an agent gets: the source's keys, with version moved into metadata. */
export function compiledSkillMd(skill: ContextSkill): string {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(skill.frontMatter)) {
    if (!SOURCE_ONLY.has(key) && key !== "metadata") data[key] = value;
  }
  const metadata = (skill.frontMatter.metadata as Record<string, string> | undefined) ?? {};
  data.metadata = { ...metadata, version: skill.version };
  return markdownWithFrontMatter(data, skill.body, headerText([`${skill.path}/SKILL.md`]));
}

function addFolder(builder: Builder, skill: ContextSkill, folder: string): string[] {
  const base = `${folder}${skill.name}`;
  builder.add({
    path: `${base}/SKILL.md`,
    sources: [`${skill.path}/SKILL.md`],
    header: "front_matter",
    content: { kind: "text", text: compiledSkillMd(skill) },
  });
  for (const file of skill.files) {
    builder.add({
      path: `${base}/${file.path}`,
      sources: [`${skill.path}/${file.path}`],
      header: "lock",
      content: { kind: "bytes", bytes: file.content, executable: file.executable },
    });
  }
  return [`${base}/SKILL.md`, ...skill.files.map((file) => `${base}/${file.path}`)];
}

export function compileSkill(
  builder: Builder,
  skill: ContextSkill,
  targets: readonly ContextAgent[],
) {
  const runKeys = Object.keys(skill.frontMatter).filter(
    (key) => !DESCRIPTIVE.has(key) && !SOURCE_ONLY.has(key),
  );
  for (const agent of skill.agents.filter((candidate) => targets.includes(candidate))) {
    const folder = agent === "claude_code" ? ".claude/skills/" : ".agents/skills/";
    const files = addFolder(builder, skill, folder);
    const missing = runKeys.filter((key) => !RUN_KEYS[agent].includes(key));
    const gaps: string[] = [];
    if (missing.length > 0) {
      gaps.push(
        `${AGENT_NAMES[agent]} does not read ${listed(missing)}, so the skill runs without ${missing.length === 1 ? "it" : "them"}.`,
      );
    }
    if (agent === "copilot") {
      gaps.push(
        "VS Code sessions on the Copilot harness read skills only from .github/skills; the cloud agent, the CLI and local VS Code sessions read .agents/skills.",
      );
    }
    builder.place(skill, {
      agent,
      status: gaps.length > 0 ? "partial" : "compiled",
      files,
      detail: gaps.join(" "),
    });
  }
}
