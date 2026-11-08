import { mkdirSync } from "node:fs";
import { findPricing } from "@selfhost/importers";
import { describe, expect, it } from "vitest";
import { o200kCounter, sessionRate } from "../src/scan/context/cost.js";
import {
  type ContextConflict,
  findConflicts,
  findDuplicates,
  polarity,
} from "../src/scan/context/drift.js";
import { readContext } from "../src/scan/context/files.js";
import type { ContextSection } from "../src/scan/context/index.js";
import { readLocalEvents, type ScanReport } from "../src/scan/index.js";
import { summarizeSessions } from "../src/scan/sessions.js";
import { contextLaptop } from "./context-fixture.js";
import { run, tempDir } from "./run.js";

const NOW = new Date("2026-10-31T00:00:00Z");
const SINCE = new Date("2026-10-01T00:00:00Z");
const WEEKS = (NOW.getTime() - SINCE.getTime()) / (7 * 24 * 3_600_000);

async function scanFixture(args: string[] = []) {
  const { home, repo, env } = contextLaptop();
  const deps = {
    cwd: repo.root,
    home: home.root,
    env,
    now: NOW,
    collectAttribution: async () => undefined,
  };
  const json = await run(["scan", "--json", "--since", "2026-10-01", ...args], deps);
  expect(json.err).toBe("");
  const report = JSON.parse(json.out) as ScanReport;
  return { home, repo, env, deps, report, context: report.context };
}

const file = (context: ContextSection, path: string) => {
  const found = context.files.find((entry) => entry.path === path);
  if (!found) throw new Error(`${path} not in the scan`);
  return found;
};

const conflict = (context: ContextSection, topic: ContextConflict["topic"]) =>
  context.conflicts.find((entry) => entry.topic === topic);

/** A repository with these files, read the way the scan reads it. */
function docsFor(files: Record<string, string>) {
  const home = tempDir("drift-home");
  const repo = tempDir("drift-repo");
  mkdirSync(repo.path(".git"));
  for (const [path, content] of Object.entries(files)) repo.write(path, content);
  return readContext({ home: home.root, cwd: repo.root, platform: "linux" });
}

