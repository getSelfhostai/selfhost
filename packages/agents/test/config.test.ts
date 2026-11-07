import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  AGENT_IDS,
  type AgentConfigInput,
  type AgentConfigPlan,
  applyAgentConfig,
  BLOCK_START,
  manifestPath,
  planAgentConfig,
  removeAgentConfig,
  unifiedDiff,
} from "../src/index.js";
import { fixtureHome } from "./helpers.js";

const NOW = new Date("2026-11-07T10:20:30Z");

const INPUT: AgentConfigInput = {
  hooks: { command: "selfhost hook --agent {agent}" },
  env: { SELFHOST_URL: "http://127.0.0.1:4400" },
  otel: { endpoint: "http://127.0.0.1:4318", headers: { "x-selfhost-token": "tok-SECRET" } },
  mcpServers: { selfhost: { command: "selfhost", args: ["mcp"] } },
};

const read = (path: string) => readFileSync(path, "utf8");
const readJson = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;
const statuses = (plan: AgentConfigPlan) =>
  Object.fromEntries(plan.items.map((item) => [item.item, item.status]));

function configure(home: string, agent: (typeof AGENT_IDS)[number], input = INPUT) {
  const plan = planAgentConfig(agent, { home, platform: "linux", ...input });
  applyAgentConfig(plan, { now: NOW });
  return plan;
}

describe("Claude Code settings", () => {
  const userSettings = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    permissions: { allow: ["Bash(npm test)"] },
    env: { MY_VAR: "1" },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./mine.sh" }] }],
    },
  };

  it("merges env, OpenTelemetry, hooks and MCP into the right files and keeps the user's keys", () => {
    const fx = fixtureHome();
    const settings = fx.write(
      ".claude/settings.json",
      `${JSON.stringify(userSettings, null, 2)}\n`,
      0o640,
    );
    const global = fx.write(
      ".claude.json",
      JSON.stringify({ numStartups: 3, projects: {} }, null, 2),
    );
    const plan = configure(fx.home, "claude_code");
    expect(statuses(plan)).toEqual({
      env: "create",
      otel: "create",
      hooks: "create",
      "mcp:selfhost": "create",
    });

    const merged = readJson(settings);
    expect(merged.permissions).toEqual(userSettings.permissions);
    expect(merged.env).toEqual({
      MY_VAR: "1",
      SELFHOST_URL: "http://127.0.0.1:4400",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "x-selfhost-token=tok-SECRET",
    });
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual([
      userSettings.hooks.PreToolUse[0],
      { hooks: [{ type: "command", command: "selfhost hook --agent claude_code" }] },
    ]);
    expect(Object.keys(hooks)).toContain("SessionStart");
    expect(statSync(settings).mode & 0o777).toBe(0o640);

    // MCP servers at user scope live in ~/.claude.json, not settings.json.
    expect(merged.mcpServers).toBeUndefined();
    expect(readJson(global)).toEqual({
      numStartups: 3,
      projects: {},
      mcpServers: { selfhost: { type: "stdio", command: "selfhost", args: ["mcp"], env: {} } },
    });
    const backups = readdirSync(join(fx.home, ".claude")).filter((name) =>
      name.includes("selfhost-backup"),
    );
    expect(backups).toEqual(["settings.json.selfhost-backup-20261107T102030Z"]);
    expect(existsSync(manifestPath(fx.home, "claude_code"))).toBe(true);
  });

  it("plans nothing on a second run and restores the original files on removal", () => {
    const fx = fixtureHome();
    const original = `${JSON.stringify(userSettings, null, 2)}\n`;
    const settings = fx.write(".claude/settings.json", original);
    configure(fx.home, "claude_code");

    const again = planAgentConfig("claude_code", { home: fx.home, platform: "linux", ...INPUT });
    expect(again.changes).toEqual([]);
    expect(new Set(Object.values(statuses(again)))).toEqual(new Set(["unchanged"]));

    const removal = removeAgentConfig("claude_code", { home: fx.home, platform: "linux" });
    expect(new Set(Object.values(statuses(removal)))).toEqual(new Set(["remove"]));
    applyAgentConfig(removal, { now: NOW });
    expect(read(settings)).toBe(original);
    // selfhost created ~/.claude.json for the MCP server, so removal deletes it again.
    expect(existsSync(fx.path(".claude.json"))).toBe(false);
    expect(existsSync(manifestPath(fx.home, "claude_code"))).toBe(false);
  });

  it("leaves a key the user set to another value alone and reports a conflict", () => {
    const fx = fixtureHome();
    const settings = fx.write(
      ".claude/settings.json",
      JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://theirs:4318" } }, null, 2),
    );
    const plan = configure(fx.home, "claude_code", { otel: INPUT.otel });
    expect(plan.items).toEqual([
      expect.objectContaining({ item: "otel", status: "conflict", path: settings }),
    ]);
    expect(plan.items[0]?.message).toContain("env.OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(readJson(settings)).toEqual({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://theirs:4318" },
    });
  });

  it("updates its own values when the input changes", () => {
    const fx = fixtureHome();
    const settings = fx.write(".claude/settings.json", "{}\n");
    configure(fx.home, "claude_code", { otel: { endpoint: "http://a:4318" } });
    const plan = configure(fx.home, "claude_code", {
      otel: { endpoint: "http://b:4318", protocol: "grpc" },
    });
    expect(statuses(plan)).toEqual({ otel: "update" });
    const env = readJson(settings).env as Record<string, string>;
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://b:4318");
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("grpc");

    // Dropping an item takes out only that item.
    const dropped = configure(fx.home, "claude_code", { env: { A: "1" } });
    expect(statuses(dropped)).toEqual({ env: "create", otel: "remove" });
    expect(readJson(settings)).toEqual({ env: { A: "1" } });
  });

  it("refuses a plan when the file changed after planning", () => {
    const fx = fixtureHome();
    const settings = fx.write(".claude/settings.json", "{}\n");
    const plan = planAgentConfig("claude_code", {
      home: fx.home,
      platform: "linux",
      env: { A: "1" },
    });
    writeFileSync(settings, '{"model":"opus"}\n');
    expect(() => applyAgentConfig(plan)).toThrow(/changed since the plan was made/);
    expect(read(settings)).toBe('{"model":"opus"}\n');
    expect(existsSync(manifestPath(fx.home, "claude_code"))).toBe(false);
  });

  it("writes through a symlinked settings file", () => {
    const fx = fixtureHome();
    const real = fx.write("dotfiles/claude-settings.json", "{}\n");
    const link = fx.link(".claude/settings.json", real);
    configure(fx.home, "claude_code", { env: { A: "1" } });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readJson(real)).toEqual({ env: { A: "1" } });
  });

  it("follows CLAUDE_CONFIG_DIR, including for ~/.claude.json", () => {
    const fx = fixtureHome();
    const dir = fx.path("alt");
    const plan = planAgentConfig("claude_code", {
      home: fx.home,
      platform: "linux",
      processEnv: { CLAUDE_CONFIG_DIR: dir },
      env: { A: "1" },
      mcpServers: INPUT.mcpServers,
    });
    expect(plan.changes.map((change) => change.path)).toEqual([
      join(dir, "settings.json"),
      join(dir, ".claude.json"),
      manifestPath(fx.home, "claude_code"),
    ]);
  });
});

