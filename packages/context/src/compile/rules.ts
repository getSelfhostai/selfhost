import type { ContextAgent } from "@selfhost/schema";
import { markdownWithFrontMatter } from "../frontmatter.js";
import type { ContextRule, RulerFile } from "../types.js";
import { AGENT_NAMES } from "./agents.js";
import { type Builder, headerText, itemId } from "./output.js";
import { type RulesFile, rulesFileText, type Section } from "./ruler.js";

// How rules map, from the docs in agents.ts:
// - Claude Code: CLAUDE.md, and .claude/rules/<name>.md with `paths` for scoped rules.
//   https://code.claude.com/docs/en/memory
// - Codex: AGENTS.md only; nested AGENTS.md files are its only scoping.
//   https://learn.chatgpt.com/docs/agent-configuration/agents-md
// - Cursor: AGENTS.md, and .cursor/rules/<name>.mdc with description, globs (comma separated)
//   and alwaysApply. https://cursor.com/docs/context/rules
// - Copilot: AGENTS.md, .github/copilot-instructions.md, and
//   .github/instructions/<name>.instructions.md with applyTo (comma separated).
//   https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
// - Gemini CLI: GEMINI.md, no scoping. https://geminicli.com/docs/cli/gemini-md/
// - OpenCode: AGENTS.md, no scoping. https://opencode.ai/docs/instructions/
// - Goose: AGENTS.md and .goosehints, no scoping.
//   https://goose-docs.ai/docs/guides/context-engineering/using-goosehints/
//
// AGENTS.md is shared: Codex, Cursor, Copilot, OpenCode and Goose all read it. A rule for any
// of them goes there once. Codex and OpenCode have no other file, so a rule for them goes in
// AGENTS.md even when other readers of AGENTS.md are not meant to see it; the coverage then
// says which agents see it anyway. A rule only some of the others want goes in each one's own
// file instead: .cursor/rules, .github/copilot-instructions.md or .goosehints.

const AGENTS_MD_READERS: readonly ContextAgent[] = [
  "codex",
  "cursor",
  "copilot",
  "opencode",
  "goose",
];
const AGENTS_MD_ONLY: readonly ContextAgent[] = ["codex", "opencode"];
/** AGENTS.md readers with path-scoped rules files of their own. */
const SCOPING_READERS: readonly ContextAgent[] = ["cursor", "copilot"];

