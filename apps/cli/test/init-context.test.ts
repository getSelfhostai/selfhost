import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { contextLaptop } from "./context-fixture.js";
import { run } from "./run.js";

const NOW = new Date("2026-10-31T00:00:00Z");
const PERSON = "dev@example.com";
const onPath = {
  which: (name: string) => (name === "selfhost" ? "/usr/local/bin/selfhost" : undefined),
};

/** Every file under the roots with its hash, skipping what init itself writes. */
function hashes(...roots: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const root of roots) {
    for (const name of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (name.startsWith(".selfhost") || name === "selfhost.toml") continue;
      const path = join(root, name);
      try {
        out[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
      } catch {
        // A folder.
      }
    }
  }
  return out;
}

function laptop() {
  const fixture = contextLaptop();
  const { home, repo } = fixture;
  const init = (args: string[], deps: Record<string, unknown> = {}) =>
    run(["init", "--home", home.root, "--person", PERSON, "--data-dir", "memory://", ...args], {
      cwd: repo.root,
      now: NOW,
      probes: onPath,
      ...deps,
    });
  const source = (...parts: string[]) => repo.path(".selfhost", "context", ...parts);
  return { ...fixture, init, source };
}

/** `${NAME}`, the reference MCP configs use for an environment variable. */
const ref = (name: string) => `\${${name}}`;

const front = (text: string) => parse(text.split("---\n")[1] ?? "") as Record<string, unknown>;

