import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  type AgentConfigPlan,
  type AgentId,
  applyAgentConfig,
  GATEWAY_PROFILE,
  type GatewaySpec,
  manifestPath,
  planAgentConfig,
  removeAgentConfig,
  subscriptionLogin,
} from "../src/index.js";
import { fixtureHome } from "./helpers.js";

// Fixture configs in each agent's own format, as people have them, with selfhost gateway
// connect's settings added on top and taken out again.

const NOW = new Date("2026-11-09T08:00:00Z");
const GATEWAY: GatewaySpec = {
  anthropic: "https://selfhost.example.com/llm/anthropic",
  openai: "https://selfhost.example.com/llm/openai/v1",
  key: "sk-bf-fixture",
};

const read = (path: string) => readFileSync(path, "utf8");
const statuses = (plan: AgentConfigPlan) =>
  Object.fromEntries(plan.items.map((item) => [item.item, item.status]));

function plan(home: string, agent: AgentId, gateway: GatewaySpec = GATEWAY) {
  return planAgentConfig(agent, { home, platform: "linux", profile: GATEWAY_PROFILE, gateway });
}

function connect(home: string, agent: AgentId, gateway: GatewaySpec = GATEWAY) {
  const planned = plan(home, agent, gateway);
  applyAgentConfig(planned, { now: NOW });
  return planned;
}

function disconnect(home: string, agent: AgentId) {
  applyAgentConfig(
    removeAgentConfig(agent, { home, platform: "linux", profile: GATEWAY_PROFILE }),
    { now: NOW },
  );
}

describe("Claude Code settings.json", () => {
  const original = `${JSON.stringify(
    {
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      model: "opus",
      permissions: { allow: ["Bash(npm test)"] },
      env: { DISABLE_TELEMETRY: "1" },
    },
    null,
    2,
  )}\n`;

  it("adds the base URL and the key to env, keeps the rest, and removal restores the bytes", () => {
    const fx = fixtureHome();
    const settings = fx.write(".claude/settings.json", original);
    const planned = connect(fx.home, "claude_code");
    expect(statuses(planned)).toEqual({ gateway: "create" });
    const merged = JSON.parse(read(settings));
    expect(merged.model).toBe("opus");
    expect(merged.env).toEqual({
      DISABLE_TELEMETRY: "1",
      ANTHROPIC_BASE_URL: "https://selfhost.example.com/llm/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-bf-fixture",
    });
    expect(plan(fx.home, "claude_code").changes).toEqual([]);

    const rotated = connect(fx.home, "claude_code", { ...GATEWAY, key: "sk-bf-new" });
    expect(statuses(rotated)).toEqual({ gateway: "update" });
    expect(JSON.parse(read(settings)).env.ANTHROPIC_AUTH_TOKEN).toBe("sk-bf-new");

    disconnect(fx.home, "claude_code");
    expect(read(settings)).toBe(original);
    expect(existsSync(manifestPath(fx.home, "claude_code", GATEWAY_PROFILE))).toBe(false);
  });

  it("creates the file when there is none, and removal deletes it", () => {
    const fx = fixtureHome();
    connect(fx.home, "claude_code");
    const settings = fx.path(".claude/settings.json");
    expect(JSON.parse(read(settings)).env.ANTHROPIC_AUTH_TOKEN).toBe("sk-bf-fixture");
    disconnect(fx.home, "claude_code");
    expect(existsSync(settings)).toBe(false);
  });

  it("leaves settings that would bypass the gateway or send a second key alone", () => {
    for (const settings of [
      { env: { ANTHROPIC_API_KEY: "sk-ant-mine" } },
      { apiKeyHelper: "~/bin/key.sh" },
      { env: { CLAUDE_CODE_USE_BEDROCK: "1" } },
      { env: { ANTHROPIC_BASE_URL: "https://proxy.example.com" } },
    ]) {
      const fx = fixtureHome();
      const text = JSON.stringify(settings);
      const path = fx.write(".claude/settings.json", text);
      const planned = connect(fx.home, "claude_code");
      expect(planned.items).toEqual([
        expect.objectContaining({ item: "gateway", status: "conflict", path }),
      ]);
      expect(read(path)).toBe(text);
    }
  });

  it("follows CLAUDE_CONFIG_DIR", () => {
    const fx = fixtureHome();
    const planned = planAgentConfig("claude_code", {
      home: fx.home,
      platform: "linux",
      processEnv: { CLAUDE_CONFIG_DIR: fx.path("work-claude") },
      profile: GATEWAY_PROFILE,
      gateway: GATEWAY,
    });
    expect(planned.changes[0]?.path).toBe(fx.path("work-claude", "settings.json"));
  });
});

