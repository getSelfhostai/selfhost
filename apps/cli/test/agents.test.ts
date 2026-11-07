import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMcp } from "../src/agents.js";
import { run, tempDir } from "./run.js";

const OTEL = [
  "--otel-endpoint",
  "http://127.0.0.1:4318",
  "--otel-header",
  "authorization=Bearer tok-SECRET",
];

function fixture() {
  const home = tempDir("home");
  const repo = tempDir("repo");
  mkdirSync(repo.path(".git"));
  return { home, repo };
}

describe("selfhost agents", () => {
  it("prints a stable JSON shape for every agent", async () => {
    const { home, repo } = fixture();
    repo.write("AGENTS.md", "# shared\n");
    home.write(".claude/skills/review/SKILL.md", "skill\n");
    const { code, out } = await run(["agents", "--json", "--home", home.root], { cwd: repo.root });
    expect(code).toBe(0);
    const report = JSON.parse(out);
    expect(Object.keys(report)).toEqual(["schema", "home", "agents", "context"]);
    expect(report.schema).toBe("selfhost.agents/v1");
    expect(report.home).toBe(home.root);
    expect(report.agents.map((agent: { id: string }) => agent.id)).toEqual([
      "claude_code",
      "codex",
      "opencode",
      "goose",
      "cursor",
    ]);
    for (const agent of report.agents) {
      expect(Object.keys(agent)).toEqual([
        "id",
        "name",
        "installed",
        "binary",
        "version",
        "configPath",
        "configExists",
        "login",
      ]);
      expect(Object.keys(agent.login)).toEqual(["status", "method", "source", "hint"]);
    }
    expect(report.context).toEqual([
      { path: repo.path("AGENTS.md"), kind: "agents_md", scope: "repo", agent: "shared", size: 9 },
      {
        path: home.path(".claude", "skills", "review", "SKILL.md"),
        kind: "skill",
        scope: "home",
        agent: "claude_code",
        size: 6,
      },
    ]);
  });

  it("prints a table, the sign-in hint and the context files", async () => {
    const { home, repo } = fixture();
    const real = home.write(".local/share/claude/versions/2.1.300", "#!/bin/sh\n", 0o755);
    home.link(".local/bin/claude", real);
    repo.write("CLAUDE.md", "# rules\n");
    const { out } = await run(["agents", "--home", home.root], { cwd: repo.root });
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^AGENT\s+INSTALLED\s+VERSION\s+LOGIN\s+CONFIG$/);
    expect(lines[1]).toMatch(
      /^Claude Code\s+yes\s+2\.1\.300\s+not signed in\s+~\/\.claude\/settings\.json \(none yet\)$/,
    );
    expect(out).toContain("Claude Code is not signed in. Sign in with `claude auth login`.");
    expect(out).toContain("Context files (1)");
    expect(out).toMatch(/repo\s+CLAUDE\.md\s+CLAUDE\.md\s+8 B/);
  });

  it("ignores agent folder variables and the keychain when --home is set", async () => {
    const { home, repo } = fixture();
    let keychainCalls = 0;
    const { out } = await run(["agents", "--json", "--home", home.root], {
      cwd: repo.root,
      platform: "darwin",
      env: { CLAUDE_CONFIG_DIR: "/real/claude", CODEX_HOME: "/real/codex" },
      probes: {
        keychain: () => {
          keychainCalls++;
          return true;
        },
      },
    });
    const report = JSON.parse(out);
    expect(report.agents[0].configPath).toBe(home.path(".claude", "settings.json"));
    expect(report.agents[1].configPath).toBe(home.path(".codex", "config.toml"));
    expect(keychainCalls).toBe(0);
  });
});

