import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findContextFiles } from "../src/index.js";
import { fixtureHome } from "./helpers.js";

describe("findContextFiles", () => {
  it("lists CLAUDE.md, AGENTS.md, skills and rules in the repo and the home config", () => {
    const home = fixtureHome("ctx-home");
    const repo = fixtureHome("ctx-repo");
    mkdirSync(repo.path(".git"));
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
    const short = files.map((file) => ({
      path: file.path.startsWith(repo.home)
        ? file.path.slice(repo.home.length + 1)
        : `~/${file.path.slice(home.home.length + 1)}`,
      kind: file.kind,
      scope: file.scope,
      agent: file.agent,
    }));
    expect(short).toEqual([
      { path: "CLAUDE.md", kind: "claude_md", scope: "repo", agent: "claude_code" },
      { path: "AGENTS.md", kind: "agents_md", scope: "repo", agent: "shared" },
      { path: "packages/api/AGENTS.md", kind: "agents_md", scope: "repo", agent: "shared" },
      {
        path: ".claude/skills/release/SKILL.md",
        kind: "skill",
        scope: "repo",
        agent: "claude_code",
      },
      {
        path: ".claude/commands/ship/fast.md",
        kind: "command",
        scope: "repo",
        agent: "claude_code",
      },
      { path: ".cursor/rules/style.mdc", kind: "rule", scope: "repo", agent: "cursor" },
      { path: ".goosehints", kind: "hints", scope: "repo", agent: "goose" },
      { path: "~/.claude/CLAUDE.md", kind: "claude_md", scope: "home", agent: "claude_code" },
      {
        path: "~/.claude/skills/review/SKILL.md",
        kind: "skill",
        scope: "home",
        agent: "claude_code",
      },
      { path: "~/.codex/AGENTS.md", kind: "agents_md", scope: "home", agent: "codex" },
      { path: "~/.config/opencode/AGENTS.md", kind: "agents_md", scope: "home", agent: "opencode" },
    ]);
    expect(files[0]?.size).toBe(8);
  });

  it("lists only home files without a cwd", () => {
    const home = fixtureHome("ctx-only");
    home.write(".claude/agents/reviewer.md", "agent\n");
    expect(findContextFiles({ home: home.home }).map((file) => file.kind)).toEqual(["subagent"]);
  });
});