describe("Codex config.toml", () => {
  const original = [
    "# my codex settings",
    'model = "gpt-5.5"',
    'approval_policy = "on-request"',
    "",
    "[model_providers.ollama-remote]",
    'name = "Ollama"',
    'base_url = "http://gpu:11434/v1"',
    "",
    "[mcp_servers.docs]",
    'command = "docs-mcp"',
    "",
  ].join("\n");

  it("sets the provider at the top, keeping the user's keys at the root and their tables", () => {
    const fx = fixtureHome();
    const config = fx.write(".codex/config.toml", original);
    expect(statuses(connect(fx.home, "codex"))).toEqual({ gateway: "create" });
    const text = read(config);
    expect(text.startsWith("# >>> selfhost gateway >>>\n")).toBe(true);
    expect(text.endsWith(original)).toBe(true);
    const parsed = parseToml(text) as Record<string, unknown>;
    expect(parsed.model).toBe("gpt-5.5");
    expect(parsed.approval_policy).toBe("on-request");
    expect(parsed.model_provider).toBe("selfhost");
    expect(parsed.model_providers).toEqual({
      selfhost: {
        name: "selfhost gateway",
        base_url: "https://selfhost.example.com/llm/openai/v1",
        wire_api: "responses",
        experimental_bearer_token: "sk-bf-fixture",
      },
      "ollama-remote": { name: "Ollama", base_url: "http://gpu:11434/v1" },
    });
    expect(plan(fx.home, "codex").changes).toEqual([]);

    disconnect(fx.home, "codex");
    expect(read(config)).toBe(original);
  });

  it("sits next to the blocks agents configure and the guardrails write", () => {
    const fx = fixtureHome();
    const config = fx.write(".codex/config.toml", 'model = "gpt-5.5"\n');
    applyAgentConfig(
      planAgentConfig("codex", {
        home: fx.home,
        platform: "linux",
        otel: { endpoint: "http://127.0.0.1:4318" },
      }),
      { now: NOW },
    );
    const withOtel = read(config);
    connect(fx.home, "codex");
    const both = parseToml(read(config)) as Record<string, unknown>;
    expect(both.model_provider).toBe("selfhost");
    expect(both.otel).toBeDefined();
    disconnect(fx.home, "codex");
    expect(read(config)).toBe(withOtel);
  });

  it("leaves a provider the user chose alone", () => {
    for (const text of ['model_provider = "azure"\n', '[model_providers.selfhost]\nname = "x"\n']) {
      const fx = fixtureHome();
      const config = fx.write(".codex/config.toml", text);
      const planned = connect(fx.home, "codex");
      expect(planned.items).toEqual([
        expect.objectContaining({ item: "gateway", status: "conflict" }),
      ]);
      expect(read(config)).toBe(text);
    }
  });

  it("takes nothing but the gateway's keys in its block, and the gateway only there", () => {
    const fx = fixtureHome();
    const mixed = planAgentConfig("codex", {
      home: fx.home,
      platform: "linux",
      profile: GATEWAY_PROFILE,
      gateway: GATEWAY,
      otel: { endpoint: "http://127.0.0.1:4318" },
    });
    expect(statuses(mixed)).toEqual({ gateway: "create", otel: "error" });
    const main = planAgentConfig("codex", { home: fx.home, platform: "linux", gateway: GATEWAY });
    expect(statuses(main)).toEqual({ gateway: "error" });
    expect(main.changes).toEqual([]);
  });
});

