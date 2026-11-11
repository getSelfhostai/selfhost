import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  type ApiError,
  createValidator,
  EVENT_SCHEMA,
  type EventSchemaVersion,
  type EventsPage,
  EventsPageSchema,
  type IngestEventsError,
  IngestEventsErrorSchema,
  IngestEventsResponseSchema,
  type LedgerEvent,
} from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { startTestServer, type TestServer, TOKEN } from "./helpers.js";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.ledger.close();
});

let next = 1;
function makeEvent(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  const n = next++;
  return {
    id: `01930c4e-2f1a-7b2c-8d3e-${n.toString(16).padStart(12, "0")}`,
    schema: "selfhost.event/v1",
    ts: `2026-11-07T09:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z`,
    source: "hook",
    kind: "session.started",
    actor: { kind: "person", id: "alice@example.com" },
    ...overrides,
  };
}

const post = (body: unknown) =>
  server.request("/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const matches = (schema: Parameters<typeof createValidator>[0], body: unknown) => {
  const result = createValidator(schema).validate(body);
  expect(result.ok ? [] : result.errors).toEqual([]);
};

describe("POST /v1/events", () => {
  it("stores a batch and counts accepted and duplicate events", async () => {
    const events = [makeEvent(), makeEvent()];
    const first = await post({ events });
    expect(first.status).toBe(200);
    const body = await first.json();
    matches(IngestEventsResponseSchema, body);
    expect(body).toEqual({ accepted: 2, duplicates: 0 });

    const retry = await post({ events: [...events, makeEvent()] });
    expect(await retry.json()).toEqual({ accepted: 1, duplicates: 2 });
  });

  it("rejects a batch with an invalid event, names the field and writes nothing", async () => {
    const good = makeEvent({ actor: { kind: "person", id: "nobody@example.com" } });
    const bad = { ...makeEvent(), ts: "yesterday" };
    const res = await post({ events: [good, bad] });
    expect(res.status).toBe(400);
    const body = await res.json();
    matches(IngestEventsErrorSchema, body);
    expect(body).toEqual({
      error: { code: "invalid_events", message: "1 problem(s) found, nothing was written" },
      errors: [{ index: 1, field: "ts", message: "Expected a date-time string" }],
    });
    const page = await server.request("/v1/events?person=nobody%40example.com");
    expect(((await page.json()) as EventsPage).events).toEqual([]);
  });

  it.each([
    ["a body that is not JSON", "{", "(root)", "Expected a JSON body"],
    ["a body that is not an object", [], "(root)", "Expected an object with an events array"],
    ["a missing events array", {}, "events", "Expected an array"],
    ["an empty batch", { events: [] }, "events", "Expected between 1 and 1000 events, got 0"],
    ["an unexpected property", { events: [], extra: 1 }, "extra", "Unexpected property"],
  ])("rejects %s", async (_, body, field, message) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as IngestEventsError;
    matches(IngestEventsErrorSchema, json);
    expect(json.errors).toEqual([{ index: -1, field, message }]);
  });

  it("refuses more than 1000 events with 413", async () => {
    const events = Array.from({ length: 1001 }, () => makeEvent());
    const res = await post({ events });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ApiError).error.code).toBe("too_many_events");
  });

  it("requires the bearer token", async () => {
    const res = await server.app.request("/v1/events", {
      method: "POST",
      body: JSON.stringify({ events: [makeEvent()] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/events", () => {
  const actor = { kind: "person" as const, id: "search@example.com" };
  const seeded: LedgerEvent[] = [];

  beforeAll(async () => {
    seeded.push(
      makeEvent({
        actor,
        agent: { vendor: "claude_code" },
        model: "claude-opus-5-5",
        session_id: "a",
      }),
      makeEvent({ actor, agent: { vendor: "codex" }, model: "gpt-5.5", session_id: "b" }),
      makeEvent({ actor, kind: "tool.called", tool: { name: "Bash" }, session_id: "a" }),
    );
    const res = await post({ events: seeded });
    expect(res.status).toBe(200);
  });

  const get = async (query: string) => {
    const res = await server.request(`/v1/events?${query}`);
    // One of the two shapes, depending on the status.
    return { status: res.status, body: (await res.json()) as EventsPage & ApiError };
  };
  const ids = (events: LedgerEvent[]) => events.map((e) => e.id);

  it("returns a page newest first with next_cursor null at the end", async () => {
    const { status, body } = await get("person=search%40example.com");
    expect(status).toBe(200);
    matches(EventsPageSchema, body);
    expect(ids(body.events)).toEqual(ids([...seeded].reverse()));
    expect(body.next_cursor).toBeNull();
    expect(body.events[2]).toEqual(seeded[0]);
  });

  it("filters by agent, model, session, kind and time", async () => {
    const person = "person=search%40example.com";
    expect(ids((await get(`${person}&agent=codex`)).body.events)).toEqual([seeded[1]?.id]);
    expect(ids((await get(`${person}&model=claude-opus-5-5`)).body.events)).toEqual([
      seeded[0]?.id,
    ]);
    expect(ids((await get(`${person}&session=a`)).body.events)).toEqual([
      seeded[2]?.id,
      seeded[0]?.id,
    ]);
    expect(ids((await get(`${person}&kind=tool.called`)).body.events)).toEqual([seeded[2]?.id]);
    const from = encodeURIComponent(seeded[1]?.ts ?? "");
    const to = encodeURIComponent(seeded[2]?.ts ?? "");
    expect(ids((await get(`${person}&from=${from}&to=${to}`)).body.events)).toEqual([
      seeded[1]?.id,
    ]);
  });

  it("pages with limit and cursor", async () => {
    const first = await get("person=search%40example.com&limit=2");
    expect(ids(first.body.events)).toEqual([seeded[2]?.id, seeded[1]?.id]);
    expect(first.body.next_cursor).toBeTypeOf("string");
    const second = await get(
      `person=search%40example.com&limit=2&cursor=${encodeURIComponent(first.body.next_cursor ?? "")}`,
    );
    expect(ids(second.body.events)).toEqual([seeded[0]?.id]);
    expect(second.body.next_cursor).toBeNull();
  });

  it.each([
    ["limit=0", "limit"],
    ["limit=1001", "limit"],
    ["limit=ten", "limit"],
    ["agent=robot", "agent"],
    ["kind=nope", "kind"],
    ["from=yesterday", "from"],
    ["cursor=bad", "cursor"],
    ["persn=alice", "persn"],
    ["person=a&person=b", "person"],
  ])("rejects %s with 400 naming %s", async (query, field) => {
    const { status, body } = await get(query);
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_query");
    expect(body.error.message).toMatch(new RegExp(`^${field}: `));
  });
});

describe("POST /v1/events with older event schema versions", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
  // example.event/v1 named the actor `who` and was replaced 13 months ago; example.event/v2
  // named the kind `type`, was released 13 months ago and replaced 30 days ago.
  const versions: EventSchemaVersion[] = [
    {
      tag: "example.event/v1",
      released: daysAgo(800),
      upgrade: ({ who, ...rest }) => ({ ...rest, actor: who }),
    },
    {
      tag: "example.event/v2",
      released: daysAgo(395),
      upgrade: ({ type, ...rest }) => ({ ...rest, kind: type }),
    },
    { tag: EVENT_SCHEMA, released: daysAgo(30) },
  ];
  let ledger: Ledger;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://", eventSchemas: versions });
    app = createApp({ version: "1.2.3", ledger, token: TOKEN });
  });

  afterAll(async () => {
    await ledger.close();
  });

  const send = (events: unknown[]) =>
    app.request("/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });

  it("stores events in a version still supported, upgraded to the current one", async () => {
    const { kind, ...rest } = makeEvent({ kind: "session.ended" });
    const res = await send([{ ...rest, schema: "example.event/v2", type: kind }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1, duplicates: 0 });
    const read = await app.request(`/v1/events?kind=session.ended`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const page = (await read.json()) as EventsPage;
    expect(page.events).toEqual([{ ...rest, schema: EVENT_SCHEMA, kind: "session.ended" }]);
  });

  it("rejects events in a version past its 12 month window and writes nothing", async () => {
    const { actor, ...rest } = makeEvent();
    const res = await send([makeEvent(), { ...rest, schema: "example.event/v1", who: actor }]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as IngestEventsError;
    matches(IngestEventsErrorSchema, body);
    expect(body.errors).toEqual([
      {
        index: 1,
        field: "schema",
        message: expect.stringMatching(
          /^example\.event\/v1 is no longer accepted: support ended on .+ Update the importer or SDK that sent it to one that writes selfhost\.event\/v1$/,
        ),
      },
    ]);
  });

  it("rejects an unknown version, listing the accepted ones", async () => {
    const res = await send([{ ...makeEvent(), schema: "selfhost.event/v2" }]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as IngestEventsError;
    expect(body.errors).toEqual([
      {
        index: 0,
        field: "schema",
        message:
          'Unknown event schema "selfhost.event/v2". Accepted: selfhost.event/v1, example.event/v2',
      },
    ]);
  });
});

describe("POST /v1/events from two ledgers of the same run", () => {
  it("keeps the first copy of each tool call and session start, and relinks decisions", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const app = createApp({ version: "test", ledger, token: TOKEN });
      const post = async (events: LedgerEvent[], token = TOKEN) =>
        (await (
          await app.request("/v1/events", {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ events }),
          })
        ).json()) as { accepted: number; duplicates: number };
      const run = { session_id: "s-two-ledgers", agent: { vendor: "claude_code" as const } };
      const call = (source: LedgerEvent["source"], toolUse: string) =>
        makeEvent({
          ...run,
          source,
          kind: "tool.called",
          tool: { name: "Bash", input_summary: `echo ${toolUse}` },
          data: { tool_use_id: toolUse },
        });
      const decided = (tool: LedgerEvent) =>
        makeEvent({
          ...run,
          source: "hook",
          kind: "policy.evaluated",
          tool: tool.tool,
          decision: { verdict: "allow", by: "selfhost-policy" },
          data: { tool_event_id: tool.id },
        });

      // The watch ledger synced the hook copies first.
      const hookA = call("hook", "toolu_a");
      expect(await post([makeEvent({ ...run }), hookA, decided(hookA)])).toEqual({
        accepted: 3,
        duplicates: 0,
      });
      // A one-shot import into a fresh data dir sends its own copies of the same facts.
      const logA = call("local_log", "toolu_a");
      const hookB = call("hook", "toolu_b");
      const logB = call("local_log", "toolu_b");
      const second = await post([
        makeEvent({ ...run, source: "local_log" }),
        logA,
        hookB,
        logB,
        decided(logB),
      ]);
      expect(second).toEqual({ accepted: 2, duplicates: 3 });

      const stored = (await ledger.query({ session: run.session_id, limit: 100 })).events;
      const calls = stored.filter((e) => e.kind === "tool.called");
      expect(calls.map((e) => [e.source, e.data?.tool_use_id]).sort()).toEqual([
        ["hook", "toolu_a"],
        ["hook", "toolu_b"],
      ]);
      expect(stored.filter((e) => e.kind === "session.started")).toHaveLength(1);
      // The decision on the skipped log copy links to the hook copy that stayed.
      const links = stored
        .filter((e) => e.kind === "policy.evaluated")
        .map((e) => e.data?.tool_event_id);
      expect(links.sort()).toEqual([hookA.id, hookB.id].sort());
    } finally {
      await ledger.close();
    }
  });
});
