import {
  EVENT_SCHEMA,
  type EventsPage,
  type LedgerEvent,
  type RunResponse,
  type UsageResponse,
} from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { raiseCacheAlerts } from "../src/cache-alerts.js";
import { startTestServer, type TestServer } from "./helpers.js";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const SESSION = "c4c4e1d0-5b7a-4f0e-9d2c-1a2b3c4d5e6f";

/** One Claude Code api_request log record, as its OpenTelemetry exporter sends it. */
function apiRequest(i: number, read: number, created: number, model = "claude-sonnet-4-5") {
  const ts = new Date(NOW.getTime() - (40 - i) * 60_000).toISOString();
  const attr = (key: string, value: string | number) => ({
    key,
    value: typeof value === "number" ? { intValue: value } : { stringValue: value },
  });
  return {
    timeUnixNano: String(BigInt(Date.parse(ts)) * 1_000_000n),
    body: { stringValue: "claude_code.api_request" },
    attributes: [
      attr("session.id", SESSION),
      attr("user.email", "ada@example.com"),
      attr("event.name", "api_request"),
      attr("event.timestamp", ts),
      attr("model", model),
      attr("input_tokens", 200),
      attr("output_tokens", 300),
      attr("cache_read_tokens", read),
      attr("cache_creation_tokens", created),
      attr("cost_usd", 0.2),
    ],
  };
}

const logs = (records: unknown[]) => ({
  resourceLogs: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
      scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events" }, logRecords: records }],
    },
  ],
});

let n = 0;
const cursorCost = (session: string): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  ts: "2026-11-09T10:00:00.000Z",
  source: "gateway",
  kind: "cost.recorded",
  actor: { kind: "person", id: "bo@example.com" },
  agent: { vendor: "cursor" },
  model: "gpt-5",
  session_id: session,
  cost: {
    input_tokens: 50_000,
    output_tokens: 100,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    usd: 0.5,
    estimated: true,
  },
});

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
  // 10 warm requests, then 22 that rewrite the whole cache: the hit rate collapses.
  const records = [
    apiRequest(0, 0, 20_000),
    ...Array.from({ length: 9 }, (_, i) => apiRequest(i + 1, 20_000, 0)),
    ...Array.from({ length: 22 }, (_, i) => apiRequest(i + 10, 0, 20_000)),
  ];
  const res = await server.request("/v1/otlp/v1/logs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(logs(records)),
  });
  expect(res.status).toBe(200);
  await server.ledger.append([cursorCost("cur-1"), cursorCost("cur-1")]);
});

afterAll(async () => {
  await server.ledger.close();
});

describe("cache hit rate in the API", () => {
  it("reports a rate per agent, and unknown (null) for an agent with no cache fields", async () => {
    const res = await server.request(
      `/v1/usage?group_by=agent&from=2026-11-09T00:00:00Z&to=2026-11-10T00:00:00Z`,
    );
    const body = (await res.json()) as UsageResponse;
    const rate = (agent: string) => body.rows.find((row) => row.group.agent === agent);
    const read = 9 * 20_000;
    const expected = read / (read + 32 * 200 + 23 * 20_000);
    expect(rate("claude_code")?.cache_hit_rate).toBeCloseTo(expected, 6);
    expect(rate("cursor")?.cache_hit_rate).toBeNull();
    // The total leaves the unknown session out instead of counting it as all misses.
    expect(body.total.cache_hit_rate).toBeCloseTo(expected, 6);
  });

  it("leaves the CSV cell empty when the rate is unknown", async () => {
    const res = await server.request(
      `/v1/usage.csv?group_by=agent&from=2026-11-09T00:00:00Z&to=2026-11-10T00:00:00Z`,
    );
    const lines = (await res.text()).trim().split("\r\n");
    const header = lines[0]?.split(",") ?? [];
    const column = header.indexOf("cache_hit_rate");
    expect(column).toBeGreaterThan(0);
    const cursor = lines.find((line) => line.startsWith("cursor,"))?.split(",");
    expect(cursor?.[column]).toBe("");
  });

  it("puts the run's rate and a one-line cost tip in the run view", async () => {
    const res = await server.request(`/v1/runs/${SESSION}`);
    const body = (await res.json()) as RunResponse;
    expect(body.run.cache_hit_rate).toBeLessThan(0.5);
    expect(body.run.cost_usd).toBeCloseTo(6.4, 6);
    expect(body.run.cache_tip).toMatch(/^Session c4c4e1d0 \(claude_code, ada@example\.com\) cost/);
    expect(body.run.cache_tip).toContain("such as a timestamp");
    const cursor = (await (await server.request("/v1/runs/cur-1")).json()) as RunResponse;
    expect(cursor.run.cache_hit_rate).toBeNull();
    expect(cursor.run.cache_tip).toBeNull();
  });
});

describe("cache alerts on the server", () => {
  it("raises one alert for the OpenTelemetry session whose hit rate collapsed", async () => {
    expect(await raiseCacheAlerts(server.ledger, NOW)).toBe(1);
    expect(await raiseCacheAlerts(server.ledger, new Date(NOW.getTime() + 60_000))).toBe(0);
    const res = await server.request("/v1/events?kind=alert.raised");
    const { events } = (await res.json()) as EventsPage;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "server",
      session_id: SESSION,
      agent: { vendor: "claude_code" },
      data: { alert: "cache_hit_low", owner: "ada@example.com", recent_hit_rate: 0, floor: 0.5 },
    });
    expect(String(events[0]?.data?.message)).toMatch(
      /value that changes early in the prompt \(such as a timestamp\), tool lists that reorder, or a model switch/,
    );
  });

  it("says nothing about sessions that ended over an hour ago", async () => {
    const later = new Date(NOW.getTime() + 3 * 60 * 60_000);
    expect(await raiseCacheAlerts(server.ledger, later)).toBe(0);
  });
});
