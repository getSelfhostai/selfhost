import { parseConfig, type ResolvedSelfhostConfig, validateEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import {
  BUDGET_SPENT_ALERT,
  bifrostClient,
  issueKey,
  litellmClient,
  maskKeys,
  readUsage,
  syncGateway,
} from "../src/index.js";
import { fakeBifrost, fakeLiteLLM, readFixture } from "./fakes.js";

function policy(text: string): ResolvedSelfhostConfig {
  const parsed = parseConfig(`version = 1\n${text}`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
}

const HARD = policy(`
[budget]
mode = "hard"
daily_usd = 100
monthly_usd = 2000
run_usd = 5

[budget.person]
daily_usd = 50

[integrations.router]
tool = "bifrost"
providers = ["anthropic", "bedrock"]
`);
const ALERT = policy(`
[budget]
monthly_usd = 2000
`);
const NOW = new Date("2026-11-05T12:00:00Z");

function bifrost(fake = fakeBifrost()) {
  return {
    fake,
    client: bifrostClient({
      url: "http://bifrost:8080/",
      username: "selfhost",
      password: fake.password,
      fetch: fake.fetch,
      minIntervalMs: 0,
      now: () => NOW,
    }),
  };
}

describe("Bifrost keys and budgets", () => {
  it("issues a person key with the person's limits, the team's providers and its metadata", async () => {
    const { fake, client } = bifrost();
    const result = await issueKey(
      client,
      { kind: "person", team: "platform", person: "ada@example.com" },
      HARD,
    );
    if (!("issued" in result)) throw new Error("expected a new key");
    expect(result.issued.value).toMatch(/^sk-bf-/);
    expect(result.issued.key).toMatchObject({
      name: "selfhost:person:platform:ada@example.com",
      kind: "person",
      person: "ada@example.com",
      active: true,
      budgets: [{ period: "day", limit_usd: 50, spent_usd: 0 }],
      providers: ["anthropic", "bedrock"],
    });
    const team = [...fake.teams.values()][0];
    expect(team).toMatchObject({ name: "selfhost:platform" });
    const create = fake.calls.find(
      (c) => c.path === "/api/governance/virtual-keys" && c.method === "POST",
    );
    expect(create?.body).toMatchObject({
      team_id: team?.id,
      metadata: {
        selfhost_kind: "person",
        selfhost_team: "platform",
        selfhost_person: "ada@example.com",
      },
      budgets: [{ max_limit: 50, reset_duration: "1d", calendar_aligned: true }],
      allow_all_providers: false,
      provider_configs: [
        { provider: "anthropic", weight: 1 },
        { provider: "bedrock", weight: 0 },
      ],
    });
    // The team's own limits are on the gateway team.
    expect(
      fake.calls.find((c) => c.path === "/api/governance/teams" && c.method === "POST")?.body,
    ).toEqual({
      name: "selfhost:platform",
      budgets: [
        { max_limit: 100, reset_duration: "1d", calendar_aligned: true },
        { max_limit: 2000, reset_duration: "1M", calendar_aligned: true },
      ],
    });
  });

  it("refuses to issue a second key, rotates on request, and never lists values", async () => {
    const { client } = bifrost();
    const owner = { kind: "person" as const, team: "platform", person: "ada@example.com" };
    const first = await issueKey(client, owner, HARD);
    const again = await issueKey(client, owner, HARD);
    expect("exists" in again).toBe(true);
    const rotated = await issueKey(client, owner, HARD, { rotate: true });
    if (!("issued" in first) || !("issued" in rotated)) throw new Error("expected keys");
    expect(rotated.issued.key.id).toBe(first.issued.key.id);
    expect(rotated.issued.value).not.toBe(first.issued.value);
    expect(JSON.stringify(await client.keys())).not.toContain("sk-bf-");
  });

  it("gives a run key the run budget and a 24 hour life", async () => {
    const { fake, client } = bifrost();
    await issueKey(
      client,
      { kind: "run", team: "platform", person: "ben@example.com", run_id: "run-4821" },
      HARD,
    );
    const create = fake.calls.find((c) => c.path === "/api/governance/virtual-keys");
    expect(create?.body).toMatchObject({
      name: "selfhost:run:platform:run-4821",
      budgets: [{ max_limit: 5, reset_duration: "1Y", calendar_aligned: false }],
      expires_at: "2026-11-06T12:00:00.000Z",
      delete_after_expire: true,
    });
  });

  it("syncs idempotently: changes what differs, turns off people who left, then nothing", async () => {
    const { fake, client } = bifrost();
    for (const person of ["ada@example.com", "ben@example.com"]) {
      await issueKey(client, { kind: "person", team: "platform", person }, ALERT);
    }
    const inputs = [{ team: "platform", config: HARD, people: ["ada@example.com"] }];
    const first = await syncGateway(client, inputs, { now: () => NOW });
    expect(first.report).toMatchObject({ created: 0, updated: 2, deactivated: 1, errors: [] });
    const ben = [...fake.keys.values()].find((k) => String(k.name).endsWith("ben@example.com"));
    expect(ben?.is_active).toBe(false);
    const writes = fake.calls.filter((c) => c.method !== "GET").length;
    const second = await syncGateway(client, inputs, { now: () => NOW });
    expect(second.report).toMatchObject({ created: 0, updated: 0, deactivated: 0, unchanged: 3 });
    expect(fake.calls.filter((c) => c.method !== "GET").length).toBe(writes);
  });

  it("leaves keys it did not make alone", async () => {
    const { fake, client } = bifrost();
    fake.keys.set("vk-hand", { id: "vk-hand", name: "ci-bot", is_active: true, metadata: {} });
    await syncGateway(client, [{ team: "platform", config: HARD, people: [] }], { now: () => NOW });
    expect(fake.calls.some((c) => c.path.includes("vk-hand"))).toBe(false);
  });

  it("raises one alert per spent budget and window, with the person on it", async () => {
    const { fake, client } = bifrost();
    await issueKey(client, { kind: "person", team: "platform", person: "ada@example.com" }, HARD);
    const key = [...fake.keys.values()][0] as { budgets: { current_usage: number }[] };
    for (const budget of key.budgets) budget.current_usage = 50.4;
    const inputs = [{ team: "platform", config: HARD, people: ["ada@example.com"] }];
    const { alerts } = await syncGateway(client, inputs, { now: () => NOW });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "alert.raised",
      source: "gateway",
      team: "platform",
      actor: { kind: "person", id: "ada@example.com" },
      data: {
        alert: BUDGET_SPENT_ALERT,
        scope: "person",
        period: "day",
        limit_usd: 50,
        spent_usd: 50.4,
      },
    });
    const valid = validateEvent(alerts[0]);
    expect(valid.ok ? [] : valid.errors).toEqual([]);
    const later = await syncGateway(client, inputs, {
      now: () => new Date("2026-11-05T20:00:00Z"),
    });
    expect(later.alerts[0]?.id).toBe(alerts[0]?.id);
  });

  it("sends the admin credential only as basic auth, and reports health", async () => {
    const { fake, client } = bifrost();
    expect(await client.health()).toEqual({ ok: true });
    fake.setHealthy(false);
    expect((await client.health()).ok).toBe(false);
    const wrong = bifrostClient({
      url: "http://bifrost:8080",
      username: "selfhost",
      password: "nope",
      fetch: fake.fetch,
      minIntervalMs: 0,
    });
    await expect(wrong.teams()).rejects.toThrow(/answered 401/);
  });
});

