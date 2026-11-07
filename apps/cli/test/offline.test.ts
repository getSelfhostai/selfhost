import { mkdirSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockNetwork } from "./network.js";
import { run, tempDir } from "./run.js";
import { attributionFor } from "./scan-logs.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");

describe("every command works with --json and no network", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("the stubs catch an outbound connection", async () => {
    const attempts = blockNetwork();
    expect(() => net.connect(443, "example.com")).toThrow(/network access/);
    await expect(async () => fetch("https://example.com")).rejects.toThrow(/network access/);
    expect(attempts).toEqual(["net.connect", "fetch"]);
  });

  it("doctor, agents, agents configure and import", async () => {
    const home = tempDir("offline-home");
    const repo = tempDir("offline-repo");
    mkdirSync(repo.path(".git"));
    repo.write("selfhost.toml", "version = 1\n");
    home.write(".claude/settings.json", "{}\n");
    // The importers read these from the process environment.
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(fixtures, "claude-code"));
    vi.stubEnv("CODEX_HOME", join(fixtures, "codex"));
    const attempts = blockNetwork();
    const deps = { cwd: repo.root };

    const doctor = await run(["doctor", "--json"], deps);
    expect(doctor.code).toBe(0);
    expect(JSON.parse(doctor.out)).toMatchObject({
      schema: "selfhost.doctor/v1",
      config: { path: repo.path("selfhost.toml"), from: "search", exists: true, valid: true },
    });

    const agents = await run(["agents", "--json", "--home", home.root], deps);
    expect(JSON.parse(agents.out).schema).toBe("selfhost.agents/v1");

    const configure = [
      "agents",
      "configure",
      "--json",
      "--home",
      home.root,
      "--otel-endpoint",
      "http://127.0.0.1:4318",
      "--mcp",
      "selfhost=selfhost mcp",
    ];
    expect(JSON.parse((await run([...configure, "--dry-run"], deps)).out).dryRun).toBe(true);
    expect((await run(configure, deps)).code).toBe(0);
    expect(
      (await run(["agents", "configure", "--json", "--remove", "--home", home.root], deps)).code,
    ).toBe(0);

    const imported = await run(
      [
        "import",
        "--json",
        "--data-dir",
        "memory://",
        "--since",
        "2026-10-01",
        "--person",
        "dev@example.com",
      ],
      deps,
    );
    expect(imported.err).toBe("");
    const report = JSON.parse(imported.out);
    expect(Object.keys(report)).toEqual(["schema", "files", "accepted", "duplicates", "ledger"]);
    expect(report.accepted).toBeGreaterThan(0);

    expect(attempts).toEqual([]);
  });

  it("scan uploads nothing, even with a yes to the agent count", async () => {
    const work = tempDir("offline-scan");
    mkdirSync(work.path(".git"));
    const attempts = blockNetwork();
    const deps = {
      cwd: work.root,
      env: {
        CLAUDE_CONFIG_DIR: join(fixtures, "claude-code"),
        CODEX_HOME: join(fixtures, "codex"),
      },
      configPath: work.path("home", "config.json"),
      ask: async () => true,
      collectAttribution: async () => attributionFor(["538b2156-9f52-495c-82d4-2bae253bfac6"]),
    };
    const args = ["scan", "--since", "2026-10-01", "--report", "r.html", "--share", "c.svg"];

    const text = await run(args, deps);
    expect(text.err).toBe("");
    expect(text.out).toContain("Git: acme/api");
    const json = await run([...args, "--json"], deps);
    expect(JSON.parse(json.out).schema).toBe("selfhost.scan/v1");

    expect(attempts).toEqual([]);
  });
});