describe("OpenCode opencode.json", () => {
  const original = `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: "anthropic/claude-sonnet-4-5",
      provider: { anthropic: { models: { "claude-sonnet-4-5": {} } } },
    },
    null,
    2,
  )}\n`;

  it("points the Anthropic and OpenAI providers at the gateway, and removal restores the bytes", () => {
    const fx = fixtureHome();
    const config = fx.write(".config/opencode/opencode.json", original);
    expect(statuses(connect(fx.home, "opencode"))).toEqual({ gateway: "create" });
    const merged = JSON.parse(read(config));
    expect(merged.model).toBe("anthropic/claude-sonnet-4-5");
    expect(merged.provider).toEqual({
      anthropic: {
        models: { "claude-sonnet-4-5": {} },
        options: {
          baseURL: "https://selfhost.example.com/llm/anthropic/v1",
          apiKey: "sk-bf-fixture",
        },
      },
      openai: {
        options: { baseURL: "https://selfhost.example.com/llm/openai/v1", apiKey: "sk-bf-fixture" },
      },
    });
    disconnect(fx.home, "opencode");
    expect(read(config)).toBe(original);
  });

  it("leaves a base URL the user set alone, and a JSONC file with comments", () => {
    const fx = fixtureHome();
    const own = JSON.stringify({ provider: { openai: { options: { baseURL: "http://mine" } } } });
    const config = fx.write(".config/opencode/opencode.json", own);
    expect(statuses(connect(fx.home, "opencode"))).toEqual({ gateway: "conflict" });
    expect(read(config)).toBe(own);

    const fy = fixtureHome();
    const jsonc = '{\n  // mine\n  "model": "x",\n}\n';
    const commented = fy.write(".config/opencode/opencode.jsonc", jsonc);
    expect(statuses(connect(fy.home, "opencode"))).toEqual({ gateway: "error" });
    expect(read(commented)).toBe(jsonc);
  });
});

describe("Goose custom provider", () => {
  it("writes a provider file with the key in its headers and leaves config.yaml alone", () => {
    const fx = fixtureHome();
    const yaml = "GOOSE_PROVIDER: anthropic\nGOOSE_MODEL: claude-sonnet-4-5\n";
    const config = fx.write(".config/goose/config.yaml", yaml);
    const planned = connect(fx.home, "goose");
    expect(planned.items).toEqual([
      expect.objectContaining({
        item: "gateway",
        status: "create",
        message: expect.stringContaining("--provider selfhost"),
      }),
    ]);
    const file = fx.path(".config/goose/custom_providers/selfhost.json");
    expect(JSON.parse(read(file))).toEqual({
      name: "selfhost",
      engine: "openai",
      display_name: "selfhost gateway",
      description: expect.any(String),
      base_url: "https://selfhost.example.com/llm/openai/v1/chat/completions",
      models: [],
      headers: { Authorization: "Bearer sk-bf-fixture" },
      supports_streaming: true,
      requires_auth: false,
    });
    expect(read(config)).toBe(yaml);
    disconnect(fx.home, "goose");
    expect(existsSync(file)).toBe(false);
  });

  it("follows Goose's Windows config folder", () => {
    const fx = fixtureHome();
    const planned = planAgentConfig("goose", {
      home: fx.home,
      platform: "win32",
      processEnv: { APPDATA: fx.path("Roaming") },
      profile: GATEWAY_PROFILE,
      gateway: GATEWAY,
    });
    expect(planned.changes[0]?.path).toBe(
      fx.path("Roaming", "Block", "goose", "config", "custom_providers", "selfhost.json"),
    );
  });

  it("never replaces a provider file selfhost did not write", () => {
    const fx = fixtureHome();
    const mine = fx.write(".config/goose/custom_providers/selfhost.json", "{}\n");
    expect(statuses(connect(fx.home, "goose"))).toEqual({ gateway: "conflict" });
    expect(read(mine)).toBe("{}\n");
  });
});

