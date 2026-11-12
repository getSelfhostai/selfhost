import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyContextPlan, type BuildOptions, buildContext, LOCK_PATH } from "../src/index.js";
import { type Temp, temp } from "./helpers.js";

async function build(dir: Temp, options: BuildOptions = {}) {
  const built = await buildContext(dir.root, options);
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return built;
}

/** Compiles into the folder and returns the next plan, which a clean tree leaves empty. */
async function compiled(dir: Temp, options: BuildOptions = {}) {
  const first = await build(dir, options);
  expect(first.plan.conflicts).toEqual([]);
  applyContextPlan(dir.root, first.plan);
  return first;
}

const problems = async (dir: Temp) =>
  (await build(dir)).plan.drift.map((drift) => [drift.path, drift.problem]);

describe("planContext and check", () => {
  it("leaves nothing to do right after a compile", async () => {
    const dir = temp(true);
    await compiled(dir);
    const again = await build(dir);
    expect(again.plan.drift).toEqual([]);
    expect(again.plan.files.every((file) => file.action === "unchanged")).toBe(true);
    expect(JSON.parse(readFileSync(dir.path(LOCK_PATH), "utf8")).agents).toHaveLength(7);
  });

  it("tells a hand edit from a source change, and says how to fix each", async () => {
    const dir = temp(true);
    await compiled(dir);
    writeFileSync(dir.path("AGENTS.md"), `${readFileSync(dir.path("AGENTS.md"), "utf8")}\nMore.\n`);
    const edited = (await build(dir)).plan.drift;
    expect(edited).toEqual([
      {
        path: "AGENTS.md",
        problem: "edited",
        message:
          "AGENTS.md was edited by hand. Make the change in .ruler and .selfhost/context/rules instead, then run selfhost context compile.",
      },
    ]);

    const other = temp(true);
    await compiled(other);
    other.write(".selfhost/context/rules/style.md", "Use tabs.\n");
    expect(await problems(other)).toEqual(
      expect.arrayContaining([
        ["AGENTS.md", "outdated"],
        ["CLAUDE.md", "outdated"],
        [LOCK_PATH, "edited"],
      ]),
    );
  });

  it("reports missing files, and removes files the source no longer compiles to", async () => {
    const dir = temp(true);
    await compiled(dir);
    rmSync(dir.path(".cursor/mcp.json"));
    expect(await problems(dir)).toEqual([[".cursor/mcp.json", "missing"]]);

    rmSync(dir.path(".selfhost/context/skills/release-notes"), { recursive: true });
    const plan = (await build(dir)).plan;
    expect(plan.drift).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".claude/skills/release-notes/scripts/collect.sh",
          problem: "stale",
        }),
      ]),
    );
    applyContextPlan(dir.root, plan);
    expect(existsSync(dir.path(".claude/skills/release-notes"))).toBe(false);
    expect(existsSync(dir.path(".claude/skills/db-migrate/SKILL.md"))).toBe(true);
    expect((await build(dir)).plan.drift).toEqual([]);
  });

  it("refuses to replace files it did not write, unless forced", async () => {
    const dir = temp(true);
    dir.write("CLAUDE.md", "# Ours\n");
    dir.write(".cursor/mcp.json", '{ "mcpServers": {} }\n');
    const plan = (await build(dir)).plan;
    expect(plan.conflicts.map((conflict) => conflict.path)).toEqual([
      ".cursor/mcp.json",
      "CLAUDE.md",
    ]);
    expect(plan.conflicts[1]?.message).toBe(
      "CLAUDE.md exists and selfhost did not write it. Move what it holds into .selfhost/context, or run again with --force to replace it.",
    );
    expect(() => applyContextPlan(dir.root, plan)).toThrow(/conflicts/);
    expect((await build(dir, { force: true })).plan.conflicts).toEqual([]);
  });

  it("keeps other settings in shared JSON and TOML files", async () => {
    const dir = temp(true);
    dir.write(
      "opencode.json",
      '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "a/b"\n}\n',
    );
    dir.write(".codex/config.toml", '# mine\nmodel = "o4"\n');
    await compiled(dir);
    const opencode = JSON.parse(readFileSync(dir.path("opencode.json"), "utf8"));
    expect(opencode.model).toBe("a/b");
    expect(Object.keys(opencode.mcp)).toEqual(["docs", "github"]);
    const codex = readFileSync(dir.path(".codex/config.toml"), "utf8");
    expect(codex.startsWith('# mine\nmodel = "o4"\n\n# >>> selfhost context >>>\n')).toBe(true);
    expect((await build(dir)).plan.drift).toEqual([]);

    // An edit to selfhost's key is drift; the person's own keys are not.
    opencode.model = "c/d";
    writeFileSync(dir.path("opencode.json"), JSON.stringify(opencode));
    expect(await problems(dir)).toEqual([]);
    opencode.mcp.docs.enabled = false;
    writeFileSync(dir.path("opencode.json"), JSON.stringify(opencode));
    expect(await problems(dir)).toEqual([["opencode.json", "edited"]]);
  });

  it("will not hide a server defined outside its TOML block", async () => {
    const dir = temp(true);
    dir.write(".codex/config.toml", '[mcp_servers.docs]\ncommand = "old"\n');
    const plan = (await build(dir, { force: true })).plan;
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ path: ".codex/config.toml", forceable: false }),
    ]);
  });

  it("keeps the agents of the last compile, and records each agent's skill version", async () => {
    const dir = temp(true);
    await compiled(dir, { agents: ["claude_code", "goose"] });
    const again = await build(dir);
    expect(again.result.agents).toEqual(["claude_code", "goose"]);
    const lock = JSON.parse(readFileSync(dir.path(LOCK_PATH), "utf8"));
    expect(lock.skills["release-notes"].agents).toEqual({
      claude_code: {
        status: "compiled",
        version: "1.2.0",
        files: [
          ".claude/skills/release-notes/SKILL.md",
          ".claude/skills/release-notes/references/template.md",
          ".claude/skills/release-notes/scripts/collect.sh",
        ],
      },
      goose: expect.objectContaining({ status: "compiled", version: "1.2.0" }),
    });
  });

  it("never removes the files of agents a narrower compile leaves out", async () => {
    const dir = temp(true);
    await compiled(dir);
    const claude = readFileSync(dir.path("CLAUDE.md"), "utf8");
    const narrow = await compiled(dir, { agents: ["opencode", "goose"] });
    expect(narrow.plan.files.filter((file) => file.action === "delete")).toEqual([]);
    expect(readFileSync(dir.path("CLAUDE.md"), "utf8")).toBe(claude);
    expect(existsSync(dir.path(".cursor/mcp.json"))).toBe(true);
    // The lock still owns them, so a check passes and a later compile for Claude Code updates them.
    const lock = JSON.parse(readFileSync(dir.path(LOCK_PATH), "utf8"));
    expect(lock.agents).toEqual(["opencode", "goose"]);
    expect(lock.files["CLAUDE.md"]).toBeDefined();
    expect((await build(dir)).plan.drift).toEqual([]);
    const back = await build(dir, { agents: ["claude_code"] });
    expect(back.plan.conflicts).toEqual([]);
  });

  it("will not delete a file it no longer compiles when someone changed it, unless forced", async () => {
    const dir = temp(true);
    await compiled(dir);
    rmSync(dir.path(".selfhost/context/skills/release-notes"), { recursive: true });
    const script = ".claude/skills/release-notes/scripts/collect.sh";
    writeFileSync(dir.path(script), "#!/bin/sh\necho mine\n");
    const plan = (await build(dir)).plan;
    expect(plan.conflicts).toEqual([expect.objectContaining({ path: script, forceable: true })]);
    expect(plan.conflicts[0]?.message).toContain("it was edited by hand");
    expect(() => applyContextPlan(dir.root, plan)).toThrow(/conflicts/);
    expect(readFileSync(dir.path(script), "utf8")).toBe("#!/bin/sh\necho mine\n");
    applyContextPlan(dir.root, (await build(dir, { force: true })).plan);
    expect(existsSync(dir.path(script))).toBe(false);
  });

  it("takes its key or block out of a shared file the source no longer needs", async () => {
    const dir = temp(true);
    await compiled(dir);
    rmSync(dir.path(".selfhost/context/mcp.json"));
    const plan = (await build(dir)).plan;
    expect(plan.conflicts).toEqual([]);
    expect(plan.files.find((file) => file.path === "opencode.json")?.action).toBe("delete");
    applyContextPlan(dir.root, plan);
    expect(existsSync(dir.path("opencode.json"))).toBe(false);
  });

  it("never deletes or overwrites an adopted file that changed, without --force", async () => {
    const dir = temp(true);
    await compiled(dir);
    const lock = JSON.parse(readFileSync(dir.path(LOCK_PATH), "utf8"));
    const original = "# Hand written\n";
    writeFileSync(dir.path("CLAUDE.md"), original);
    lock.files["CLAUDE.md"] = { ...lock.files["CLAUDE.md"], adopted: true, sha256: "0".repeat(64) };
    // A file the source no longer compiles to, taken over as it is.
    dir.write(".claude/rules/old.md", original);
    lock.files[".claude/rules/old.md"] = {
      sources: [".selfhost/context/rules/old.md"],
      header: "front_matter",
      sha256: createHash("sha256").update(original).digest("hex"),
      adopted: true,
    };
    writeFileSync(dir.path(LOCK_PATH), JSON.stringify(lock));
    const plan = (await build(dir)).plan;
    expect(plan.conflicts.map((conflict) => conflict.path)).toEqual([
      "CLAUDE.md",
      ".claude/rules/old.md",
    ]);
    expect(plan.conflicts[1]?.message).toContain("selfhost init took it over as it was");
    expect(() => applyContextPlan(dir.root, plan)).toThrow(/conflicts/);
    expect(readFileSync(dir.path(".claude/rules/old.md"), "utf8")).toBe(original);
    applyContextPlan(dir.root, (await build(dir, { force: true })).plan);
    expect(existsSync(dir.path(".claude/rules/old.md"))).toBe(false);
  });

  it("warns when a skill changes without a new version", async () => {
    const dir = temp(true);
    await compiled(dir);
    const path = ".selfhost/context/skills/release-notes/SKILL.md";
    const text = readFileSync(dir.path(path), "utf8");
    dir.write(path, `${text}4. Link the milestone.\n`);
    expect((await build(dir)).warnings).toEqual([
      expect.stringContaining("Skill release-notes changed but is still version 1.2.0"),
    ]);
    dir.write(path, text.replace("version: 1.2.0", "version: 1.1.0"));
    expect((await build(dir)).warnings).toEqual([
      "Skill release-notes went from version 1.2.0 down to 1.1.0.",
    ]);
  });
});