/** The text a rules file without path scoping carries for a scoped rule. */
function scopeLine(globs: readonly string[]): string {
  return `Applies only to files matching ${globs.map((glob) => `\`${glob}\``).join(", ")}.`;
}

function section(rule: ContextRule): Section {
  const text = rule.globs.length > 0 ? `${scopeLine(rule.globs)}\n\n${rule.body}` : rule.body;
  return { source: rule.path, text };
}

const unscopedDetail = (agent: ContextAgent, file: string) =>
  `${AGENT_NAMES[agent]} has no path-scoped instructions, so ${file} carries the rule for every file, with its globs written out.`;

export class RulesCompiler {
  private sections = new Map<RulesFile, Section[]>();

  constructor(
    private builder: Builder,
    private targets: readonly ContextAgent[],
    ruler: readonly RulerFile[],
  ) {
    // Ruler puts every .ruler/ file in every rules file: here, once for each agent.
    if (ruler.length > 0) {
      const all = { globs: [], agents: [...targets] };
      for (const file of ruler) {
        this.route(
          { ...all, kind: "rule", name: file.path, path: file.path, body: file.text },
          false,
        );
      }
    }
  }

  private addSection(file: RulesFile, rule: ContextRule): void {
    const list = this.sections.get(file) ?? [];
    if (!list.some((entry) => entry.source === rule.path)) list.push(section(rule));
    this.sections.set(file, list);
  }

  /** Routes a rule; `place` is false for .ruler/ files, which get no coverage entries. */
  route(rule: ContextRule, place = true): void {
    const wanted = rule.agents.filter((agent) => this.targets.includes(agent));
    const scoped = rule.globs.length > 0;
    const put = (agent: ContextAgent, file: string, partial: boolean) => {
      if (place) {
        this.builder.place(rule, {
          agent,
          status: partial ? "partial" : "compiled",
          files: [file],
          detail: partial ? unscopedDetail(agent, file) : "",
        });
      } else {
        this.builder.carry(file, itemId(rule));
      }
    };
    const inRulesFile = (agent: ContextAgent, file: RulesFile) => {
      this.addSection(file, rule);
      put(agent, file, scoped);
    };

    const readers = this.targets.filter((agent) => AGENTS_MD_READERS.includes(agent));
    const need = wanted.filter((agent) => AGENTS_MD_READERS.includes(agent));
    // A scoped rule in AGENTS.md reaches Cursor and Copilot a second time, unscoped, beside
    // their own scoped file: only Codex and OpenCode, which have no other file, force that.
    const inAgentsMd =
      need.some((agent) => AGENTS_MD_ONLY.includes(agent)) ||
      (need.length > 0 &&
        need.length === readers.length &&
        (!scoped || !readers.some((agent) => SCOPING_READERS.includes(agent))));

    for (const agent of wanted) {
      if (agent === "claude_code") {
        if (scoped) this.scopedFile(rule, ".claude/rules/", place);
        else inRulesFile(agent, "CLAUDE.md");
      } else if (agent === "gemini") {
        inRulesFile(agent, "GEMINI.md");
      } else if (agent === "cursor" && (scoped || !inAgentsMd)) {
        this.scopedFile(rule, ".cursor/rules/", place);
      } else if (agent === "copilot" && scoped) {
        this.scopedFile(rule, ".github/instructions/", place);
      } else if (inAgentsMd) {
        inRulesFile(agent, "AGENTS.md");
      } else if (agent === "copilot") {
        inRulesFile(agent, ".github/copilot-instructions.md");
      } else if (agent === "goose") {
        inRulesFile(agent, ".goosehints");
      }
    }
  }

  /** A per-rule file in a folder that scopes rules by path. */
  private scopedFile(rule: ContextRule, folder: string, place: boolean): void {
    const header = headerText([rule.path]);
    const globs = rule.globs;
    let path: string;
    let text: string;
    let agent: ContextAgent;
    if (folder === ".claude/rules/") {
      agent = "claude_code";
      path = `${folder}${rule.name}.md`;
      text = markdownWithFrontMatter({ paths: globs }, rule.body, header);
    } else if (folder === ".cursor/rules/") {
      agent = "cursor";
      path = `${folder}${rule.name}.mdc`;
      text = markdownWithFrontMatter(
        {
          ...(rule.description ? { description: rule.description } : {}),
          ...(globs.length > 0 ? { globs: globs.join(", ") } : {}),
          alwaysApply: globs.length === 0,
        },
        rule.body,
        header,
      );
    } else {
      agent = "copilot";
      path = `${folder}${rule.name}.instructions.md`;
      text = markdownWithFrontMatter(
        {
          applyTo: globs.join(","),
          ...(rule.description ? { description: rule.description } : {}),
        },
        rule.body,
        header,
      );
    }
    this.builder.add({
      path,
      sources: [rule.path],
      header: "front_matter",
      content: { kind: "text", text },
    });
    if (place) this.builder.place(rule, { agent, status: "compiled", files: [path], detail: "" });
  }

  /** Writes each rules file that got sections, through Ruler. */
  async finish(): Promise<void> {
    for (const [file, sections] of this.sections) {
      const text = await rulesFileText(file, sections);
      this.builder.add({
        path: file,
        sources: [...new Set(sections.map((entry) => entry.source))],
        header: "comment",
        content: { kind: "text", text },
      });
    }
  }
}
