import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { bifrostClient } from "@selfhost/gateway";
import { fakeBifrost } from "@selfhost/gateway/testing";
import { type Ledger, openLedger } from "@selfhost/ledger";
import type { CreateTeamResponse, GatewayStatus, JoinResponse } from "@selfhost/schema";
import { createApp } from "@selfhost/server/app";
import { parse as parseToml } from "smol-toml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConnectReport } from "../src/gateway/commands.js";
import {
  claudeManagedPath,
  connectKit,
  connectTarget,
  gatewaySpec,
} from "../src/gateway/connect.js";
import { run, tempDir } from "./run.js";

const SERVER = "http://team.test";
const ADMIN = "admin-token";

let ledger: Ledger;
let fetch: (url: string, init: RequestInit) => Promise<Response>;
let tokens: Record<string, string> = {};

beforeAll(async () => {
  ledger = await openLedger({ dataDir: "memory://" });
  const fake = fakeBifrost();
  const app = createApp({
    version: "test",
    ledger,
    token: ADMIN,
    gateway: {
      client: bifrostClient({
        url: "http://bifrost:8080",
        username: "selfhost",
        password: fake.password,
        fetch: fake.fetch,
        minIntervalMs: 0,
      }),
      baseUrl: "https://selfhost.example.com/llm",
      state: { sync: null, usage: null },
    },
  });
  fetch = async (url, init) => app.request(url, init);
  const json = { "content-type": "application/json" };
  const created = (await (
    await app.request(`${SERVER}/v1/teams`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, ...json },
      body: JSON.stringify({ name: "Platform" }),
    })
  ).json()) as CreateTeamResponse;
  tokens = {};
  const people = [
    ...["ada", "ben", "cy", "di", "ed", "flo", "gus", "hal", "ivy"],
    ...["jo", "kim", "lu", "max", "ned"],
  ];
  for (const person of people.map((name) => `${name}@example.com`)) {
    const res = await app.request(`${SERVER}/v1/join`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ invite: created.invite, person }),
    });
    tokens[person] = ((await res.json()) as JoinResponse).token;
  }
  await app.request(`${SERVER}/v1/policy`, {
    method: "PUT",
    headers: { authorization: `Bearer ${tokens["ada@example.com"]}`, ...json },
    body: JSON.stringify({
      text: 'version = 1\n[budget]\nmode = "hard"\nmonthly_usd = 500\n[budget.person]\ndaily_usd = 40\n',
    }),
  });
});

afterAll(async () => {
  await ledger.close();
});

function laptop(person: string) {
  const home = tempDir("gateway-home");
  const configPath = home.write(
    ".selfhost/config.json",
    JSON.stringify({ server: SERVER, token: tokens[person], person, team: "platform" }),
  );
  return { home, deps: { configPath, fetch, home: home.root } };
}