describe("selfhost init: importing the context files", () => {
  it("--dry-run lists what an import would write and writes nothing", async () => {
    const { home, repo, init, source } = laptop();
    const before = hashes(home.root, repo.root);
    const text = await init(["--dry-run"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(
      "Context: 17 context files found. selfhost init --import-context copies 6 rules, 1 skill, 1 command, 1 subagent and mcp.json into .selfhost/context/; the originals stay as they are.",
    );
    expect(text.out).toMatch(
      /^ {2}\.selfhost\/context\/rules\/gemini\.md +from GEMINI\.md, \.github\/copilot-instructions\.md$/m,
    );
    expect(text.out).toContain("  Left out: CLAUDE.local.md (personal, kept out of git)");
    expect(text.out).toContain(
      "  Left out: 4 files in the home folder (personal, they stay there)",
    );

    const json = JSON.parse((await init(["--dry-run", "--json", "--import-context"])).out);
    expect(json.context).toMatchObject({ found: 17, dir: source(), status: "would_import" });
    expect(json.context.files).toHaveLength(11);
    expect(existsSync(source())).toBe(false);
    expect(hashes(home.root, repo.root)).toEqual(before);
  });

  it("--import-context writes the one context source, keeps the originals, and --undo deletes it", async () => {
    const { home, repo, init, source } = laptop();
    const before = hashes(home.root, repo.root);
    const first = await init(["--import-context"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain(
      "Context: imported 6 rules, 1 skill, 1 command, 1 subagent and mcp.json into .selfhost/context/. The originals are unchanged; selfhost init --undo deletes the copies.",
    );
    expect(hashes(home.root, repo.root)).toEqual(before);
    expect(readdirSync(source(), { recursive: true, encoding: "utf8" }).sort()).toEqual([
      "agents",
      "agents/reviewer.md",
      "commands",
      "commands/ship.md",
      "mcp.json",
      "rules",
      "rules/agents.md",
      "rules/claude.md",
      "rules/components.md",
      "rules/gemini.md",
      "rules/packages-web-agents.md",
      "rules/style.md",
      "skills",
      "skills/release",
      "skills/release/SKILL.md",
      "skills/release/scripts",
      "skills/release/scripts/changelog.sh",
    ]);

    // Each rule keeps who reads it today, so compiling it back changes no agent's context.
    const claude = readFileSync(source("rules", "claude.md"), "utf8");
    expect(front(claude)).toEqual({ agents: ["claude_code", "cursor", "copilot"] });
    expect(claude.endsWith(readFileSync(repo.path("CLAUDE.md"), "utf8").replace(/^\n+/, ""))).toBe(
      true,
    );
    // Exact copies become one rule for the readers of both.
    expect(front(readFileSync(source("rules", "gemini.md"), "utf8"))).toEqual({
      agents: ["copilot", "gemini"],
    });
    expect(front(readFileSync(source("rules", "packages-web-agents.md"), "utf8"))).toEqual({
      agents: ["codex", "cursor", "copilot", "opencode", "goose"],
      globs: ["packages/web/**"],
    });
    expect(front(readFileSync(source("rules", "components.md"), "utf8"))).toEqual({
      agents: ["cursor"],
      globs: ["src/components/**/*.tsx"],
      description: "React component conventions",
    });
    expect(front(readFileSync(source("commands", "ship.md"), "utf8"))).toEqual({
      description: "Open a pull request for the current branch",
      "argument-hint": "[title]",
    });
    expect(front(readFileSync(source("agents", "reviewer.md"), "utf8"))).toEqual({
      name: "reviewer",
      description: "Reviews a diff for missing tests and unsafe migrations.",
      tools: "Read, Grep, Glob",
      model: "sonnet",
    });
    expect(front(readFileSync(source("skills", "release", "SKILL.md"), "utf8"))).toEqual({
      name: "release",
      description: "Cut a release of acme-api, tag it and write the changelog.",
      version: "1.2.0",
    });
    expect(readFileSync(source("skills", "release", "scripts", "changelog.sh"))).toEqual(
      readFileSync(repo.path(".claude", "skills", "release", "scripts", "changelog.sh")),
    );
    expect(JSON.parse(readFileSync(source("mcp.json"), "utf8"))).toEqual({
      mcpServers: {
        docs: {
          command: "npx",
          args: ["-y", "@acme/docs-mcp"],
          env: { DOCS_TOKEN: ref("DOCS_TOKEN") },
        },
        search: { url: "https://search.example.com/mcp" },
      },
    });

    // A second run finds everything in place and writes nothing.
    const again = JSON.parse((await init(["--import-context", "--json"])).out);
    expect(again.context.status).toBe("nothing");
    expect(again.context.files.every((file: { action: string }) => file.action === "same")).toBe(
      true,
    );

    const undo = await run(["init", "--home", home.root, "--undo"], { cwd: repo.root });
    expect(undo.out).toContain(
      "Deleted 11 context files selfhost init imported into .selfhost/context/.",
    );
    expect(existsSync(repo.path(".selfhost"))).toBe(false);
    expect(hashes(home.root, repo.root)).toEqual(before);
  });

  it("asks in a terminal, and never with --yes or --json", async () => {
    const questions: string[] = [];
    const yes = laptop();
    const ask = async (question: string) => {
      questions.push(question);
      return true;
    };
    await yes.init([], { ask });
    expect(questions).toEqual([
      "Import 11 files of agent context from this repository into .selfhost/context/? The originals stay as they are. [y/N] ",
    ]);
    expect(existsSync(yes.source("rules", "claude.md"))).toBe(true);

    const no = laptop();
    const declined = await no.init([], { ask: async () => false });
    expect(declined.out).toContain(
      "Context: not imported. selfhost init --import-context copies 6 rules, 1 skill, 1 command, 1 subagent and mcp.json into .selfhost/context/ later.",
    );
    expect(existsSync(no.source())).toBe(false);

    const quiet = laptop();
    const never = async () => {
      throw new Error("asked");
    };
    const json = JSON.parse((await quiet.init(["--json"], { ask: never })).out);
    expect(json.context.status).toBe("offered");
    const flagged = await quiet.init(["--yes", "--no-import-context"], { ask: never });
    expect(flagged.code).toBe(0);
    expect(existsSync(quiet.source())).toBe(false);
  });

  it("copies no secret from an MCP config and keeps a file edited since through --undo", async () => {
    const { home, repo, init, source } = laptop();
    const value = ["plain", "value", "4471"].join("-");
    writeFileSync(
      repo.path(".mcp.json"),
      JSON.stringify({
        mcpServers: {
          docs: { command: "npx", args: ["-y", "@acme/docs-mcp"], env: { API_TOKEN: value } },
          tracker: { command: "tracker-mcp", args: [`--api-key=${value}`] },
          status: {
            url: "https://status.example.com/mcp",
            headers: { Authorization: `Bearer ${value}x` },
          },
        },
      }),
    );
    const result = await init(["--import-context"]);
    expect(result.out).toContain(
      "  Left out: .mcp.json (MCP server tracker) (a secret is in its command, args or url; add it by hand)",
    );
    expect(result.out).toContain(
      `  Note: Secret values in MCP env and headers were not copied; mcp.json reads them from ${ref("API_TOKEN")}, ${ref("STATUS_AUTHORIZATION")}.`,
    );
    const mcp = readFileSync(source("mcp.json"), "utf8");
    expect(JSON.parse(mcp).mcpServers).toMatchObject({
      docs: { env: { API_TOKEN: ref("API_TOKEN") } },
      status: { headers: { Authorization: `Bearer ${ref("STATUS_AUTHORIZATION")}` } },
    });
    expect(`${mcp}${result.out}`).not.toContain(value);

    writeFileSync(source("rules", "claude.md"), "edited by hand\n");
    const undo = await run(["init", "--home", home.root, "--undo"], { cwd: repo.root });
    expect(undo.code).toBe(1);
    expect(undo.out).toContain("Deleted 10 context files");
    expect(undo.out).toContain(
      `Left ${source("rules", "claude.md")} as is: changed since selfhost init.`,
    );
    expect(readFileSync(source("rules", "claude.md"), "utf8")).toBe("edited by hand\n");
  });
});
