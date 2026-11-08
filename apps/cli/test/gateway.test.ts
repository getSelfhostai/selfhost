import { readFileSync, statSync, writeFileSync } from "node:fs";
import { bifrostClient } from "@selfhost/gateway";
import { fakeBifrost } from "@selfhost/gateway/testing";
import { type Ledger, openLedger } from "@selfhost/ledger";
import type { CreateTeamResponse, GatewayStatus, JoinResponse } from "@selfhost/schema";
import { createApp } from "@selfhost/server/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConnectReport } from "../src/gateway/commands.js";
import { connectAgent, connectKit } from "../src/gateway/connect.js";
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
  for (const person of ["ada@example.com", "ben@example.com"]) {
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
  it("issues the key once and writes Claude Code's settings, keeping the rest", async () => {
    const { home, deps } = laptop("ada@example.com");
    const settings = home.write(
      ".claude/settings.json",
      JSON.stringify({ model: "opus", env: { ANTHROPIC_API_KEY: "old", DISABLE_TELEMETRY: "1" } }),
    );
    const result = await run(["gateway", "connect", "claude-code", "--write", "--json"], deps);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out) as ConnectReport;
    expect(report.value).toMatch(/^sk-bf-/);
    expect(report.key).toMatchObject({ person: "ada@example.com", budgets: [{ limit_usd: 40 }] });
    const written = JSON.parse(readFileSync(settings, "utf8"));
    expect(written).toEqual({
      model: "opus",
      env: {
        DISABLE_TELEMETRY: "1",
        ANTHROPIC_BASE_URL: "https://selfhost.example.com/llm/anthropic",
        ANTHROPIC_AUTH_TOKEN: report.value,
      },
    });
    expect(statSync(settings).mode & 0o777).toBe(0o600);

    const again = await run(["gateway", "connect", "claude-code"], deps);
    expect(again.code).toBe(1);
    expect(again.err).toContain("--rotate");
  });

  it("prints Codex settings that read the key from the environment", async () => {
    const { deps } = laptop("ben@example.com");
    const result = await run(["gateway", "connect", "codex"], deps);
    expect(result.code).toBe(0);
    expect(result.out).toContain('base_url = "https://selfhost.example.com/llm/openai/v1"');
    expect(result.out).toContain('env_key = "SELFHOST_GATEWAY_KEY"');
    expect(result.out).toMatch(/export SELFHOST_GATEWAY_KEY=sk-bf-/);
    expect(result.out).toContain("subscription login");
  });

  it("says which agents cannot use a gateway", async () => {
    expect(() => connectAgent("cursor")).toThrow(/own servers/);
    expect(connectAgent("claude")).toBe("claude-code");
    const { deps } = laptop("ben@example.com");
    const result = await run(["gateway", "connect", "copilot"], deps);
    expect(result.code).toBe(1);
    expect(result.err).toContain("cannot use the gateway");
  });

  it("points LiteLLM agents at its root", () => {
    const kit = connectKit("env", "litellm", "https://litellm.example.com/", "sk-x");
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