describe("selfhost gateway connect", () => {
  it("writes Claude Code's settings, keeps the rest, and disconnect restores the bytes", async () => {
    const { home, deps } = laptop("ada@example.com");
    const original = `${JSON.stringify({ model: "opus", env: { DISABLE_TELEMETRY: "1" } }, null, 2)}\n`;
    const settings = home.write(".claude/settings.json", original, 0o600);
    const result = await run(["gateway", "connect", "claude-code", "--json"], deps);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out) as ConnectReport;
    expect(report).toMatchObject({
      status: "connected",
      key: { person: "ada@example.com", budgets: [{ limit_usd: 40 }] },
      files: [
        { path: settings, action: "updated", backup: expect.stringContaining(".selfhost-backup-") },
      ],
    });
    expect(report.value).toMatch(/^sk-bf-/);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
      model: "opus",
      env: {
        DISABLE_TELEMETRY: "1",
        ANTHROPIC_BASE_URL: "https://selfhost.example.com/llm/anthropic",
        ANTHROPIC_AUTH_TOKEN: report.value,
      },
    });
    expect(statSync(settings).mode & 0o777).toBe(0o600);

    // Asking again reuses the key kept on this laptop: one key per person.
    const again = await run(["gateway", "connect", "claude-code", "--json"], deps);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({ reused: true, value: report.value });
    const kept = home.path(".selfhost/gateway-key.json");
    expect(statSync(kept).mode & 0o777).toBe(0o600);
    const rotated = await run(["gateway", "connect", "claude", "--rotate"], deps);
    expect(rotated.code).toBe(0);
    expect(rotated.out).toContain(`Updated ~/.claude/settings.json`);
    expect(JSON.parse(readFileSync(settings, "utf8")).env.ANTHROPIC_AUTH_TOKEN).not.toBe(
      report.value,
    );

    const undo = await run(["gateway", "disconnect", "claude-code"], deps);
    expect(undo.code).toBe(0);
    expect(undo.out).toContain("Restored ~/.claude/settings.json byte for byte");
    expect(readFileSync(settings, "utf8")).toBe(original);
    expect(existsSync(home.path(".selfhost/gateway-connect.json"))).toBe(false);
    expect(undo.out).toContain("Deleted ~/.selfhost/gateway-key.json");
    expect(existsSync(kept)).toBe(false);
    const nothing = await run(["gateway", "connect", "claude-code", "--undo"], deps);
    expect(nothing.out).toContain("Nothing to undo");
  });

  it("writes Codex, OpenCode and Goose settings, and disconnect puts every file back", async () => {
    const people = ["ben@example.com", "cy@example.com", "di@example.com"];
    const { home, deps } = laptop(people[0] as string);
    const codexToml = 'model = "gpt-5.5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n';
    const codex = home.write(".codex/config.toml", codexToml);
    const result = await run(["gateway", "connect", "codex"], deps);
    expect(result.code).toBe(0);
    const toml = parseToml(readFileSync(codex, "utf8")) as Record<string, unknown>;
    expect(toml.model_provider).toBe("selfhost");
    expect(toml.model_providers).toMatchObject({
      selfhost: {
        base_url: "https://selfhost.example.com/llm/openai/v1",
        experimental_bearer_token: expect.stringMatching(/^sk-bf-/),
      },
    });
    expect(toml.mcp_servers).toEqual({ docs: { command: "docs-mcp" } });
    expect(result.out).toContain("openai/gpt-5.5");

    // One laptop, the next person's key each time: a person's key is issued once.
    for (const [agent, person] of [
      ["opencode", people[1]],
      ["goose", people[2]],
    ] as const) {
      const other = laptop(person as string);
      const connected = await run(["gateway", "connect", agent, "--json"], {
        ...deps,
        configPath: other.deps.configPath,
      });
      expect(connected.code).toBe(0);
      expect(JSON.parse(connected.out)).toMatchObject({ status: "connected" });
    }
    const opencode = JSON.parse(readFileSync(home.path(".config/opencode/opencode.json"), "utf8"));
    expect(opencode.provider.anthropic.options.baseURL).toBe(
      "https://selfhost.example.com/llm/anthropic/v1",
    );
    const goose = home.path(".config/goose/custom_providers/selfhost.json");
    expect(JSON.parse(readFileSync(goose, "utf8")).headers.Authorization).toMatch(/^Bearer sk-bf-/);

    const dry = await run(["gateway", "disconnect", "--dry-run"], deps);
    expect(dry.out).toContain("Would restore ~/.codex/config.toml");
    expect(readFileSync(codex, "utf8")).not.toBe(codexToml);
    const undo = await run(["gateway", "disconnect", "--json"], deps);
    expect(JSON.parse(undo.out)).toMatchObject({ left: 0 });
    expect(readFileSync(codex, "utf8")).toBe(codexToml);
    expect(existsSync(home.path(".config/opencode/opencode.json"))).toBe(false);
    expect(existsSync(goose)).toBe(false);
  });

  it("connects a second agent with the same key, and rotate rewrites every agent", async () => {
    const { home, deps } = laptop("jo@example.com");
    const settings = home.write(".claude/settings.json", "{}\n");
    const first = JSON.parse(
      (await run(["gateway", "connect", "claude-code", "--json"], deps)).out,
    );
    const codex = await run(["gateway", "connect", "codex", "--json"], deps);
    expect(codex.code).toBe(0);
    const second = JSON.parse(codex.out) as ConnectReport;
    expect(second).toMatchObject({ status: "connected", reused: true, value: first.value });
    const codexToml = () => {
      const toml = parseToml(readFileSync(home.path(".codex/config.toml"), "utf8")) as {
        model_providers: { selfhost: { experimental_bearer_token: string } };
      };
      return toml.model_providers.selfhost.experimental_bearer_token;
    };
    expect(codexToml()).toBe(first.value);
    const env = await run(["gateway", "connect", "env"], deps);
    expect(env.code).toBe(0);
    expect(env.out).toContain(`export OPENAI_API_KEY=${first.value}`);
    expect(env.out).toContain("the one your other agents here use");

    const rotated = JSON.parse(
      (await run(["gateway", "connect", "codex", "--rotate", "--json"], deps)).out,
    ) as ConnectReport;
    expect(rotated.value).not.toBe(first.value);
    expect(codexToml()).toBe(rotated.value);
    expect(JSON.parse(readFileSync(settings, "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe(rotated.value);
    expect(rotated.files.map((file) => file.path)).toContain(settings);
    expect(rotated.notes.join(" ")).toContain("old value no longer works");

    // Disconnecting both puts each file back and drops the kept key.
    const undo = await run(["gateway", "disconnect"], deps);
    expect(readFileSync(settings, "utf8")).toBe("{}\n");
    expect(undo.out).toContain("Deleted ~/.selfhost/gateway-key.json");
    const again = await run(["gateway", "connect", "codex"], deps);
    expect(again.code).toBe(1);
    expect(again.err).toContain("not kept on this laptop");
    expect(again.err).toContain("--rotate");
  });

  it("refuses to rotate while a connected agent's settings can't take the new value", async () => {
    const { home, deps } = laptop("kim@example.com");
    const settings = home.write(".claude/settings.json", "{}\n");
    expect((await run(["gateway", "connect", "claude-code"], deps)).code).toBe(0);
    const held = JSON.parse(readFileSync(settings, "utf8"));
    writeFileSync(settings, JSON.stringify({ ...held, apiKeyHelper: "~/bin/key.sh" }));
    const before = readFileSync(settings, "utf8");
    const refused = await run(["gateway", "connect", "env", "--rotate"], deps);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("key was not rotated");
    expect(refused.err).toContain("Claude Code");
    expect(refused.err).toContain("apiKeyHelper");
    expect(readFileSync(settings, "utf8")).toBe(before);
    // The old value still works: the gateway key was not touched.
    expect((await run(["gateway", "connect", "env"], deps)).out).toContain(
      held.env.ANTHROPIC_AUTH_TOKEN,
    );
  });

  it("warns that ANTHROPIC_API_KEY in the shell would go past the gateway", async () => {
    const { deps } = laptop("lu@example.com");
    const env = { ANTHROPIC_API_KEY: "sk-ant-mine" };
    const printed = await run(["gateway", "connect", "claude-code", "--print"], { ...deps, env });
    expect(printed.code).toBe(0);
    expect(printed.out.split("\n")[0]).toMatch(/^Warning: ANTHROPIC_API_KEY is set in your shell/);
    expect(printed.out).toContain("outside the gateway's budgets");
    const json = await run(["gateway", "connect", "claude-code", "--json"], { ...deps, env });
    expect((JSON.parse(json.out) as ConnectReport).warnings).toHaveLength(1);
    const codex = await run(["gateway", "connect", "codex", "--print"], { ...deps, env });
    expect(codex.out).not.toContain("Warning:");
  });

  it("lists the gateway's models for Goose and removes the folder it made on disconnect", async () => {
    const { home, deps } = laptop("max@example.com");
    home.write(".config/goose/config.yaml", "GOOSE_PROVIDER: anthropic\n");
    const models: (url: string, init: RequestInit) => Promise<Response> = async (url, init) =>
      url === "https://selfhost.example.com/llm/openai/v1/models"
        ? Response.json({ data: [{ id: "openai/gpt-5.5" }, { id: "anthropic/claude-opus-4" }] })
        : fetch(url, init);
    const result = await run(["gateway", "connect", "goose"], { ...deps, fetch: models });
    expect(result.code).toBe(0);
    const file = home.path(".config/goose/custom_providers/selfhost.json");
    expect(JSON.parse(readFileSync(file, "utf8")).models).toEqual([
      { name: "anthropic/claude-opus-4", context_limit: 128_000 },
      { name: "openai/gpt-5.5", context_limit: 128_000 },
    ]);
    await run(["gateway", "disconnect", "goose"], deps);
    expect(existsSync(home.path(".config/goose/custom_providers"))).toBe(false);
    expect(existsSync(home.path(".config/goose/config.yaml"))).toBe(true);

    // No model list from the gateway: Bifrost's names for the defaults, never an empty list.
    const other = laptop("ned@example.com");
    const plain = await run(["gateway", "connect", "goose"], other.deps);
    expect(plain.out).toContain("did not list its models");
    const written = JSON.parse(
      readFileSync(other.home.path(".config/goose/custom_providers/selfhost.json"), "utf8"),
    );
    expect(written.models.map((m: { name: string }) => m.name)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5.5",
    ]);
    await run(["gateway", "disconnect"], other.deps);
    expect(existsSync(other.home.path(".config"))).toBe(false);
  });

  it("leaves a file changed since connect as it is, and says where the backup is", async () => {
    const { home, deps } = laptop("ed@example.com");
    const settings = home.write(".claude/settings.json", '{"model":"opus"}\n');
    expect((await run(["gateway", "connect", "claude-code"], deps)).code).toBe(0);
    writeFileSync(settings, '{"model":"sonnet"}\n');
    const undo = await run(["gateway", "disconnect", "claude-code"], deps);
    expect(undo.out).toMatch(
      /Left ~\/\.claude\/settings\.json as is: changed since .*selfhost-backup-/,
    );
    expect(readFileSync(settings, "utf8")).toBe('{"model":"sonnet"}\n');
  });

  it("changes nothing for an agent signed in with a subscription, unless asked", async () => {
    const { home, deps } = laptop("flo@example.com");
    home.write(".claude/.credentials.json", "{}");
    const result = await run(["gateway", "connect", "claude-code", "--json"], deps);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out) as ConnectReport;
    expect(report).toMatchObject({ status: "subscription", key: null, value: null, files: [] });
    expect(report.notes.join(" ")).toContain("straight to the vendor");
    expect(existsSync(home.path(".claude/settings.json"))).toBe(false);

    // No key was issued, so this needs no --rotate.
    const anyway = await run(["gateway", "connect", "claude-code", "--api-billing"], deps);
    expect(anyway.code).toBe(0);
    expect(existsSync(home.path(".claude/settings.json"))).toBe(true);
  });

  it("issues no key when it could not write the settings", async () => {
    const { home, deps } = laptop("gus@example.com");
    const text = '{"apiKeyHelper":"~/bin/key.sh"}';
    const settings = home.write(".claude/settings.json", text);
    const blocked = await run(["gateway", "connect", "claude-code"], deps);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("no key was issued");
    expect(blocked.err).toContain("apiKeyHelper");
    expect(readFileSync(settings, "utf8")).toBe(text);
    writeFileSync(settings, "{}");
    expect((await run(["gateway", "connect", "claude-code"], deps)).code).toBe(0);
  });

  it("says Cursor and Copilot usage comes from admin APIs, and changes nothing", async () => {
    const { home, deps } = laptop("hal@example.com");
    for (const agent of ["cursor", "copilot"]) {
      const result = await run(["gateway", "connect", agent, "--json"], deps);
      expect(result.code).toBe(0);
      const report = JSON.parse(result.out) as ConnectReport;
      expect(report).toMatchObject({ status: "not_applicable", key: null });
      expect(report.notes[0]).toContain("admin API");
    }
    expect(existsSync(home.path(".cursor"))).toBe(false);
    expect(() => connectTarget("windsurf")).toThrow(/expected claude-code/);
    // hal's key is still unissued.
    expect((await run(["gateway", "connect", "env"], deps)).out).toContain(
      "export OPENAI_BASE_URL=https://selfhost.example.com/llm/openai/v1",
    );
  });

  it("prints a managed settings file for Claude Code, and prints for --print", async () => {
    const { home, deps } = laptop("ivy@example.com");
    const managed = await run(["gateway", "connect", "claude-code", "--managed"], deps);
    expect(managed.code).toBe(0);
    expect(managed.out).toContain("/etc/claude-code/managed-settings.d/selfhost-gateway.json");
    expect(managed.out).toContain('"ANTHROPIC_AUTH_TOKEN": "sk-bf-');
    expect(existsSync(home.path(".claude"))).toBe(false);
    expect(claudeManagedPath("darwin")).toBe(
      "/Library/Application Support/ClaudeCode/managed-settings.d/selfhost-gateway.json",
    );
    const printed = await run(["gateway", "connect", "goose", "--print", "--rotate"], deps);
    expect(printed.out).toContain('"requires_auth": false');
    expect(existsSync(home.path(".config/goose"))).toBe(false);
  });

  it("points LiteLLM agents at its root", () => {
    const kit = connectKit(
      "env",
      "litellm",
      gatewaySpec("litellm", "https://litellm.example.com/", "sk-x"),
    );
    expect(kit.text).toContain("ANTHROPIC_BASE_URL=https://litellm.example.com\n");
    expect(kit.text).toContain("OPENAI_BASE_URL=https://litellm.example.com/v1\n");
  });
});

