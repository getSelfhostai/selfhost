import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContextCompileReport } from "../src/context/commands.js";
import { run, tempDir } from "./run.js";

const FIXTURE = join(import.meta.dirname, "..", "..", "..", "fixtures", "context", "repo");

function repo() {
  const dir = tempDir("context");
  cpSync(FIXTURE, dir.root, { recursive: true });
  mkdirSync(dir.path(".git"));
  return dir;
}

const report = (out: string) => JSON.parse(out) as ContextCompileReport;

describe("selfhost context compile", () => {
  it("writes every agent's files into the repository and prints the coverage", async () => {
    const dir = repo();
    const result = await run(["context", "compile"], { cwd: dir.root });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(
      /item\s+claude_code\s+codex\s+cursor\s+copilot\s+gemini\s+opencode\s+goose/,
    );
    expect(result.out).toMatch(
      /skill:db-migrate@0\.3\.0\s+compiled\s+partial\s+partial\s+partial\s+partial\s+partial\s+partial/,
    );
    expect(result.out).toMatch(
      /command:fix-issue\s+compiled\s+none\s+partial\s+partial\s+compiled\s+compiled\s+none/,
    );
    expect(result.out).toMatch(
      /rule:codex-sandbox\s+n\/a\s+compiled\s+n\/a\*\s+n\/a\*\s+n\/a\s+n\/a\*\s+n\/a\*/,
    );
    expect(result.out).toContain("Gaps:");
    expect(result.out).toContain(
      "  codex command:fix-issue: Codex reads custom prompts only from ~/.codex/prompts",
    );
    expect(result.out).toContain("Read by agents they are not for:");
    for (const file of [
      "CLAUDE.md",
      "AGENTS.md",
      "GEMINI.md",
      ".goosehints",
      ".github/copilot-instructions.md",
      ".claude/skills/release-notes/SKILL.md",
      ".cursor/rules/api.mdc",
      ".cursor/mcp.json",
      ".mcp.json",
      ".codex/config.toml",
      ".gemini/settings.json",
      "opencode.json",
      ".selfhost/context.lock.json",
    ]) {
      expect([file, existsSync(dir.path(file))]).toEqual([file, true]);
    }
    expect(readFileSync(dir.path("CLAUDE.md"), "utf8")).toMatch(/^<!-- Compiled by selfhost from /);
  });

  it("check passes after a compile and fails with the fix once a generated file is edited", async () => {
    const dir = repo();
    await run(["context", "compile"], { cwd: dir.root });
    const clean = await run(["context", "check"], { cwd: dir.root });
    expect(clean.code).toBe(0);
    expect(clean.out).toContain(
      ".selfhost/context compiles to the files in . for Claude Code, Codex",
    );

    const path = dir.path(".claude/skills/release-notes/SKILL.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}Extra step.\n`);
    const edited = await run(["context", "check"], { cwd: dir.root });
    expect(edited.code).toBe(1);
    expect(edited.out).toContain(
      ".claude/skills/release-notes/SKILL.md was edited by hand. Make the change in .selfhost/context/skills/release-notes/SKILL.md instead, then run selfhost context compile.",
    );
    const json = report((await run(["context", "check", "--json"], { cwd: dir.root })).out);
    expect([json.ok, json.check, json.drift.map((drift) => drift.problem)]).toEqual([
      false,
      true,
      ["edited"],
    ]);
  });

  it("fails on an invalid source with file and line, and writes nothing", async () => {
    const dir = repo();
    dir.write(".selfhost/context/rules/bad.md", "---\nglobs: src/**\n---\n\nText.\n");
    const result = await run(["context", "compile"], { cwd: dir.root });
    expect(result.code).toBe(1);
    expect(result.out).toContain(".selfhost/context/rules/bad.md:2: globs: Expected array");
    expect(existsSync(dir.path("AGENTS.md"))).toBe(false);
    expect((await run(["context", "check"], { cwd: dir.root })).code).toBe(1);
  });

  it("refuses to replace a hand-written rules file without --force", async () => {
    const dir = repo();
    dir.write("AGENTS.md", "# Ours\n");
    const refused = await run(["context", "compile"], { cwd: dir.root });
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("Nothing was written: 1 file would be replaced");
    expect(readFileSync(dir.path("AGENTS.md"), "utf8")).toBe("# Ours\n");
    expect(existsSync(dir.path("CLAUDE.md"))).toBe(false);
    expect((await run(["context", "compile", "--force"], { cwd: dir.root })).code).toBe(0);
    expect(readFileSync(dir.path("AGENTS.md"), "utf8")).toContain("Compiled by selfhost");
  });

  it("compiles for the agents asked for, keeps them, and previews into --out", async () => {
    const dir = repo();
    const first = report(
      (
        await run(["context", "compile", "--agent", "claude", "gemini-cli", "--json"], {
          cwd: dir.root,
        })
      ).out,
    );
    expect(first.agents).toEqual(["claude_code", "gemini"]);
    expect(existsSync(dir.path("GEMINI.md"))).toBe(true);
    expect(existsSync(dir.path("AGENTS.md"))).toBe(false);
    const again = report((await run(["context", "check", "--json"], { cwd: dir.root })).out);
    expect([again.ok, again.agents]).toEqual([true, ["claude_code", "gemini"]]);

    const out = dir.path("preview");
    const preview = await run(["context", "compile", "--agent", "codex", "--out", out], {
      cwd: dir.root,
    });
    expect(preview.code).toBe(0);
    expect(existsSync(join(out, "AGENTS.md"))).toBe(true);
    expect(existsSync(dir.path("AGENTS.md"))).toBe(false);
  });

  it("rejects an unknown agent", async () => {
    const dir = repo();
    const result = await run(["context", "compile", "--agent", "vim", "--json"], { cwd: dir.root });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).error).toContain("--agent: expected claude, codex");
  });
});
