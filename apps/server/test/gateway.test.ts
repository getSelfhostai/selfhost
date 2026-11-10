import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { bifrostClient } from "@selfhost/gateway";
import { fakeBifrost } from "@selfhost/gateway/testing";
import { type Ledger, openLedger } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  type BudgetResponse,
  type CreateTeamResponse,
  type GatewayKeysResponse,
  type GatewayStatus,
  type GatewaySyncReport,
  type IssueGatewayKeyResponse,
  type JoinResponse,
  parseConfig,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  type Gateway,
  gatewayFromEnv,
  readUsageNow,
  startGatewayJob,
  syncNow,
} from "../src/gateway.js";
import { caller, TOKEN } from "./helpers.js";

const LOGS = JSON.parse(
  readFileSync(
    pathJoin(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "fixtures",
      "sources",
      "gateway",
      "bifrost-logs.json",
    ),
    "utf8",
  ),
);

const POLICY = `version = 1

[budget]
mode = "hard"
monthly_usd = 2000

[budget.person]
daily_usd = 50
`;

let ledger: Ledger;
let app: Hono;
let fake: ReturnType<typeof fakeBifrost>;
let gateway: Gateway;
const admin = () => caller(app, TOKEN);

async function joinTeam(invite: string, person: string): Promise<string> {
  const res = await app.request("/v1/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite, person }),
  });
  const body = (await res.json()) as JoinResponse;
  if (res.status !== 200) throw new Error(`join ${person}: ${res.status} ${JSON.stringify(body)}`);
  return body.token;
}

/** A fresh in-memory server and fake Bifrost for each test of the calling describe. */
function withServer() {
  beforeEach(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    fake = fakeBifrost({ logs: LOGS });
    gateway = {
      client: bifrostClient({
        url: "http://bifrost:8080",
        username: "selfhost",
        password: fake.password,
        fetch: fake.fetch,
        minIntervalMs: 0,
      }),
      baseUrl: "https://selfhost.example.com/llm",
      state: { sync: null, usage: null },
    };
    app = createApp({ version: "1.2.3", ledger, token: TOKEN, gateway });
  });

  afterEach(async () => {
    await ledger.close();
  });
}

async function platform() {
  const created = (await (
    await admin()("/v1/teams", "POST", { name: "Platform" })
  ).json()) as CreateTeamResponse;
  const ada = await joinTeam(created.invite, "ada@example.com");
  const ben = await joinTeam(created.invite, "ben@example.com");
  const put = await caller(app, ada)("/v1/policy", "PUT", { text: POLICY });
  expect(put.status, await put.text()).toBe(200);
  return { ada, ben };
}

describe("gateway keys", () => {
  withServer();

  it("issues a person's key to that person once, with their limits, and never lists its value", async () => {
    const { ada } = await platform();
    const res = await caller(app, ada)("/v1/gateway/keys", "POST", {});
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const issued = (await res.json()) as IssueGatewayKeyResponse;
    expect(issued).toMatchObject({
      tool: "bifrost",
      base_url: "https://selfhost.example.com/llm",
      key: {
        name: "selfhost:person:platform:ada@example.com",
        person: "ada@example.com",
        budgets: [{ period: "day", limit_usd: 50 }],
      },
    });
    expect(issued.value).toMatch(/^sk-bf-/);

    const again = await caller(app, ada)("/v1/gateway/keys", "POST", {});
    expect(again.status).toBe(409);
    const rotated = await caller(app, ada)("/v1/gateway/keys", "POST", { rotate: true });
    expect(((await rotated.json()) as IssueGatewayKeyResponse).value).not.toBe(issued.value);

    const status = (await (await caller(app, ada)("/v1/gateway")).json()) as GatewayStatus;
    expect(status).toMatchObject({
      tool: "bifrost",
      healthy: true,
      team: "platform",
      mode: "hard",
      key: { person: "ada@example.com" },
      team_budgets: [{ period: "month", limit_usd: 2000 }],
    });
    expect(status.notes.join(" ")).toContain("Subscription logins");
    const listed = await (await admin()("/v1/gateway/keys?team=platform")).text();
    expect((JSON.parse(listed) as GatewayKeysResponse).keys).toHaveLength(1);
    expect(listed).not.toContain("sk-bf-");
    expect(JSON.stringify(status)).not.toContain("sk-bf-");
  });

  it("gives a person's key to nobody else, and team keys only to owners and admins", async () => {
    const { ben } = await platform();
    const asAdmin = await admin()("/v1/gateway/keys", "POST", { team: "platform" });
    expect(asAdmin.status).toBe(403);
    // ada joined first and owns the team; ben is a member.
    expect((await caller(app, ben)("/v1/gateway/keys", "POST", { kind: "team" })).status).toBe(403);
    expect((await caller(app, ben)("/v1/gateway/keys")).status).toBe(403);
    const team = await admin()("/v1/gateway/keys", "POST", { kind: "team", team: "platform" });
    expect(team.status).toBe(201);
    const run = await caller(app, ben)("/v1/gateway/keys", "POST", {
      kind: "run",
      run_id: "run-1",
    });
    expect(((await run.json()) as IssueGatewayKeyResponse).key).toMatchObject({
      kind: "run",
      run_id: "run-1",
      person: "ben@example.com",
    });
  });

  it("answers 404 without a gateway and 502 when the gateway refuses", async () => {
    const plain = createApp({ version: "1.2.3", ledger, token: TOKEN });
    expect((await caller(plain, TOKEN)("/v1/gateway?team=x")).status).toBe(404);
    const { ada } = await platform();
    gateway.client = bifrostClient({
      url: "http://bifrost:8080",
      username: "selfhost",
      password: "wrong",
      fetch: fake.fetch,
      minIntervalMs: 0,
    });
    const res = await caller(app, ada)("/v1/gateway/keys", "POST", {});
    expect(res.status).toBe(502);
  });
});