describe("Codex config.toml", () => {
  const original = [
    "# my codex settings",
    'model = "o3" # pinned',
    "",
    "[mcp_servers.docs]",
    'command = "docs-mcp"',
    "",
  ].join("\n");

  it("adds one marked block, keeps comments and parses, and removal restores the bytes", () => {
    const fx = fixtureHome();
    const config = fx.write(".codex/config.toml", original);
    const plan = configure(fx.home, "codex", {
      ...INPUT,
      otel: { ...INPUT.otel, traces: true, endpoint: "http://h:4318" },
    });
    expect(statuses(plan)).toEqual({
      env: "unsupported",
      otel: "create",
      hooks: "create",
      "mcp:selfhost": "create",
    });
    const text = read(config);
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain(BLOCK_START);
    const parsed = parseToml(text) as {
      model: string;
      mcp_servers: unknown;
      otel: unknown;
      hooks: Record<string, unknown>;
    };
    expect(parsed.model).toBe("o3");
    expect(parsed.mcp_servers).toEqual({
      docs: { command: "docs-mcp" },
      selfhost: { command: "selfhost", args: ["mcp"] },
    });
    expect(parsed.otel).toEqual({
      exporter: {
        "otlp-http": {
          endpoint: "http://h:4318/v1/logs",
          protocol: "binary",
          headers: { "x-selfhost-token": "tok-SECRET" },
        },
      },
      trace_exporter: {
        "otlp-http": {
          endpoint: "http://h:4318/v1/traces",
          protocol: "binary",
          headers: { "x-selfhost-token": "tok-SECRET" },
        },
      },
    });
    expect(parsed.hooks.PreToolUse).toEqual([
      { hooks: [{ type: "command", command: "selfhost hook --agent codex" }] },
    ]);
    expect(Object.keys(parsed.hooks)).toHaveLength(13);

    const again = planAgentConfig("codex", {
      home: fx.home,
      platform: "linux",
      ...INPUT,
      otel: { ...INPUT.otel, traces: true, endpoint: "http://h:4318" },
    });
    expect(again.changes).toEqual([]);

    applyAgentConfig(removeAgentConfig("codex", { home: fx.home, platform: "linux" }));
    expect(read(config)).toBe(original);
  });

  it("does not touch a table the user already has", () => {
    const fx = fixtureHome();
    const userOtel = '[otel]\nexporter = "none"\n';
    const config = fx.write(".codex/config.toml", userOtel);
    const plan = configure(fx.home, "codex", { otel: INPUT.otel });
    expect(plan.items).toEqual([expect.objectContaining({ item: "otel", status: "conflict" })]);
    expect(read(config)).toBe(userOtel);
  });

  it("writes hooks into hooks.json when the user keeps hooks there", () => {
    const fx = fixtureHome();
    const hooksJson = fx.write(".codex/hooks.json", JSON.stringify({ hooks: {} }, null, 2));
    const config = fx.write(".codex/config.toml", 'model = "o3"\n');
    configure(fx.home, "codex", { hooks: INPUT.hooks });
    expect(read(config)).toBe('model = "o3"\n');
    const hooks = readJson(hooksJson).hooks as Record<string, unknown>;
    expect(hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "selfhost hook --agent codex" }] },
    ]);
  });

  it("reports an error instead of writing a file that would not parse", () => {
    const fx = fixtureHome();
    const config = fx.write(".codex/config.toml", 'model = "o3\n');
    const plan = configure(fx.home, "codex", { otel: INPUT.otel });
    expect(plan.items[0]).toMatchObject({ item: "otel", status: "error" });
    expect(read(config)).toBe('model = "o3\n');
  });
});

