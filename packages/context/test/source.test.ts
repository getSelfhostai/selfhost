import { describe, expect, it } from "vitest";
import { type ContextError, formatContextError, readContextSource } from "../src/index.js";
import { FIXTURE_REPO, temp } from "./helpers.js";

function errorsOf(files: Record<string, string>): ContextError[] {
  const dir = temp();
  for (const [name, content] of Object.entries(files))
    dir.write(`.selfhost/context/${name}`, content);
  const read = readContextSource(dir.root);
  if (read.ok) throw new Error("expected errors");
  return read.errors;
}

const skill = (front: string) => `---\nname: s\ndescription: Does s.\n${front}---\n\nDo it.\n`;

describe("readContextSource", () => {
  it("reads every kind from the fixture, with the .ruler files in Ruler's order", () => {
    const read = readContextSource(FIXTURE_REPO);
    if (!read.ok) throw new Error(read.errors.map(formatContextError).join("\n"));
    const { source, ruler } = read;
    expect(source.rules.map((rule) => rule.name)).toEqual([
      "api",
      "claude-memory",
      "codex-sandbox",
      "copilot-review",
      "cursor-tabs",
      "goose-hints",
      "style",
    ]);
    const api = source.rules.find((rule) => rule.name === "api");
    expect(api?.globs).toEqual(["src/api/**/*.ts", "**/*.sql"]);
    expect(api?.agents).toHaveLength(7);
    expect(source.rules.find((rule) => rule.name === "codex-sandbox")?.agents).toEqual(["codex"]);
    const notes = source.skills.find((entry) => entry.name === "release-notes");
    expect(notes?.version).toBe("1.2.0");
    expect(notes?.files.map((file) => [file.path, file.executable])).toEqual([
      ["references/template.md", false],
      ["scripts/collect.sh", true],
    ]);
    expect(source.commands.map((command) => command.name)).toEqual(["fix-issue", "standup"]);
    expect(source.agents.find((agent) => agent.name === "reviewer")?.model).toEqual({
      claude_code: "sonnet",
      cursor: "inherit",
      gemini: "inherit",
    });
    expect(source.mcp.map((server) => [server.name, server.spec.type ?? "stdio"])).toEqual([
      ["docs", "stdio"],
      ["github", "http"],
      ["tickets", "sse"],
    ]);
    expect(ruler.map((file) => file.path)).toEqual([".ruler/team.md"]);
  });

  it("says there is no source", () => {
    const read = readContextSource(temp().root);
    expect(read.ok).toBe(false);
  });

  it("reports front matter problems with file, line and field", () => {
    const errors = errorsOf({
      "rules/a.md": "---\nagents: [claude_code]\nglob: src/**\n---\n\nText.\n",
      "rules/b.md": "---\nagents: [nobody]\n---\n\nText.\n",
      "skills/s/SKILL.md": skill("version: one\n"),
      "agents/x.md": "---\nname: y\ndescription: Y.\n---\n\nPrompt.\n",
      "commands/c.md": "---\ndescription: [unclosed\n---\n\nGo.\n",
    });
    expect(errors.map(formatContextError)).toEqual([
      ".selfhost/context/rules/a.md:3: glob: Unknown key; the keys are agents, globs and description",
      ".selfhost/context/rules/b.md:2: agents[0]: Expected one of: all, claude_code, codex, cursor, copilot, gemini, opencode, goose",
      expect.stringMatching(
        /^\.selfhost\/context\/skills\/s\/SKILL\.md:4: version: Expected a string matching/,
      ),
      expect.stringMatching(/^\.selfhost\/context\/commands\/c\.md:2: /),
      ".selfhost/context/agents/x.md:2: name: name must match the file name (x)",
    ]);
  });

  it("reports MCP problems at their line, and JSON syntax errors", () => {
    const servers = (body: string) => `{\n  "mcpServers": {\n${body}\n  }\n}\n`;
    expect(
      errorsOf({ "mcp.json": servers('    "a": { "command": "x", "url": "https://a" }') }).map(
        formatContextError,
      ),
    ).toEqual([
      ".selfhost/context/mcp.json:3: mcpServers.a: A server has either a command (stdio) or a url (http, sse)",
    ]);
    expect(
      errorsOf({
        "mcp.json": servers('    "a": {\n      "url": "https://a",\n      "timeout": 5\n    }'),
      }).map(formatContextError),
    ).toEqual([
      ".selfhost/context/mcp.json:5: mcpServers.a.timeout: Unknown key; the keys are type, command, args, env, url, headers and agents",
    ]);
    const [syntax] = errorsOf({
      "mcp.json": '{\n  "mcpServers": {\n    "a": { "command": "x", }\n  }\n}\n',
    });
    expect(syntax?.file).toBe(".selfhost/context/mcp.json");
    expect(syntax?.line).toBe(3);
  });

  it("refuses links, unknown entries, name clashes and files where folders go", () => {
    const dir = temp();
    dir.write(".selfhost/context/rules/ok.md", "Text.\n");
    dir.write("outside.md", "Text.\n");
    dir.link(".selfhost/context/rules/linked.md", dir.path("outside.md"));
    dir.write(".selfhost/context/rule/typo.md", "Text.\n");
    dir.write(".selfhost/context/skills/loose.md", "Text.\n");
    dir.write(
      ".selfhost/context/skills/ship/SKILL.md",
      skill("version: 1.0.0\n").replace("name: s", "name: ship"),
    );
    dir.write(".selfhost/context/commands/ship.md", "Ship it.\n");
    dir.write(".selfhost/context/commands/Bad Name.md", "Text.\n");
    const read = readContextSource(dir.root);
    if (read.ok) throw new Error("expected errors");
    expect(read.errors.map((error) => [error.file, error.message.split(";")[0]])).toEqual([
      [".selfhost/context/rule", "Unknown entry"],
      [".selfhost/context/rules/linked.md", "Symbolic links are not compiled"],
      [
        ".selfhost/context/skills/loose.md",
        "Each skill is a folder with a SKILL.md: skills/<name>/SKILL.md",
      ],
      [
        ".selfhost/context/commands/Bad Name.md",
        "The file name must be lowercase letters and digits, with single - or _ between words",
      ],
      [".selfhost/context/commands/ship.md", "A skill is also named ship"],
    ]);
  });
});
