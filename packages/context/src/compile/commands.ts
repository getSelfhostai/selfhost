import type { ContextAgent } from "@selfhost/schema";
import { markdownWithFrontMatter } from "../frontmatter.js";
import type { ContextCommand } from "../types.js";
import {
  type Builder,
  hashHeader,
  headerText,
  type Placement,
  tomlMultiline,
  withArguments,
} from "./output.js";

// Slash commands. The source body takes $ARGUMENTS for what the person types after the command.
// - Claude Code: .claude/commands/<name>.md, description and argument-hint, $ARGUMENTS.
//   https://code.claude.com/docs/en/skills (commands now share the skills page)
// - Codex: custom prompts live only in ~/.codex/prompts and are deprecated; no project commands.
//   https://learn.chatgpt.com/docs/custom-prompts
// - Cursor: commands became skills; /migrate-to-skills turns each into a skill with
//   disable-model-invocation: true, run as /<name>. No argument placeholder is documented.
//   https://cursor.com/docs/context/skills
// - Copilot: prompt files .github/prompts/<name>.prompt.md run in VS Code only; the CLI reads
//   .claude/commands; the cloud agent has none. ${input:name} asks for a value.
//   https://code.visualstudio.com/docs/agent-customization/prompt-files
// - Gemini CLI: .gemini/commands/<name>.toml with prompt and description, {{args}}.
//   https://geminicli.com/docs/cli/custom-commands/
// - OpenCode: .opencode/commands/<name>.md, description, $ARGUMENTS.
//   https://opencode.ai/docs/commands/
// - Goose: slash commands map to recipes only in each person's config.yaml; none in a project.
//   https://goose-docs.ai/docs/guides/context-engineering/slash-commands/

// biome-ignore lint/suspicious/noTemplateCurlyInString: Copilot's own input variable syntax.
const COPILOT_ARGUMENTS = "${input:arguments}";

const usesArguments = (command: ContextCommand) => command.body.includes("$ARGUMENTS");

function file(
  builder: Builder,
  command: ContextCommand,
  path: string,
  text: string,
  header: "front_matter" | "comment",
) {
  builder.add({ path, sources: [command.path], header, content: { kind: "text", text } });
}

function one(
  builder: Builder,
  command: ContextCommand,
  agent: ContextAgent,
  targets: readonly ContextAgent[],
): Omit<Placement, "agent"> {
  const header = headerText([command.path]);
  const meta = {
    ...(command.description ? { description: command.description } : {}),
    ...(command.argumentHint ? { "argument-hint": command.argumentHint } : {}),
  };
  switch (agent) {
    case "claude_code": {
      const path = `.claude/commands/${command.name}.md`;
      file(
        builder,
        command,
        path,
        markdownWithFrontMatter(meta, command.body, header),
        "front_matter",
      );
      return { status: "compiled", files: [path], detail: "" };
    }
    case "codex":
      return {
        status: "not_expressible",
        files: [],
        detail:
          "Codex reads custom prompts only from ~/.codex/prompts, and they are deprecated in favor of skills; it has no project commands.",
      };
    case "cursor": {
      const path = `.cursor/skills/${command.name}/SKILL.md`;
      const data = {
        name: command.name,
        description: command.description ?? `The /${command.name} command.`,
        "disable-model-invocation": true,
      };
      file(
        builder,
        command,
        path,
        markdownWithFrontMatter(data, command.body, header),
        "front_matter",
      );
      return usesArguments(command)
        ? {
            status: "partial",
            files: [path],
            detail:
              "Cursor runs commands as skills, which have no documented argument placeholder: $ARGUMENTS reaches the model as written.",
          }
        : { status: "compiled", files: [path], detail: "" };
    }
    case "copilot": {
      const path = `.github/prompts/${command.name}.prompt.md`;
      const body = withArguments(command.body, COPILOT_ARGUMENTS);
      file(
        builder,
        command,
        path,
        markdownWithFrontMatter({ ...meta, agent: "agent" }, body, header),
        "front_matter",
      );
      const cli =
        targets.includes("claude_code") && command.agents.includes("claude_code")
          ? "the Copilot CLI runs it from .claude/commands"
          : "the Copilot CLI reads commands only from .claude/commands, which this compile does not write";
      return {
        status: "partial",
        files: [path],
        detail: `Prompt files run in VS Code only; ${cli}; the cloud agent has no slash commands.`,
      };
    }
    case "gemini": {
      const path = `.gemini/commands/${command.name}.toml`;
      const lines = [hashHeader([command.path]).trimEnd()];
      if (command.description) lines.push(`description = ${JSON.stringify(command.description)}`);
      lines.push(`prompt = ${tomlMultiline(withArguments(command.body, "{{args}}"))}`);
      file(builder, command, path, `${lines.join("\n")}\n`, "comment");
      return { status: "compiled", files: [path], detail: "" };
    }
    case "opencode": {
      const path = `.opencode/commands/${command.name}.md`;
      const data = command.description ? { description: command.description } : {};
      file(
        builder,
        command,
        path,
        markdownWithFrontMatter(data, command.body, header),
        "front_matter",
      );
      return { status: "compiled", files: [path], detail: "" };
    }
    case "goose":
      return {
        status: "not_expressible",
        files: [],
        detail:
          "Goose maps slash commands to recipes only in each person's config.yaml; it has no project commands.",
      };
  }
}

export function compileCommand(
  builder: Builder,
  command: ContextCommand,
  targets: readonly ContextAgent[],
): void {
  for (const agent of command.agents.filter((candidate) => targets.includes(candidate))) {
    builder.place(command, { agent, ...one(builder, command, agent, targets) });
  }
}