describe("Goose config.yaml", () => {
  it("adds an extension and the OTLP endpoint, keeps comments, and removal restores the bytes", () => {
    const fx = fixtureHome();
    const original =
      "# goose settings\nGOOSE_PROVIDER: anthropic # main\nextensions:\n  developer:\n    enabled: true\n    type: builtin\n";
    const config = fx.write(".config/goose/config.yaml", original);
    const plan = configure(fx.home, "goose");
    expect(statuses(plan)).toEqual({
      env: "unsupported",
      otel: "create",
      hooks: "unsupported",
      "mcp:selfhost": "create",
    });
    const text = read(config);
    expect(text).toContain("# goose settings");
    expect(text).toContain("GOOSE_PROVIDER: anthropic # main");
    const parsed = parseYaml(text);
    expect(parsed.otel_exporter_otlp_endpoint).toBe("http://127.0.0.1:4318");
    expect(parsed.extensions.selfhost).toEqual({
      name: "selfhost",
      type: "stdio",
      enabled: true,
      cmd: "selfhost",
      args: ["mcp"],
      envs: {},
      env_keys: [],
      timeout: 300,
    });
    expect(
      planAgentConfig("goose", { home: fx.home, platform: "linux", ...INPUT }).changes,
    ).toEqual([]);
    applyAgentConfig(removeAgentConfig("goose", { home: fx.home, platform: "linux" }));
    expect(read(config)).toBe(original);
  });

  it("does not write gRPC, which Goose can't export", () => {
    const fx = fixtureHome();
    const plan = planAgentConfig("goose", {
      home: fx.home,
      platform: "linux",
      otel: { endpoint: "http://h:4317", protocol: "grpc" },
    });
    expect(plan.items).toEqual([expect.objectContaining({ item: "otel", status: "unsupported" })]);
    expect(plan.changes).toEqual([]);
  });
});