describe("gateway sync and usage", () => {
  withServer();

  it("syncs only with the admin token, turns off keys of people revoked, and records usage", async () => {
    const { ada, ben } = await platform();
    await caller(app, ben)("/v1/gateway/keys", "POST", {});
    expect((await caller(app, ada)("/v1/gateway/sync", "POST")).status).toBe(403);
    const revoked = await admin()("/v1/teams/platform/people/ben%40example.com/tokens", "DELETE");
    expect(revoked.status).toBe(200);

    const first = (await (await admin()("/v1/gateway/sync", "POST")).json()) as GatewaySyncReport;
    expect(first).toMatchObject({ deactivated: 1, errors: [] });
    expect([...fake.keys.values()][0]?.is_active).toBe(false);
    const second = (await (await admin()("/v1/gateway/sync", "POST")).json()) as GatewaySyncReport;
    expect(second).toMatchObject({ created: 0, updated: 0, deactivated: 0 });

    const now = () => new Date("2026-11-05T19:00:00Z");
    const usage = await readUsageNow(ledger, gateway, now);
    expect(usage).toMatchObject({ events: 4, duplicates: 0, from: "2026-11-04T19:00:00.000Z" });
    gateway.state.usageFrom = undefined;
    const reread = await readUsageNow(ledger, gateway, now);
    expect(reread).toMatchObject({ events: 0, duplicates: 4, from: "2026-11-05T17:05:30.100Z" });

    const page = await ledger.query({ team: "platform", kind: "cost.recorded" });
    expect(page.events.map((e) => e.actor.id).sort()).toEqual([
      "ada@example.com",
      "ben@example.com",
    ]);
    expect(page.events.every((e) => e.source === "gateway")).toBe(true);
  });

  it("records a spent budget as an alert once", async () => {
    const { ada } = await platform();
    await caller(app, ada)("/v1/gateway/keys", "POST", {});
    for (const key of fake.keys.values()) {
      for (const budget of key.budgets as { current_usage: number }[]) budget.current_usage = 51;
    }
    const now = () => new Date("2026-11-05T12:00:00Z");
    expect((await syncNow(ledger, gateway, now)).alerts).toBe(1);
    expect((await syncNow(ledger, gateway, now)).alerts).toBe(0);
    const alerts = await ledger.query({ team: "platform", kind: "alert.raised" });
    expect(alerts.events[0]).toMatchObject({
      actor: { id: "ada@example.com" },
      data: { alert: "budget_exceeded", period: "day", limit_usd: 50, spent_usd: 51 },
    });
  });
});