describe("selfhost gateway status and keys", () => {
  it("shows the limits and what is left, never a key's value", async () => {
    const { deps } = laptop("ada@example.com");
    const status = await run(["gateway", "--json"], deps);
    const parsed = JSON.parse(status.out) as GatewayStatus;
    expect(parsed).toMatchObject({
      tool: "bifrost",
      mode: "hard",
      key: { person: "ada@example.com" },
    });
    const text = await run(["gateway"], deps);
    expect(text.out).toContain("$40.00 a day, $0.00 spent, $40.00 left");
    expect(text.out).toContain("cannot be stopped from outside");
    const keys = await run(["gateway", "keys"], deps);
    expect(keys.code).toBe(0);
    expect(keys.out).toContain("selfhost:person:platform:ada@example.com");
    expect(`${status.out}${text.out}${keys.out}`).not.toContain("sk-bf-");
  });

  it("refuses the key list to members", async () => {
    const { deps } = laptop("ben@example.com");
    const keys = await run(["gateway", "keys"], deps);
    expect(keys.code).toBe(1);
    expect(keys.err).toContain("Permission denied");
  });

  it("needs a team", async () => {
    const home = tempDir("gateway-solo");
    const configPath = home.path("config.json");
    writeFileSync(configPath, "{}");
    const result = await run(["gateway"], { configPath, fetch });
    expect(result.err).toContain("not in a team");
  });
});