describe("selfhost agents configure", () => {
  it("prints a dry-run diff and writes nothing", async () => {
    const { home, repo } = fixture();
    const settings = home.write(".claude/settings.json", '{\n  "model": "opus"\n}\n');
    const { code, out } = await run(
      ["agents", "configure", "--dry-run", "--home", home.root, "--agent", "claude", ...OTEL],
      { cwd: repo.root },
    );
    expect(code).toBe(0);
    expect(out).toContain("Claude Code");
    expect(out).toMatch(/create\s+otel\s+~\/\.claude\/settings\.json/);
    expect(out).toContain("--- ~/.claude/settings.json");
    expect(out).toContain('+    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318",');
    expect(out).not.toContain("tok-SECRET");
    expect(out).toContain("Dry run: no files were changed.");
    expect(readFileSync(settings, "utf8")).toBe('{\n  "model": "opus"\n}\n');
    expect(existsSync(home.path(".selfhost"))).toBe(false);
  });

  it("applies, re-runs as a no-op and removes cleanly, with JSON output", async () => {
    const { home, repo } = fixture();
    const original = '# mine\nmodel = "o3"\n';
    const config = home.write(".codex/config.toml", original);
    const args = [
      "agents",
      "configure",
      "--json",
      "--home",
      home.root,
      ...OTEL,
      "--hook-command",
      "selfhost hook --agent {agent}",
      "--mcp",
      "selfhost=selfhost mcp",
      "--env",
      "SELFHOST_URL=http://127.0.0.1:4400",
    ];
    const first = await run(args, { cwd: repo.root, now: new Date("2026-11-07T10:00:00Z") });
    expect(first.code).toBe(0);
    const report = JSON.parse(first.out);
    expect(Object.keys(report)).toEqual(["schema", "home", "dryRun", "remove", "agents"]);
    // Only Codex has a config folder in this home, so only Codex is configured.
    expect(report.agents.map((agent: { agent: string }) => agent.agent)).toEqual(["codex"]);
    const codex = report.agents[0];
    expect(
      codex.items.map((item: { item: string; status: string }) => `${item.item}:${item.status}`),
    ).toEqual(["env:unsupported", "otel:create", "hooks:create", "mcp:selfhost:create"]);
    expect(
      codex.files.map((file: { role: string; action: string; backup: string | null }) => [
        file.role,
        file.action,
        file.backup,
      ]),
    ).toEqual([
      ["config", "update", `${config}.selfhost-backup-20261107T100000Z`],
      ["state", "create", null],
    ]);
    expect(readFileSync(config, "utf8")).toContain('command = "selfhost hook --agent codex"');

    const second = JSON.parse((await run(args, { cwd: repo.root })).out);
    expect(second.agents[0].files).toEqual([]);

    const removed = await run(["agents", "configure", "--remove", "--home", home.root], {
      cwd: repo.root,
    });
    expect(removed.code).toBe(0);
    expect(removed.out).toMatch(/remove\s+otel/);
    expect(readFileSync(config, "utf8")).toBe(original);
  });

  it("asks for something to configure and reports errors as JSON", async () => {
    const { home, repo } = fixture();
    const text = await run(["agents", "configure", "--home", home.root], { cwd: repo.root });
    expect(text.code).toBe(1);
    expect(text.err).toContain("nothing to configure");
    const json = await run(
      ["agents", "configure", "--json", "--home", home.root, "--agent", "copilot", "--env", "A=1"],
      {
        cwd: repo.root,
      },
    );
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toEqual({
      schema: "selfhost.error/v1",
      error: '--agent: expected one of claude, codex, opencode, goose, cursor, got "copilot"',
    });
  });

  it("never asks for an API key, even with no login", async () => {
    const { home, repo } = fixture();
    home.write(".config/goose/config.yaml", "GOOSE_PROVIDER: openai\n");
    const { code, out } = await run(
      ["agents", "configure", "--home", home.root, "--mcp", "docs=https://docs.example.com/mcp"],
      { cwd: repo.root },
    );
    expect(code).toBe(0);
    expect(out).not.toMatch(/api key/i);
    expect(readFileSync(join(home.root, ".config/goose/config.yaml"), "utf8")).toContain(
      "uri: https://docs.example.com/mcp",
    );
  });
});

describe("parseMcp", () => {
  it("reads stdio commands and urls", () => {
    expect(parseMcp("selfhost=selfhost mcp --stdio")).toEqual([
      "selfhost",
      { command: "selfhost", args: ["mcp", "--stdio"] },
    ]);
    expect(parseMcp("tool=tool")).toEqual(["tool", { command: "tool" }]);
    expect(parseMcp("docs=https://x.dev/mcp")).toEqual(["docs", { url: "https://x.dev/mcp" }]);
    expect(() => parseMcp("nameonly")).toThrow(/--mcp/);
  });
});
