import type {
  BudgetResponse,
  CreateTeamResponse,
  JoinResponse,
  LedgerEvent,
  TeamOverview,
  UsageResponse,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { BACKENDS, caller, TOKEN } from "./helpers.js";

/**
 * Bob's Claude Code goes through the team's gateway for session s-gw and straight to the vendor
 * for s-direct. Each s-gw request is in the ledger twice: from his session log (with the session)
 * and from the gateway's request log (without one, a few seconds earlier, at the gateway's
 * price). The token counts are a real pair from a dogfood run (fixtures/dogfood). Every spend
 * view counts each request once: the gateway's copy for s-gw, the log for s-direct.
 */

const NOW = new Date("2026-11-20T12:00:00.000Z");
const FROM = "2026-11-01T00:00:00.000Z";
const TO = "2026-11-21T00:00:00.000Z";
const BOB = "bob@example.com";

let n = 0;
const cost = (
  source: "local_log" | "gateway",
  ts: string,
  usd: number,
  tokens: { input: number; read: number; write: number; output: number },
  session?: string,
): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: "selfhost.event/v1",
  ts,
  source,
  kind: "cost.recorded",
  actor: { kind: "person", id: BOB },
  agent: { vendor: "claude_code" },
  model: source === "gateway" ? "claude-haiku-4-5" : "claude-haiku-4-5-20251001",
  ...(session ? { session_id: session } : {}),
  cost: {
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    cache_read_tokens: tokens.read,
    cache_write_tokens: tokens.write,
    usd,
    estimated: source !== "gateway",
  },
  data: { request_type: source === "gateway" ? "unknown" : "main" },
});

const FIRST = { input: 10, read: 0, write: 28443, output: 171 };
const SECOND = { input: 10, read: 24351, write: 4488, output: 236 };
const LOG = [
  cost("local_log", "2026-11-10T07:42:51.096Z", 0.03641875, FIRST, "s-gw"),
  cost("local_log", "2026-11-10T07:46:18.870Z", 0.0092351, SECOND, "s-gw"),
  cost("local_log", "2026-11-10T08:10:00.000Z", 0.5, { ...FIRST, output: 900 }, "s-direct"),
];
const GATEWAY = [
  cost("gateway", "2026-11-10T07:42:49.093Z", 0.0365, FIRST),
  cost("gateway", "2026-11-10T07:46:17.170Z", 0.0093, SECOND),
];
const COUNTED_USD = 0.0365 + 0.0093 + 0.5;

describe.each(BACKENDS)("a request in the gateway's log and a session log on $name", (backend) => {
  let store: Awaited<ReturnType<(typeof BACKENDS)[number]["open"]>>;
  let app: Hono;
  let admin: ReturnType<typeof caller>;

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    app = createApp({ version: "test", ledger: store.ledger, token: TOKEN, now: () => NOW });
    admin = caller(app, TOKEN);
    expect((await admin("/v1/orgs", "POST", { name: "Acme" })).status).toBe(201);
    const team = (await (
      await admin("/v1/teams", "POST", { name: "Marketing", org: "acme" })
    ).json()) as CreateTeamResponse;
    const joined = await app.request("/v1/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: team.invite, person: BOB }),
    });
    const bob = caller(app, ((await joined.json()) as JoinResponse).token);
    expect((await bob("/v1/events", "POST", { events: LOG })).status).toBe(200);
    // As the gateway's usage read writes them: by the team on each request's key.
    const written = await store.ledger.append(GATEWAY, { team: "marketing" });
    expect(written.accepted).toHaveLength(GATEWAY.length);
  });

  afterAll(async () => {
    await store?.close();
  });

  it.skipIf(backend.skip)("counts it once in usage, the overview and the budget", async () => {
    const usage = (await (
      await admin(`/v1/usage?org=acme&from=${FROM}&to=${TO}`)
    ).json()) as UsageResponse;
    expect(usage.total.requests).toBe(3);
    expect(usage.total.usd).toBeCloseTo(COUNTED_USD, 6);

    const overview = (await (
      await admin(`/v1/teams/marketing/overview?from=${FROM}&to=${TO}`)
    ).json()) as TeamOverview;
    expect(overview.spend.requests).toBe(3);
    expect(overview.spend.usd).toBeCloseTo(COUNTED_USD, 6);

    const budget = (await (
      await admin("/v1/budget?team=marketing&period=month")
    ).json()) as BudgetResponse;
    expect(budget.spent_usd).toBeCloseTo(COUNTED_USD, 6);
  });

  it.skipIf(backend.skip)("puts the gateway's copy in the log's session", async () => {
    const usage = (await (
      await admin(`/v1/usage?org=acme&from=${FROM}&to=${TO}&group_by=model`)
    ).json()) as UsageResponse;
    // The gateway's two requests under its model name, the direct one under the log's.
    expect(
      usage.rows.map((row) => [row.group.model, row.requests, Math.round(row.usd * 1e4) / 1e4]),
    ).toEqual([
      ["claude-haiku-4-5-20251001", 1, 0.5],
      ["claude-haiku-4-5", 2, 0.0458],
    ]);
    expect(usage.total.sessions).toBe(2);
  });
});