describe("context files in selfhost scan", () => {
  it("lists every file in the repo and the home folder with the agents that read it", async () => {
    const { context } = await scanFixture();
    const rows = Object.fromEntries(
      context.files.map((entry) => [entry.path, [entry.kind, entry.load, entry.readers.join(",")]]),
    );
    expect(rows).toEqual({
      "CLAUDE.md": ["claude_md", "always", "claude_code,cursor,copilot"],
      "CLAUDE.local.md": ["claude_local_md", "always", "claude_code"],
      "AGENTS.md": ["agents_md", "always", "codex,cursor,copilot,opencode,goose"],
      "GEMINI.md": ["gemini_md", "always", "gemini,copilot"],
      "packages/web/AGENTS.md": ["agents_md", "on_demand", "codex,cursor,copilot,opencode,goose"],
      ".claude/skills/release/SKILL.md": ["skill", "description", "claude_code,opencode"],
      ".claude/agents/reviewer.md": ["subagent", "description", "claude_code"],
      ".claude/commands/ship.md": ["command", "description", "claude_code"],
      ".cursor/rules/components.mdc": ["rule", "on_demand", "cursor"],
      ".cursor/rules/style.mdc": ["rule", "always", "cursor"],
      ".github/copilot-instructions.md": ["instructions", "always", "copilot"],
      ".mcp.json": ["mcp", "always", "claude_code"],
      ".cursor/mcp.json": ["mcp", "always", "cursor"],
      "~/.claude/CLAUDE.md": ["claude_md", "always", "claude_code,opencode"],
      "~/.claude/skills/review/SKILL.md": ["skill", "description", "claude_code,opencode"],
      "~/.codex/AGENTS.md": ["agents_md", "always", "codex"],
      "~/.codex/skills/review/SKILL.md": ["skill", "description", "codex"],
    });
    expect(file(context, ".cursor/mcp.json").mcp_servers).toEqual(["docs", "search"]);
    // A skill puts only its name and description in every session.
    const skill = file(context, ".claude/skills/release/SKILL.md");
    expect(skill.always_tokens).toBeGreaterThan(0);
    expect(skill.always_tokens).toBeLessThan(skill.tokens);
    expect(file(context, "packages/web/AGENTS.md").always_tokens).toBe(0);
  });

  it("flags exact and near copies, and who loads both", async () => {
    const { context } = await scanFixture();
    expect(context.duplicates).toEqual([
      {
        match: "exact",
        files: ["GEMINI.md", ".github/copilot-instructions.md"],
        shared_lines: 4,
        overlap: 1,
        loaded_twice_by: ["copilot"],
      },
      {
        match: "exact",
        files: ["~/.claude/skills/review/SKILL.md", "~/.codex/skills/review/SKILL.md"],
        shared_lines: 1,
        overlap: 1,
        loaded_twice_by: [],
      },
      {
        match: "near",
        files: ["CLAUDE.md", "AGENTS.md"],
        shared_lines: 14,
        overlap: 14 / 17,
        loaded_twice_by: ["cursor", "copilot"],
      },
    ]);
  });

  it("flags the pnpm and npm conflict with the file and line of each side", async () => {
    const { context } = await scanFixture();
    const packages = conflict(context, "js_package_manager");
    expect(packages?.sides).toEqual([
      { path: "CLAUDE.md", line: 3, stance: "avoids", value: "npm", match: "npm" },
      { path: "CLAUDE.md", line: 3, stance: "uses", value: "pnpm", match: "pnpm" },
      { path: "AGENTS.md", line: 5, stance: "uses", value: "npm", match: "npm install" },
      { path: "packages/web/AGENTS.md", line: 3, stance: "uses", value: "pnpm", match: "pnpm" },
      {
        path: ".claude/skills/release/SKILL.md",
        line: 7,
        stance: "uses",
        value: "pnpm",
        match: "pnpm",
      },
    ]);
    expect(packages?.detail).toBe(
      "not npm in CLAUDE.md:3; pnpm in CLAUDE.md:3, packages/web/AGENTS.md:3, .claude/skills/release/SKILL.md:7; npm in AGENTS.md:5",
    );
    expect(packages?.rule).toBe(
      "two files name package managers with none in common (npm, pnpm); a file says not to use one that another file uses",
    );
    expect(packages?.same_agent).toEqual(["codex", "cursor", "copilot", "opencode", "goose"]);

    expect(conflict(context, "node_version")?.detail).toBe(
      ">=22 in CLAUDE.md:10; 20 in AGENTS.md:7",
    );
    expect(conflict(context, "js_test_runner")?.detail).toBe(
      "vitest in CLAUDE.md:8, AGENTS.md:6; jest in packages/web/AGENTS.md:3",
    );
    expect(conflict(context, "js_formatter")?.same_agent).toEqual(["cursor"]);
    expect(conflict(context, "mcp_server")).toMatchObject({
      title: "MCP server docs",
      detail: ".mcp.json, .cursor/mcp.json start it with different args, env",
    });
    expect(context.conflicts.map((entry) => entry.topic)).toEqual([
      "js_package_manager",
      "js_test_runner",
      "js_formatter",
      "node_version",
      "mcp_server",
    ]);
  });

  it("flags rules and MCP servers only one agent sees", async () => {
    const { context } = await scanFixture();
    expect(context.agents_in_use).toEqual(["claude_code", "codex", "cursor", "copilot", "gemini"]);
    expect(context.single_agent).toContainEqual({
      path: ".cursor/rules/components.mdc",
      kind: "rule",
      reader: "cursor",
      server: null,
    });
    expect(context.single_agent).toContainEqual({
      path: ".cursor/mcp.json",
      kind: "mcp",
      reader: "cursor",
      server: "search",
    });
    // Copilot reads GEMINI.md, an exact copy, so the Copilot-only file is not flagged.
    expect(context.single_agent.map((rule) => rule.path)).not.toContain(
      ".github/copilot-instructions.md",
    );
  });

  it("prices always-loaded context per file from the sessions in the local logs", async () => {
    const { context, env } = await scanFixture();
    const sessions = summarizeSessions(
      await readLocalEvents({
        since: SINCE,
        claudeDir: env.CLAUDE_CONFIG_DIR,
        codexDir: env.CODEX_HOME,
      }),
    );
    const claude = sessions.filter((session) => session.vendor === "claude_code");
    const codex = sessions.filter((session) => session.vendor === "codex");
    expect([claude.length, codex.length]).toEqual([3, 3]);

    const claudeMd = file(context, "CLAUDE.md");
    expect(claudeMd.sessions_per_week).toBeCloseTo(3 / WEEKS, 10);
    expect(claudeMd.tokens_per_week).toBeCloseTo(claudeMd.always_tokens * (3 / WEEKS), 10);
    // A cache write once per session, then a cache read on each later main or subagent request.
    const rate = (list: typeof sessions) =>
      list.reduce((total, session) => {
        const pricing = findPricing(session.model ?? "");
        const work = session.costs.filter((cost) =>
          ["main", "subagent"].includes(cost.requestType),
        ).length;
        const later = Math.max(work - 1, 0);
        return total + (pricing ? pricing.cacheCreate + pricing.cacheRead * later : 0);
      }, 0);
    expect(claudeMd.usd_per_week).toBeCloseTo((claudeMd.always_tokens * rate(claude)) / WEEKS, 12);
    expect(claudeMd.usd_per_week).toBeGreaterThan(0);
    const agentsMd = file(context, "AGENTS.md");
    expect(agentsMd.usd_per_week).toBeCloseTo((agentsMd.always_tokens * rate(codex)) / WEEKS, 12);
    expect(claude.every((session) => sessionRate(session) !== undefined)).toBe(true);

    // Copilot and Cursor keep no logs selfhost reads: their files load but cost nothing here.
    expect(file(context, ".github/copilot-instructions.md").sessions_per_week).toBe(0);
    expect(context.unpriced_agents).toEqual(["cursor", "copilot", "gemini", "opencode", "goose"]);
    const total = context.files.reduce((sum, entry) => sum + entry.usd_per_week, 0);
    expect(context.totals.usd_per_week).toBeCloseTo(total, 12);
    expect(context.totals.always_loaded).toBe(
      context.files.filter((entry) => entry.always_tokens > 0).length,
    );
  });

  it("counts tokens with o200k_base", async () => {
    const count = await o200kCounter();
    expect(count("Use pnpm, not npm. Run `pnpm test` before committing.\n")).toBe(16);
    // Special token text in a file is counted as text, not refused.
    expect(count("a <|endoftext|> b")).toBeGreaterThan(3);
    expect(count("")).toBe(0);
  });

  it("prints the context section in the text, HTML and SVG reports", async () => {
    const { deps, repo } = await scanFixture();
    const text = await run(
      ["scan", "--since", "2026-10-01", "--report", "r.html", "--share", "c.svg"],
      deps,
    );
    expect(text.out).toMatch(
      /^Context: 17 files, 13 in every session, \$\S+ a week, 5 conflicts, 3 duplicates$/m,
    );
    expect(text.out).toMatch(/^ {2}PATH +LOAD +TOKENS\/SESSION +SESSIONS\/WK +USD\/WK +READ BY$/m);
    expect(text.out).toMatch(
      /^ {2}CLAUDE\.md +always +\d+ +0\.7 +\$\S+ +Claude Code, Cursor, Copilot$/m,
    );
    expect(text.out).toContain(
      "    Package manager: not npm in CLAUDE.md:3; pnpm in CLAUDE.md:3, packages/web/AGENTS.md:3, .claude/skills/release/SKILL.md:7; npm in AGENTS.md:5. Codex, Cursor, Copilot, OpenCode and Goose get both.",
    );
    expect(text.out).toContain("    .cursor/rules/components.mdc: Cursor only");
    expect(text.out).toContain(
      "    GEMINI.md and .github/copilot-instructions.md: exact copies; Copilot loads both",
    );
    expect(text.out).toContain("Tokens: o200k_base (gpt-tokenizer)");
    // Only the matched words, never a whole line of a context file.
    expect(text.out).not.toContain("Use pnpm for everything");

    const { readFileSync } = await import("node:fs");
    const html = readFileSync(repo.path("r.html"), "utf8");
    expect(html).toContain("<h2>Context files</h2>");
    expect(html).toContain("Package manager");
    expect(html).toContain("<tr><td><code>CLAUDE.md</code></td><td>always</td>");
    expect(html).toContain("And 5 more; selfhost scan --json lists them all.");
    const svg = readFileSync(repo.path("c.svg"), "utf8");
    expect(svg).toMatch(
      /Always-loaded context \$\S+ a week {2}· {2}5 conflicts {2}· {2}3 duplicates across 17 context files/,
    );
  });

  it("says so when there are no context files", async () => {
    const repo = tempDir("ctx-empty");
    mkdirSync(repo.path(".git"));
    const { out } = await run(["scan", "--since", "2026-10-01"], {
      cwd: repo.root,
      now: NOW,
      collectAttribution: async () => undefined,
    });
    expect(out).toContain(
      "Context: no CLAUDE.md, AGENTS.md, rules, skills or MCP configs found in the repository or the home folder.",
    );
  });
});

