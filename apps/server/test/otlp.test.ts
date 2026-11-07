import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { mapOtelLogs } from "@selfhost/ledger";
import type { ApiError, EventsPage, LedgerEvent } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./helpers.js";

const OTEL_FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures", "sources", "otel");

const logs = JSON.parse(readFileSync(join(OTEL_FIXTURES, "claude-code-logs.json"), "utf8"));
const week: unknown[] = readFileSync(join(OTEL_FIXTURES, "claude-code-week.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));

const LOGS_SESSION = "a20d0d4b-8ee2-4416-b55d-ae9364eb8461";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.ledger.close();
});

const post = (signal: "logs" | "metrics", body: unknown, headers: Record<string, string> = {}) =>
  server.request(`/v1/otlp/v1/${signal}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body:
      typeof body === "string" || body instanceof Uint8Array
        ? (body as RequestInit["body"])
        : JSON.stringify(body),
  });

async function eventsWhere(query: string): Promise<LedgerEvent[]> {
  const res = await server.request(`/v1/events?${query}&limit=1000`);
  expect(res.status).toBe(200);
  return ((await res.json()) as EventsPage).events;
}

const ids = (events: LedgerEvent[]) => events.map((e) => e.id).sort();

describe("POST /v1/otlp/v1/logs", () => {
  it("maps the fixture logs to ledger events and stores them", async () => {
    const res = await post("logs", logs);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({});

    const stored = await eventsWhere(`session=${LOGS_SESSION}`);
    expect(ids(stored)).toEqual(ids(mapOtelLogs(logs)));
    expect(stored).toHaveLength(6);
    expect(stored.every((e) => e.source === "otel")).toBe(true);
  });

  it("stores a retried export once", async () => {
    const before = await eventsWhere(`session=${LOGS_SESSION}`);
    const res = await post("logs", logs);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(await eventsWhere(`session=${LOGS_SESSION}`)).toHaveLength(before.length);
  });

  it("accepts a gzipped body, as the collector sends by default", async () => {
    const day = week[0];
    const expected = mapOtelLogs(day);
    expect(expected.length).toBeGreaterThan(0);
    const res = await post("logs", gzipSync(JSON.stringify(day)), { "content-encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    const first = expected[0] as LedgerEvent;
    const stored = await eventsWhere(`session=${first.session_id}`);
    expect(stored.map((e) => e.id)).toEqual(expect.arrayContaining([first.id]));
  });

  it("stores a record sent twice in one request once", async () => {
    const [day] = week.slice(1, 2) as { resourceLogs: unknown[] }[];
    const doubled = { resourceLogs: [...(day?.resourceLogs ?? []), ...(day?.resourceLogs ?? [])] };
    const res = await post("logs", doubled);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    const expected = mapOtelLogs(day);
    const sessions = [...new Set(expected.map((e) => e.session_id))];
    const stored = (
      await Promise.all(sessions.map((session) => eventsWhere(`session=${session}`)))
    ).flat();
    expect(ids(stored)).toEqual(expect.arrayContaining(ids(expected)));
  });

  it("reports records the ledger refuses as a partial success and keeps the rest", async () => {
    const payload = structuredClone(logs);
    const session = "0b6a1f5e-6d1c-4c7a-9a55-6f0d2b1e9c11";
    const records = payload.resourceLogs[0].scopeLogs[0].logRecords as {
      attributes: { key: string; value: { stringValue?: string } }[];
    }[];
    for (const record of records) {
      for (const attr of record.attributes) {
        if (attr.key === "session.id") attr.value = { stringValue: session };
      }
    }
    records[0]?.attributes.push({ key: "event.timestamp", value: { stringValue: "yesterday" } });

    const res = await post("logs", payload);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      partialSuccess: { rejectedLogRecords: number; errorMessage: string };
    };
    expect(body.partialSuccess.rejectedLogRecords).toBe(1);
    expect(body.partialSuccess.errorMessage).toBe(
      "1 log record(s) rejected: ts: Expected a date-time string",
    );
    expect(await eventsWhere(`session=${session}`)).toHaveLength(5);
  });

  it("treats an empty export request as a success", async () => {
    for (const body of [{}, { resourceLogs: [] }]) {
      const res = await post("logs", body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
    }
  });

  it.each([
    ["a body that is not JSON", "{", {}, 400, "invalid_otlp", "Expected a JSON body"],
    [
      "a body that is not an object",
      "[]",
      {},
      400,
      "invalid_otlp",
      "Expected an OTLP export request object",
    ],
    [
      "resourceLogs that is not an array",
      JSON.stringify({ resourceLogs: {} }),
      {},
      400,
      "invalid_otlp",
      "Invalid OTLP logs payload: resourceLogs: Expected an ExportLogsServiceRequest with resourceLogs",
    ],
    [
      "a body that is not gzip",
      "{}",
      { "content-encoding": "gzip" },
      400,
      "invalid_otlp",
      "Body is not valid gzip",
    ],
    [
      "protobuf",
      "\n\0",
      { "content-type": "application/x-protobuf" },
      415,
      "unsupported_media_type",
      "Expected Content-Type application/json; set encoding: json on the exporter",
    ],
    [
      "an unsupported encoding",
      "{}",
      { "content-encoding": "br" },
      415,
      "unsupported_media_type",
      "Unsupported Content-Encoding br; use gzip or none",
    ],
  ])("rejects %s", async (_, body, headers, status, code, message) => {
    const res = await post("logs", body, headers as Record<string, string>);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: { code, message } });
  });

  it("refuses a gzipped body that expands past the size limit with 413", async () => {
    const bomb = gzipSync(Buffer.alloc(17 * 1024 * 1024, " "));
    const res = await post("logs", bomb, { "content-encoding": "gzip" });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiError).error.code).toBe("payload_too_large");
  });

  it("requires the bearer token", async () => {
    const res = await server.app.request("/v1/otlp/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(logs),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/otlp/v1/metrics", () => {
  const metrics = {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeMetrics: [
          {
            scope: { name: "com.anthropic.claude_code" },
            metrics: [
              {
                name: "claude_code.cost.usage",
                unit: "USD",
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      asDouble: 0.0841,
                      timeUnixNano: "1791295336204000000",
                      attributes: [{ key: "session.id", value: { stringValue: "metrics-only" } }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };

  it("accepts metrics and stores nothing", async () => {
    const res = await post("metrics", gzipSync(JSON.stringify(metrics)), {
      "content-encoding": "gzip",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(await eventsWhere("session=metrics-only")).toEqual([]);
  });

  it("rejects resourceMetrics that is not an array", async () => {
    const res = await post("metrics", { resourceMetrics: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid_otlp", message: "resourceMetrics: Expected an array" },
    });
  });
});