describe("budgets the gateway holds", () => {
  withServer();

  it("pushes a changed budget to the gateway at once, not at the next periodic sync", async () => {
    const log: string[] = [];
    const job = startGatewayJob(ledger, gateway, {
      intervalMs: 60 * 60 * 1000,
      log: (line) => log.push(line),
    });
    try {
      await job.run();
      const { ada } = await platform();
      const budgetsOf = () => [...fake.teams.values()].map((team) => team.budgets);
      await job.push();
      expect(budgetsOf()).toEqual([[expect.objectContaining({ max_limit: 2000 })]]);
      const raised = POLICY.replace("monthly_usd = 2000", "monthly_usd = 3000");
      expect((await caller(app, ada)("/v1/policy", "PUT", { text: raised })).status).toBe(200);
      // The PUT started the push; waiting on another one waits for it too.
      await job.push();
      expect(budgetsOf()).toEqual([[expect.objectContaining({ max_limit: 3000 })]]);
      expect(log.filter((line) => line.includes("error"))).toEqual([]);
    } finally {
      job.stop();
    }
    expect(gateway.policyChanged).toBeUndefined();
  });

  it("reports every budget that applies to a person, and the one cutting them off", async () => {
    const { ada } = await platform();
    await caller(app, ada)("/v1/gateway/keys", "POST", {});
    for (const key of fake.keys.values()) {
      for (const budget of key.budgets as { current_usage: number }[]) budget.current_usage = 51;
    }
    const org = await admin()("/v1/orgs/default/policy", "PUT", {
      text: "version = 1\n[budget]\nmonthly_usd = 10000\n",
    });
    expect(org.status).toBe(200);

    const res = await caller(app, ada)("/v1/budget?period=day&person=ada%40example.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as BudgetResponse;
    // The person's own daily budget, not null as before.
    expect(body).toMatchObject({ period: "day", limit_usd: 50 });
    expect(
      body.budgets?.map((b) => [b.scope, b.owner, b.period, b.enforcement, b.cut_off]),
    ).toEqual([
      ["person", "ada@example.com", "day", "gateway", true],
      ["team", "platform", "month", "gateway", false],
      ["org", "default", "month", "alert", false],
    ]);
    const [person, , orgLine] = body.budgets ?? [];
    expect(person).toMatchObject({ limit_usd: 50, spent_usd: 51, remaining_usd: 0 });
    expect(person?.raise).toContain("[budget.person] daily_usd");
    expect(orgLine?.raise).toContain("org default");

    // Without person a person token still gets its own budget, next to the team's.
    const mine = (await (await caller(app, ada)("/v1/budget")).json()) as BudgetResponse;
    expect(mine).toMatchObject({ period: "month", limit_usd: 2000 });
    expect(mine.budgets?.[0]).toMatchObject({ scope: "person", cut_off: true });

    // An alert-only [budget] is said to be one: nothing stops requests.
    const soft = POLICY.replace('mode = "hard"', 'mode = "alert"');
    expect((await caller(app, ada)("/v1/policy", "PUT", { text: soft })).status).toBe(200);
    const alertOnly = (await (await caller(app, ada)("/v1/budget")).json()) as BudgetResponse;
    expect(alertOnly.budgets?.filter((b) => b.scope !== "org").map((b) => b.enforcement)).toEqual([
      "alert",
      "alert",
    ]);
    expect(alertOnly.budgets?.some((b) => b.cut_off)).toBe(false);
  });

  it("names the person whose gateway budget is spent in the item the owners read", async () => {
    const { ada } = await platform();
    await caller(app, ada)("/v1/gateway/keys", "POST", {});
    for (const key of fake.keys.values()) {
      for (const budget of key.budgets as { current_usage: number }[]) budget.current_usage = 51;
    }
    const now = () => new Date("2026-11-05T12:00:00Z");
    expect((await syncNow(ledger, gateway, now)).alerts).toBe(1);
    const list = openReviewList(ledger, { now });
    await refreshReviewList(ledger, list);
    const { items } = await list.list({});
    expect(items.map((item) => item.title)).toEqual([
      "ada@example.com spent the day's gateway budget of $50",
    ]);
  });
});

describe("gatewayFromEnv", () => {
  const config = (text = "version = 1\n") => {
    const parsed = parseConfig(text);
    if (!parsed.ok) throw new Error("bad config");
    return parsed.config;
  };

  it("is off without [integrations.router] or SELFHOST_GATEWAY_TOOL", () => {
    expect(gatewayFromEnv(config(), {})).toBeUndefined();
    // compose.yml passes them through empty when they are not set.
    expect(
      gatewayFromEnv(config(), { SELFHOST_GATEWAY_TOOL: "", SELFHOST_GATEWAY_URL: "" }),
    ).toBeUndefined();
  });

  it("points at a LiteLLM from the environment, as compose.yml passes it", () => {
    const found = gatewayFromEnv(config(), {
      SELFHOST_GATEWAY_TOOL: "litellm",
      SELFHOST_GATEWAY_URL: "http://litellm:4000",
      SELFHOST_GATEWAY_PUBLIC_URL: "",
      SELFHOST_GATEWAY_ADMIN_KEY: "sk-master",
    });
    expect(found?.client.tool).toBe("litellm");
    expect(found?.baseUrl).toBe("http://litellm:4000");
  });

  it("uses the bundled Bifrost behind the public URL, and needs its admin key", () => {
    const env = { SELFHOST_GATEWAY_TOOL: "bifrost", SELFHOST_PUBLIC_URL: "https://s.example.com/" };
    expect(() => gatewayFromEnv(config(), env)).toThrow(/SELFHOST_GATEWAY_ADMIN_KEY/);
    const found = gatewayFromEnv(config(), { ...env, SELFHOST_GATEWAY_ADMIN_KEY: "k" });
    expect(found?.client.tool).toBe("bifrost");
    expect(found?.baseUrl).toBe("https://s.example.com/llm");
  });

  it("points at a team's own LiteLLM from the config, with its master key env", () => {
    const text = `version = 1
[integrations.router]
tool = "litellm"
url = "https://litellm.internal.example.com"
admin_key_env = "LITELLM_MASTER_KEY"
`;
    expect(() => gatewayFromEnv(config(text), {})).toThrow(/LITELLM_MASTER_KEY/);
    const found = gatewayFromEnv(config(text), { LITELLM_MASTER_KEY: "sk-x" });
    expect(found?.client.tool).toBe("litellm");
    expect(found?.baseUrl).toBe("https://litellm.internal.example.com");
  });
});