describe("OpenCode opencode.json", () => {
  it("adds the server under mcp.servers and says what OpenCode can't take", () => {
    const fx = fixtureHome();
    const config = fx.write(
      ".config/opencode/opencode.json",
      JSON.stringify({ model: "x" }, null, 2),
    );
    const plan = configure(fx.home, "opencode");
    expect(statuses(plan)).toEqual({
      env: "unsupported",
      otel: "unsupported",
      hooks: "unsupported",
      "mcp:selfhost": "create",
    });
    expect(readJson(config)).toEqual({
      model: "x",
      mcp: { servers: { selfhost: { type: "local", command: ["selfhost", "mcp"] } } },
    });
  });

  it("keeps the OpenCode 1 layout when the file already uses it", () => {
    const fx = fixtureHome();
    const config = fx.write(
      ".config/opencode/opencode.json",
      JSON.stringify({ mcp: { docs: { type: "local", command: ["docs"] } } }),
    );
    configure(fx.home, "opencode", { mcpServers: INPUT.mcpServers });
    const mcp = readJson(config).mcp as Record<string, unknown>;
    expect(mcp.selfhost).toEqual({ type: "local", command: ["selfhost", "mcp"], enabled: true });
  });

  it("does not rewrite a JSONC file with comments", () => {
    const fx = fixtureHome();
    const text = '{\n  // mine\n  "model": "x",\n}\n';
    const config = fx.write(".config/opencode/opencode.jsonc", text);
    const plan = configure(fx.home, "opencode", { mcpServers: INPUT.mcpServers });
    expect(plan.items[0]).toMatchObject({ item: "mcp:selfhost", status: "error", path: config });
    expect(read(config)).toBe(text);
  });
});

describe("Cursor", () => {
  it("creates hooks.json and mcp.json, and removal deletes the files it created", () => {
    const fx = fixtureHome();
    const plan = configure(fx.home, "cursor");
    expect(statuses(plan)).toEqual({
      env: "unsupported",
      otel: "unsupported",
      hooks: "create",
      "mcp:selfhost": "create",
    });
    const hooks = readJson(fx.path(".cursor/hooks.json"));
    expect(hooks.version).toBe(1);
    expect((hooks.hooks as Record<string, unknown>).beforeShellExecution).toEqual([
      { command: "selfhost hook --agent cursor" },
    ]);
    expect(readJson(fx.path(".cursor/mcp.json"))).toEqual({
      mcpServers: { selfhost: { command: "selfhost", args: ["mcp"], env: {} } },
    });
    expect(statSync(fx.path(".cursor/mcp.json")).mode & 0o777).toBe(0o600);
    applyAgentConfig(removeAgentConfig("cursor", { home: fx.home, platform: "linux" }));
    expect(existsSync(fx.path(".cursor/hooks.json"))).toBe(false);
    expect(existsSync(fx.path(".cursor/mcp.json"))).toBe(false);
  });
});

describe("every agent", () => {
  it("writes only inside the agents' own config folders and selfhost's state, never a shell profile", () => {
    const fx = fixtureHome();
    const paths = AGENT_IDS.flatMap(
      (agent) => planAgentConfig(agent, { home: fx.home, platform: "linux", ...INPUT }).changes,
    ).map((change) => change.path.slice(fx.home.length + 1));
    expect(paths.sort()).toEqual([
      ".claude.json",
      ".claude/settings.json",
      ".codex/config.toml",
      ".config/goose/config.yaml",
      ".config/opencode/opencode.json",
      ".cursor/hooks.json",
      ".cursor/mcp.json",
      ".selfhost/agents/claude_code.json",
      ".selfhost/agents/codex.json",
      ".selfhost/agents/cursor.json",
      ".selfhost/agents/goose.json",
      ".selfhost/agents/opencode.json",
    ]);
  });

  it("rejects an MCP server with neither a command nor a url", () => {
    const fx = fixtureHome();
    const plan = planAgentConfig("cursor", {
      home: fx.home,
      platform: "linux",
      mcpServers: { bad: {} },
    });
    expect(plan.items).toEqual([expect.objectContaining({ item: "mcp:bad", status: "error" })]);
  });
});

describe("dry-run diff", () => {
  it("shows the change as a unified diff with credentials masked", () => {
    const fx = fixtureHome();
    fx.write(".claude/settings.json", '{\n  "model": "opus"\n}\n');
    const plan = planAgentConfig("claude_code", {
      home: fx.home,
      platform: "linux",
      otel: INPUT.otel,
    });
    const change = plan.changes[0];
    if (!change) throw new Error("expected a change");
    const diff = unifiedDiff(change.path, change.before, change.after);
    expect(diff).toContain(`--- ${change.path}`);
    expect(diff).toContain('+    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318",');
    expect(diff).toContain('+    "OTEL_EXPORTER_OTLP_HEADERS": "<redacted>"');
    expect(diff).not.toContain("tok-SECRET");
  });
});