describe("every agent", () => {
  it("writes only the agents' own config files and selfhost's record, and Cursor nothing", () => {
    const fx = fixtureHome();
    const changes = AGENT_IDS.flatMap((agent) => plan(fx.home, agent).changes);
    expect(changes.map((change) => change.path.slice(fx.home.length + 1)).sort()).toEqual([
      ".claude/settings.json",
      ".codex/config.toml",
      ".config/goose/custom_providers/selfhost.json",
      ".config/opencode/opencode.json",
      ".selfhost/agents/claude_code.gateway.json",
      ".selfhost/agents/codex.gateway.json",
      ".selfhost/agents/goose.gateway.json",
      ".selfhost/agents/opencode.gateway.json",
    ]);
    expect(plan(fx.home, "cursor").items).toEqual([
      expect.objectContaining({ item: "gateway", status: "unsupported" }),
    ]);
  });
});

describe("subscription logins", () => {
  const login = (agent: AgentId, home: string, extra: object = {}) =>
    subscriptionLogin(agent, { home, platform: "linux", ...extra });

  it("finds a Claude account login from its credentials file, keychain or token", () => {
    const fx = fixtureHome();
    expect(login("claude_code", fx.home)).toBeNull();
    expect(login("claude_code", fx.home, { env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } })).toMatchObject({
      source: "CLAUDE_CODE_OAUTH_TOKEN",
    });
    const mac = { platform: "darwin", keychain: (service: string) => service.startsWith("Claude") };
    expect(login("claude_code", fx.home, mac)).toMatchObject({
      source: "keychain item Claude Code-credentials",
    });
    const file = fx.write(".claude/.credentials.json", "{}");
    expect(login("claude_code", fx.home)).toMatchObject({ source: file });
  });

  it("tells a ChatGPT login in Codex's auth.json from an API key", () => {
    const fx = fixtureHome();
    const auth = fx.write(
      ".codex/auth.json",
      JSON.stringify({ OPENAI_API_KEY: "sk-x", tokens: null }),
    );
    expect(login("codex", fx.home)).toBeNull();
    fx.write(
      ".codex/auth.json",
      JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: "t" } }),
    );
    expect(login("codex", fx.home)).toEqual({ plan: "a ChatGPT plan", source: auth });
    fx.write(".codex/auth.json", JSON.stringify({ auth_mode: "apikey", tokens: {} }));
    expect(login("codex", fx.home)).toBeNull();
    fx.write(".codex/auth.json", JSON.stringify({ auth_mode: "chatgpt" }));
    expect(login("codex", fx.home)).not.toBeNull();
  });

  it("finds OAuth logins to Anthropic or OpenAI in OpenCode, not API keys", () => {
    const fx = fixtureHome();
    fx.write(
      ".local/share/opencode/auth.json",
      JSON.stringify({
        anthropic: { type: "api", key: "sk-ant" },
        "github-copilot": { type: "oauth" },
      }),
    );
    expect(login("opencode", fx.home)).toBeNull();
    fx.write(
      ".local/share/opencode/auth.json",
      JSON.stringify({ anthropic: { type: "oauth", refresh: "r", access: "a", expires: 1 } }),
    );
    expect(login("opencode", fx.home)).toMatchObject({ plan: "a Claude plan" });
  });

  it("has none for Goose and Cursor", () => {
    const fx = fixtureHome();
    expect(login("goose", fx.home)).toBeNull();
    expect(login("cursor", fx.home)).toBeNull();
  });
});