describe("usage into the ledger", () => {
  it("reads Bifrost's request logs as gateway events and moves the window on", async () => {
    const fake = fakeBifrost({ logs: readFixture("sources", "gateway", "bifrost-logs.json") });
    const { client } = bifrost(fake);
    const written: string[] = [];
    const { report, next } = await readUsage(
      client,
      new Date("2026-11-05T00:00:00Z"),
      async (events) => {
        const fresh = events.filter((e) => !written.includes(e.id));
        written.push(...fresh.map((e) => e.id));
        return { accepted: fresh.length, duplicates: events.length - fresh.length };
      },
      { now: NOW },
    );
    expect(report).toMatchObject({ events: 4, duplicates: 0 });
    expect(next.toISOString()).toBe("2026-11-05T11:00:00.000Z");
    const logsCall = fake.calls.find((c) => c.path.startsWith("/api/logs"));
    expect(logsCall?.path).toContain("status=success%2Cerror");
    expect(logsCall?.path).toContain("order=asc");
  });

  it("starts again at the same place when the gateway refuses", async () => {
    const fake = fakeBifrost();
    const wrong = bifrostClient({
      url: "http://bifrost:8080",
      username: "selfhost",
      password: "wrong",
      fetch: fake.fetch,
      minIntervalMs: 0,
    });
    const from = new Date("2026-11-05T00:00:00Z");
    const result = await readUsage(wrong, from, async () => ({ accepted: 0, duplicates: 0 }), {
      now: NOW,
    });
    expect(result.report.error).toMatch(/401/);
    expect(result.next).toEqual(from);
  });
});

