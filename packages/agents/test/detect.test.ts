import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type AgentStatus, detectAgents, parseVersion, pathLookup } from "../src/index.js";
import { EXECUTABLE, fixtureHome } from "./helpers.js";

const SECRET = "sk-test-SECRET-MARKER-000";
const none = () => undefined;

function byId(agents: AgentStatus[], id: AgentStatus["id"]): AgentStatus {
  const agent = agents.find((entry) => entry.id === id);
  if (!agent) throw new Error(`missing ${id}`);
  return agent;
}

describe("detectAgents", () => {
  it("reports all five agents as missing in an empty home without running anything", () => {
    const { home } = fixtureHome();
    const keychain = vi.fn(() => true);
    const version = vi.fn(() => "1.0.0");
    const agents = detectAgents({
      home,
      env: {},
      platform: "darwin",
      which: none,
      keychain,
      version,
    });
    expect(agents.map((agent) => agent.id)).toEqual([
      "claude_code",
      "codex",
      "opencode",
      "goose",
      "cursor",
    ]);
    for (const agent of agents) {
      expect(agent.installed).toBe(false);
      expect(agent.login.status).toBe("logged_out");
    }
    expect(byId(agents, "claude_code").configPath).toBe(join(home, ".claude", "settings.json"));
    expect(byId(agents, "codex").configPath).toBe(join(home, ".codex", "config.toml"));
    expect(byId(agents, "opencode").configPath).toBe(
      join(home, ".config", "opencode", "opencode.json"),
    );
    expect(byId(agents, "goose").configPath).toBe(join(home, ".config", "goose", "config.yaml"));
    expect(byId(agents, "cursor").configPath).toBe(join(home, ".cursor", "cli-config.json"));
    expect(keychain).not.toHaveBeenCalled();
    expect(version).not.toHaveBeenCalled();
  });

  it("finds a native Claude Code install, its version and a credentials file", () => {
    const fx = fixtureHome();
    const real = fx.write(".local/share/claude/versions/2.1.300", "#!/bin/sh\n", EXECUTABLE);
    fx.link(".local/bin/claude", real);
    fx.write(".claude/.credentials.json", `{"token":"${SECRET}"}`);
    const version = vi.fn(() => "9.9.9");
    const [claude] = detectAgents({ home: fx.home, platform: "linux", which: none, version });
    expect(claude).toMatchObject({
      installed: true,
      binary: fx.path(".local/bin/claude"),
      version: "2.1.300",
      login: { status: "logged_in", method: "file", hint: "claude auth login" },
    });
    expect(version).not.toHaveBeenCalled();
  });

  it("checks the macOS keychain by service name and treats a miss as signed out", () => {
    const fx = fixtureHome();
    fx.write(".claude/settings.json", "{}");
    const keychain = vi.fn((service: string) => service === "Claude Code-credentials");
    let claude = byId(
      detectAgents({ home: fx.home, platform: "darwin", which: none, keychain }),
      "claude_code",
    );
    expect(claude.login).toMatchObject({
      status: "logged_in",
      method: "keychain",
      source: "Claude Code-credentials",
    });
    claude = byId(
      detectAgents({ home: fx.home, platform: "darwin", which: none, keychain: () => false }),
      "claude_code",
    );
    expect(claude.login.status).toBe("logged_out");
    claude = byId(detectAgents({ home: fx.home, platform: "darwin", which: none }), "claude_code");
    expect(claude.login.status).toBe("unknown");
  });

  it("follows CLAUDE_CONFIG_DIR for paths and the hashed keychain service", () => {
    const fx = fixtureHome();
    const dir = fx.path("work-claude");
    fx.write("work-claude/settings.json", "{}");
    const keychain = vi.fn(() => false);
    const claude = byId(
      detectAgents({
        home: fx.home,
        env: { CLAUDE_CONFIG_DIR: dir },
        platform: "darwin",
        which: none,
        keychain,
      }),
      "claude_code",
    );
    expect(claude.configPath).toBe(join(dir, "settings.json"));
    const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
    expect(keychain).toHaveBeenCalledWith(`Claude Code-credentials-${hash}`, undefined);
    // A miss on the hashed name is not proof of no login.
    expect(claude.login.status).toBe("unknown");
  });

  it("counts env and apiKeyHelper logins for Claude Code without reading their values", () => {
    const fx = fixtureHome();
    fx.write(".claude/settings.json", JSON.stringify({ apiKeyHelper: "~/bin/key.sh" }));
    let claude = byId(
      detectAgents({ home: fx.home, platform: "linux", which: none }),
      "claude_code",
    );
    expect(claude.login).toMatchObject({ status: "logged_in", method: "settings" });
    fx.write(".claude/settings.json", "{}");
    claude = byId(
      detectAgents({
        home: fx.home,
        env: { ANTHROPIC_API_KEY: SECRET },
        platform: "linux",
        which: none,
      }),
      "claude_code",
    );
    expect(claude.login).toMatchObject({
      status: "logged_in",
      method: "env",
      source: "ANTHROPIC_API_KEY",
    });
    expect(JSON.stringify(claude)).not.toContain(SECRET);
  });

  it("finds Codex under CODEX_HOME with auth.json or a keyring entry", () => {
    const fx = fixtureHome();
    const codexHome = fx.path("codex-home");
    fx.write("codex-home/config.toml", 'model = "o3"\n');
    const env = { CODEX_HOME: codexHome };
    const keychain = vi.fn(() => true);
    let codex = byId(
      detectAgents({ home: fx.home, env, platform: "darwin", which: none, keychain }),
      "codex",
    );
    const account = `cli|${createHash("sha256").update(realpathSync(codexHome)).digest("hex").slice(0, 16)}`;
    expect(keychain).toHaveBeenCalledWith("Codex Auth", account);
    expect(codex.login).toMatchObject({ status: "logged_in", method: "keychain" });

    fx.write("codex-home/auth.json", `{"OPENAI_API_KEY":"${SECRET}"}`);
    codex = byId(detectAgents({ home: fx.home, env, platform: "linux", which: none }), "codex");
    expect(codex.login).toMatchObject({
      status: "logged_in",
      method: "file",
      source: join(codexHome, "auth.json"),
    });
    expect(JSON.stringify(codex)).not.toContain(SECRET);
  });

  it("says unknown for a Codex keyring on Linux, which can't be checked", () => {
    const fx = fixtureHome();
    fx.write(".codex/config.toml", 'cli_auth_credentials_store = "keyring"\n');
    const codex = byId(detectAgents({ home: fx.home, platform: "linux", which: none }), "codex");
    expect(codex.login.status).toBe("unknown");
    fx.write(".codex/config.toml", 'cli_auth_credentials_store = "file"\n');
    expect(
      byId(detectAgents({ home: fx.home, platform: "linux", which: none }), "codex").login.status,
    ).toBe("logged_out");
  });

  it("reads OpenCode logins from auth.json, provider variables or the database", () => {
    const fx = fixtureHome();
    fx.write(".config/opencode/opencode.json", "{}");
    fx.write(".local/share/opencode/auth.json", "{}");
    const detect = (env = {}) =>
      byId(detectAgents({ home: fx.home, env, platform: "linux", which: none }), "opencode").login;
    expect(detect().status).toBe("logged_out");
    expect(detect({ OPENROUTER_API_KEY: SECRET })).toMatchObject({
      status: "logged_in",
      method: "env",
    });
    fx.write(".local/share/opencode/opencode.db", "SQLite format 3");
    expect(detect()).toMatchObject({ status: "unknown", method: "database" });
    fx.write(".local/share/opencode/auth.json", `{"anthropic":{"type":"api","key":"${SECRET}"}}`);
    expect(detect()).toMatchObject({ status: "logged_in", method: "file" });
  });

  it("finds Goose secrets in the keychain or secrets.yaml, and skips pressly/goose", () => {
    const fx = fixtureHome();
    fx.write(".local/bin/goose", "#!/bin/sh\n", EXECUTABLE);
    const keychain = vi.fn(() => true);
    let goose = byId(
      detectAgents({
        home: fx.home,
        platform: "darwin",
        which: none,
        keychain,
        version: () => "1.12.0",
      }),
      "goose",
    );
    expect(goose).toMatchObject({ installed: true, version: "1.12.0" });
    expect(keychain).toHaveBeenCalledWith("goose", "secrets");
    expect(goose.login.method).toBe("keychain");

    goose = byId(
      detectAgents({
        home: fx.home,
        platform: "darwin",
        which: none,
        version: () => "goose version: v3.26.0",
      }),
      "goose",
    );
    expect(goose.installed).toBe(false);

    fx.write(".config/goose/secrets.yaml", `OPENAI_API_KEY: ${SECRET}\n`);
    goose = byId(detectAgents({ home: fx.home, platform: "linux", which: none }), "goose");
    expect(goose.login).toMatchObject({ status: "logged_in", method: "file" });
  });

  it("uses %APPDATA% for Goose on Windows", () => {
    const fx = fixtureHome();
    const goose = byId(
      detectAgents({
        home: fx.home,
        env: { APPDATA: fx.path("Roaming") },
        platform: "win32",
        which: none,
      }),
      "goose",
    );
    expect(goose.configPath).toBe(
      join(fx.path("Roaming"), "Block", "goose", "config", "config.yaml"),
    );
  });

  it("accepts `agent` only when it resolves into a Cursor install", () => {
    const fx = fixtureHome();
    const other = fx.write("bin/agent", "#!/bin/sh\n", EXECUTABLE);
    let cursor = byId(
      detectAgents({
        home: fx.home,
        platform: "linux",
        which: (name) => (name === "agent" ? other : undefined),
      }),
      "cursor",
    );
    expect(cursor.installed).toBe(false);

    const real = fx.write(
      ".local/share/cursor-agent/versions/2026.10.01-e373342/cursor-agent",
      "#!/bin/sh\n",
      EXECUTABLE,
    );
    fx.link(".local/bin/agent", real);
    cursor = byId(
      detectAgents({
        home: fx.home,
        env: { CURSOR_API_KEY: SECRET },
        platform: "linux",
        which: none,
      }),
      "cursor",
    );
    expect(cursor).toMatchObject({
      installed: true,
      version: "2026.10.01-e373342",
      login: { status: "logged_in", method: "env", source: "CURSOR_API_KEY", hint: "agent login" },
    });
    fx.write(".config/cursor/auth.json", `{"accessToken":"${SECRET}"}`);
    cursor = byId(detectAgents({ home: fx.home, platform: "linux", which: none }), "cursor");
    expect(cursor.login).toMatchObject({ status: "logged_in", method: "file" });
  });

  it("looks binaries up on PATH", () => {
    const fx = fixtureHome();
    fx.write("bin/codex", "#!/bin/sh\n", EXECUTABLE);
    fx.write("bin/not-executable", "", 0o644);
    const which = pathLookup({ PATH: `${fx.path("nowhere")}:${fx.path("bin")}` }, "linux");
    expect(which("codex")).toBe(fx.path("bin", "codex"));
    expect(which("not-executable")).toBeUndefined();
    const codex = byId(
      detectAgents({ home: fx.home, env: { PATH: fx.path("bin") }, platform: "linux" }),
      "codex",
    );
    expect(codex).toMatchObject({
      installed: true,
      binary: fx.path("bin", "codex"),
      version: null,
    });
  });
});

describe("parseVersion", () => {
  it("reads the version out of --version output", () => {
    expect(parseVersion("2.1.300 (Claude Code)")).toBe("2.1.300");
    expect(parseVersion("codex-cli 0.58.0")).toBe("0.58.0");
    expect(parseVersion("2026.10.01-e373342")).toBe("2026.10.01-e373342");
    expect(parseVersion("no version here")).toBeUndefined();
  });
});
