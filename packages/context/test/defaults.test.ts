import { describe, expect, it } from "vitest";
import { buildContext, contradictions } from "../src/index.js";
import type { ContextRule } from "../src/types.js";
import { temp } from "./helpers.js";

const rule = (path: string, body: string): ContextRule => ({
  kind: "rule",
  name: path,
  path,
  agents: [],
  globs: [],
  body,
});

describe("the agents of a first compile", () => {
  it("are the ones found on the machine and the ones an item names, not all seven", async () => {
    const repo = temp();
    repo.write(".selfhost/context/rules/style.md", "Keep functions short.\n");
    repo.write(
      ".selfhost/context/rules/gemini-only.md",
      "---\nagents: [gemini]\n---\nGemini reads this.\n",
    );
    const built = await buildContext(repo.root, { detected: ["claude_code"] });
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    expect(built.result.agents).toEqual(["claude_code", "gemini"]);
    const paths = built.plan.files.map((file) => file.path);
    expect(paths).toContain("CLAUDE.md");
    expect(paths.some((path) => path.startsWith(".cursor"))).toBe(false);
    expect(paths).not.toContain("opencode.json");
  });

  it("are every agent, with a warning, when none is found and no item names one", async () => {
    const repo = temp();
    repo.write(".selfhost/context/rules/style.md", "Keep functions short.\n");
    const built = await buildContext(repo.root, { detected: [] });
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    expect(built.result.agents).toHaveLength(7);
    expect(built.warnings).toContain(
      "No agent was found on this machine and no item names one, so the files are written for every agent. Pass --agent to choose.",
    );
  });
});

describe("contradictions", () => {
  it("notes rules that pick different package managers, without failing the compile", async () => {
    expect(
      contradictions({
        rules: [
          rule(".selfhost/context/rules/node.md", "Use npm for scripts."),
          rule("team:web/rules/tooling.md", "Always use pnpm. Indent with 2 spaces."),
          rule(".selfhost/context/rules/misc.md", "npm and pnpm both appear in docs."),
        ],
      }),
    ).toEqual([
      "Rules disagree on the package manager: npm (.selfhost/context/rules/node.md) against pnpm (team:web/rules/tooling.md). Agents get every one of them; keep one, or narrow each with globs.",
    ]);
    const repo = temp();
    repo.write(".selfhost/context/rules/a.md", "Use npm.\n");
    repo.write(".selfhost/context/rules/b.md", "Use pnpm.\n");
    const built = await buildContext(repo.root, { agents: ["claude_code"] });
    expect(built.ok).toBe(true);
    if (built.ok)
      expect(built.warnings.join("\n")).toMatch(/Rules disagree on the package manager/);
  });
});