describe("LiteLLM", () => {
  const client = (fake = fakeLiteLLM()) => ({
    fake,
    client: litellmClient({
      url: "http://litellm:4000",
      masterKey: fake.masterKey,
      fetch: fake.fetch,
      minIntervalMs: 0,
    }),
  });

  it("issues a key on the team with one budget window, and syncs it like Bifrost", async () => {
    const { fake, client: llm } = client();
    const result = await issueKey(
      llm,
      { kind: "person", team: "platform", person: "ada@example.com" },
      HARD,
    );
    if (!("issued" in result)) throw new Error("expected a new key");
    expect(result.issued.value).toMatch(/^sk-litellm-/);
    expect(fake.calls.find((c) => c.path === "/team/new")?.body).toMatchObject({
      team_id: "selfhost-platform",
      team_alias: "platform",
      max_budget: 100,
      budget_duration: "1d",
    });
    expect(fake.calls.find((c) => c.path === "/key/generate")?.body).toMatchObject({
      key_alias: "selfhost:person:platform:ada@example.com",
      team_id: "selfhost-platform",
      user_id: "ada@example.com",
      max_budget: 50,
      budget_duration: "1d",
    });
    const sync = await syncGateway(llm, [{ team: "platform", config: HARD, people: [] }], {
      now: () => NOW,
    });
    expect(sync.report).toMatchObject({ deactivated: 1, errors: [] });
    expect(fake.calls.at(-1)).toMatchObject({ path: "/key/block" });
    const again = await syncGateway(llm, [{ team: "platform", config: HARD, people: [] }], {
      now: () => NOW,
    });
    expect(again.report).toMatchObject({ updated: 0, deactivated: 0 });
    expect(JSON.stringify(await llm.keys())).not.toContain("sk-litellm-");
  });

  it("maps spend log rows through the LiteLLM mapper, a refused request as a failure", async () => {
    const fake = fakeLiteLLM({
      spendLogs: readFixture("sources", "gateway", "litellm-spend-logs.json"),
    });
    const { client: llm } = client(fake);
    const events = [];
    for await (const page of llm.requests(new Date("2026-11-05T00:00:00Z"), NOW, 5))
      events.push(...page);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "cost.recorded",
      actor: { kind: "person", id: "ada@example.com" },
      agent: { vendor: "claude_code", version: "2.1.312" },
      team: "platform",
      session_id: "7c1e9a52-4b3d-4f6e-9a21-0d8c7b6e5f41",
      cost: { cache_read_tokens: 17920, usd: 0.0412 },
      data: { gateway: "litellm", key_alias: "selfhost:person:platform:ada@example.com" },
    });
    expect(events[1]).toMatchObject({
      kind: "alert.raised",
      data: { alert: "model_request_failed" },
    });
    expect(String(events[1]?.data?.error)).toContain("Budget has been exceeded");
    expect(fake.calls[0]?.path).toContain("start_date=2026-11-05+00%3A00%3A00");
  });
});

describe("errors", () => {
  it("never carry a key value", () => {
    expect(maskKeys("virtual key sk-bf-abcdef123456 is inactive")).toBe(
      "virtual key sk-bf... is inactive",
    );
    expect(maskKeys("bad key sk-1234567890abcdef")).toBe("bad key sk-123...");
  });
});