describe("conflict rules", () => {
  it("reads never, don't, not and instead of as avoid", () => {
    const avoid = (line: string, word: string) =>
      polarity(line, line.search(new RegExp(`\\b${word}\\b`)));
    expect(avoid("Never use npm.", "npm")).toBe("avoid");
    expect(avoid("Use pnpm, not npm.", "npm")).toBe("avoid");
    expect(avoid("Use pnpm, not npm.", "pnpm")).toBe("use");
    expect(avoid("We use pnpm instead of `npm`.", "npm")).toBe("avoid");
    expect(avoid("Don't use npm; run pnpm install.", "pnpm")).toBe("use");
    expect(avoid("Never commit without running pnpm test.", "pnpm")).toBe("use");
    expect(avoid("We migrated from jest to vitest.", "jest")).toBe("avoid");
  });

  it("does not count global installs, npx or the npm registry as using npm", () => {
    const docs = docsFor({
      "CLAUDE.md":
        "Use pnpm. Install the CLI with `npm install -g acme`.\nRun `npx acme check`.\nPublish to npm with `pnpm publish`.\n",
      "AGENTS.md": "Run `pnpm test`.\n",
    });
    expect(findConflicts(docs)).toEqual([]);
  });

  it("finds Python package manager and version conflicts and leaves ranges that agree", () => {
    const docs = docsFor({
      "CLAUDE.md": "Install with `uv sync`. Python 3.12.\nNode 20 or later.\n",
      "AGENTS.md": "Install with `pip install -r requirements.txt`. Python 3.11.\nNode 22.\n",
    });
    expect(findConflicts(docs).map((entry) => [entry.topic, entry.detail])).toEqual([
      ["python_package_manager", "uv in CLAUDE.md:1; pip in AGENTS.md:1"],
      ["python_version", "3.12 in CLAUDE.md:1; 3.11 in AGENTS.md:1"],
    ]);
  });

  it("finds a practice one file forbids and another asks for", () => {
    const docs = docsFor({
      "CLAUDE.md": "Never force push.\n",
      ".github/copilot-instructions.md": "After a rebase, run `git push --force`.\n",
    });
    expect(findConflicts(docs)).toEqual([
      {
        topic: "do_dont",
        title: "Do and don't: force push",
        detail: "don't in CLAUDE.md:1; do in .github/copilot-instructions.md:1",
        rule: "one file says not to (never, don't, avoid, not) and another says to, or does it",
        sides: [
          {
            path: "CLAUDE.md",
            line: 1,
            stance: "avoids",
            value: "force push",
            match: "force push",
          },
          {
            path: ".github/copilot-instructions.md",
            line: 1,
            stance: "uses",
            value: "force push",
            match: "git push --force",
          },
        ],
        same_agent: ["copilot"],
      },
    ]);
  });

  it("needs most lines in common for a near copy", () => {
    const shared = "- one rule here\n- two rule here\n- three rule here\n- four rule here\n";
    const docs = docsFor({
      "CLAUDE.md": `${shared}- only in claude\n`,
      "AGENTS.md": `${shared}- only in agents\n- also only in agents\n`,
      "GEMINI.md": "- one rule here\n- something else\n- and another\n",
    });
    expect(findDuplicates(docs)).toEqual([
      {
        match: "near",
        files: ["CLAUDE.md", "AGENTS.md"],
        shared_lines: 4,
        overlap: 0.8,
        loaded_twice_by: ["cursor", "copilot"],
      },
    ]);
  });
});
