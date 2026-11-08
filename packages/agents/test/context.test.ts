import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ContextFile, findContextFiles } from "../src/index.js";
import { type Fixture, fixtureHome } from "./helpers.js";

function shorten(files: ContextFile[], repo: Fixture, home: Fixture) {
  return files.map((file) => ({
    path: file.path.startsWith(repo.home)
      ? file.path.slice(repo.home.length + 1)
      : `~/${file.path.slice(home.home.length + 1)}`,
    kind: file.kind,
    scope: file.scope,
    agent: file.agent,
    readers: file.readers,
  }));
}

function fixture() {
  const home = fixtureHome("ctx-home");
  const repo = fixtureHome("ctx-repo");
  mkdirSync(repo.path(".git"));
  return { home, repo };
}

describe("findContextFiles", () => {
  it("lists CLAUDE.md, AGENTS.md, skills and rules in the repo and the home config", () => {
    const { home, repo } = fixture();
    repo.write("CLAUDE.md", "# rules\n");
    repo.write("AGENTS.md", "# agents\n");
    repo.write("packages/api/AGENTS.md", "nested\n");
    repo.write("node_modules/dep/AGENTS.md", "skipped\n");
    repo.write(".claude/skills/release/SKILL.md", "---\nname: release\n---\n");
    repo.write(".claude/commands/ship/fast.md", "ship it\n");
    repo.write(".cursor/rules/style.mdc", "rule\n");
    repo.write(".goosehints", "hint\n");
    home.write(".claude/CLAUDE.md", "global\n");
    home.write(".claude/skills/review/SKILL.md", "skill\n");
    home.write(".claude/skills/empty/README.md", "not a skill\n");
    home.write(".codex/AGENTS.md", "codex global\n");
    home.write(".config/opencode/AGENTS.md", "opencode global\n");

    const files = findContextFiles({
      home: home.home,
      cwd: repo.path("packages", "api"),
      platform: "linux",
    });
    const all = ["codex", "cursor", "copilot", "opencode", "goose"];
    expect(shorten(files, repo, home)).toEqual([
      {
        path: "CLAUDE.md",
        kind: "claude_md",
        scope: "repo",
        agent: "claude_code",
        readers: ["claude_code", "cursor", "copilot"],
      },
      // A CLAUDE.md in the same folder means Claude Code reads it instead of AGENTS.md.
      { path: "AGENTS.md", kind: "agents_md", scope: "repo", agent: "shared", readers: all },
      { path: ".goosehints", kind: "hints", scope: "repo", agent: "goose", readers: ["goose"] },
      {
        path: "packages/api/AGENTS.md",
        kind: "agents_md",
        scope: "repo",
        agent: "shared",
        readers: all,
      },
      {
        path: ".claude/skills/release/SKILL.md",
        kind: "skill",
        scope: "repo",
        agent: "claude_code",
        readers: ["claude_code", "opencode"],
      },
      {
        path: ".claude/commands/ship/fast.md",
        kind: "command",
        scope: "repo",
        agent: "claude_code",
        readers: ["claude_code"],
      },
      {
        path: ".cursor/rules/style.mdc",
        kind: "rule",
        scope: "repo",
        agent: "cursor",
        readers: ["cursor"],
      },
      {
        path: "~/.claude/CLAUDE.md",
        kind: "claude_md",
        scope: "home",
        agent: "claude_code",
        readers: ["claude_code"],
      },
      {
        path: "~/.claude/skills/review/SKILL.md",
        kind: "skill",
        scope: "home",
        agent: "claude_code",
        readers: ["claude_code", "opencode"],
      },
      {
        path: "~/.codex/AGENTS.md",
        kind: "agents_md",
        scope: "home",
        agent: "codex",
        readers: ["codex"],
      },
      {
        path: "~/.config/opencode/AGENTS.md",
        kind: "agents_md",
        scope: "home",
        agent: "opencode",
        readers: ["opencode"],
      },
    ]);
    expect(files[0]?.size).toBe(8);
  });

  it("lists only home files without a cwd", () => {
    const home = fixtureHome("ctx-only");
    home.write(".claude/agents/reviewer.md", "agent\n");
    expect(findContextFiles({ home: home.home }).map((file) => file.kind)).toEqual(["subagent"]);
  });

  it("finds Copilot and Gemini instructions and MCP configs, in the repo and at home", () => {
    const { home, repo } = fixture();
    repo.write(".github/copilot-instructions.md", "copilot\n");
    repo.write(".github/instructions/ts/api.instructions.md", "---\napplyTo: '**/*.ts'\n---\n");
    repo.write(".github/instructions/notes.md", "not an instructions file\n");
    repo.write("GEMINI.md", "gemini\n");
    repo.write(".mcp.json", "{}\n");
    repo.write(".cursor/mcp.json", "{}\n");
    repo.write(".codex/config.toml", "\n");
    home.write(".copilot/copilot-instructions.md", "mine\n");
    home.write(".gemini/GEMINI.md", "mine\n");
    home.write(".gemini/settings.json", "{}\n");
    home.write(".claude.json", "{}\n");
    home.write(".cursor/mcp.json", "{}\n");

    const files = findContextFiles({ home: home.home, cwd: repo.home, platform: "linux" });
    expect(
      shorten(files, repo, home).map((file) => [file.path, file.kind, file.readers.join(",")]),
    ).toEqual([
      ["GEMINI.md", "gemini_md", "gemini,copilot"],
      [".github/copilot-instructions.md", "instructions", "copilot"],
      [".github/instructions/ts/api.instructions.md", "instructions", "copilot"],
      [".mcp.json", "mcp", "claude_code"],
      [".cursor/mcp.json", "mcp", "cursor"],
      [".codex/config.toml", "mcp", "codex"],
      ["~/.claude.json", "mcp", "claude_code"],
      ["~/.cursor/mcp.json", "mcp", "cursor"],
      ["~/.copilot/copilot-instructions.md", "instructions", "copilot"],
      ["~/.gemini/GEMINI.md", "gemini_md", "gemini"],
      ["~/.gemini/settings.json", "mcp", "gemini"],
    ]);
  });

  it("knows which file hides which: CLAUDE.md above AGENTS.md, AGENTS.override.md, OpenCode", () => {
    const { home, repo } = fixture();
    repo.write("AGENTS.md", "root\n");
    repo.write("web/CLAUDE.md", "web\n");
    repo.write("web/AGENTS.md", "web agents\n");
    repo.write("api/AGENTS.md", "api agents\n");
    repo.write("api/AGENTS.override.md", "api override\n");
    home.write(".codex/AGENTS.md", "shadowed\n");
    home.write(".codex/AGENTS.override.md", "wins\n");
    home.write(".claude/CLAUDE.md", "global\n");

    const files = findContextFiles({ home: home.home, cwd: repo.home, platform: "linux" });
    const readers = Object.fromEntries(
      shorten(files, repo, home).map((file) => [file.path, file.readers.join(",")]),
    );
    expect(readers).toEqual({
      // No CLAUDE.md at the root or above: Claude Code reads the root AGENTS.md.
      "AGENTS.md": "claude_code,codex,cursor,copilot,opencode,goose",
      "api/AGENTS.md": "claude_code,cursor,copilot,opencode,goose",
      "api/AGENTS.override.md": "codex",
      // OpenCode reads AGENTS.md instead of a CLAUDE.md next to it.
      "web/CLAUDE.md": "claude_code",
      "web/AGENTS.md": "codex,cursor,copilot,opencode,goose",
      // No ~/.config/opencode/AGENTS.md, so OpenCode falls back to Claude Code's global file.
      "~/.claude/CLAUDE.md": "claude_code,opencode",
      "~/.codex/AGENTS.md": "",
      "~/.codex/AGENTS.override.md": "codex",
    });

    const off = findContextFiles({
      home: home.home,
      cwd: repo.home,
      platform: "linux",
      env: { OPENCODE_DISABLE_CLAUDE_CODE: "1" },
    });
    expect(off.find((file) => file.path.endsWith(".claude/CLAUDE.md"))?.readers).toEqual([
      "claude_code",
    ]);
  });
});
