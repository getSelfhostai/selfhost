import { chatDecision } from "@selfhost/ledger";
import {
  type ApiError,
  type CreateDecisionRequest,
  type CreateDecisionResponse,
  CreateDecisionResponseSchema,
  createValidator,
  type DecisionsPage,
  DecisionsPageSchema,
  type LedgerEvent,
} from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./helpers.js";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.ledger.close();
});

const matches = (schema: Parameters<typeof createValidator>[0], body: unknown) => {
  const result = createValidator(schema).validate(body);
  expect(result.ok ? [] : result.errors).toEqual([]);
};

const post = (body: unknown) =>
  server.request("/v1/decisions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function created(body: CreateDecisionRequest, status = 201) {
  const res = await post(body);
  const json = (await res.json()) as CreateDecisionResponse & ApiError;
  expect(res.status, JSON.stringify(json)).toBe(status);
  matches(CreateDecisionResponseSchema, json);
  return json.decision_event;
}

/** Every decision.recorded event this person made. */
async function decisionsBy(person: string): Promise<LedgerEvent[]> {
  const page = await server.ledger.query({ kind: "decision.recorded", person, limit: 1000 });
  return page.events;
}

describe("POST /v1/decisions", () => {
  it("records one decision and returns it with 201", async () => {
    const event = await created({
      verdict: "approve",
      by: "ada@example.com",
      reason: "Seed data only touches staging",
      question: "Allow an exception to ask-before-seed for run 7?",
      rule_id: "ask-before-seed",
      run_id: "run-7",
      surface: "exception_approval",
    });
    expect(event).toMatchObject({
      kind: "decision.recorded",
      source: "server",
      actor: { kind: "person", id: "ada@example.com" },
      run_id: "run-7",
      decision: { verdict: "approve", by: "ada@example.com", rule_id: "ask-before-seed" },
      data: { surface: "exception_approval" },
    });
    expect(await decisionsBy("ada@example.com")).toEqual([event]);
  });

  it("returns the stored decision with 200 when the same action is sent again", async () => {
    const press = chatDecision({
      surface: "slack",
      actionId: "1731000000.000100-U1",
      at: "2026-11-07T09:00:00.000Z",
      person: "slack@example.com",
      verdict: "deny",
      itemId: "01930c4e-2f1a-7b2c-8d3e-4f5a6b7c8d41",
      reason: "Not before the release",
    });
    const first = await created(press);
    const again = await created({ ...press, reason: "a retried delivery" }, 200);
    expect(again).toEqual(first);
    expect(await decisionsBy("slack@example.com")).toEqual([first]);
  });

  it("links a correction to the decision it changes and leaves that one alone", async () => {
    const original = await created({
      verdict: "approve",
      by: "fix@example.com",
      run_id: "run-8",
      paths: ["src/billing.ts"],
    });
    const correction = await created({
      verdict: "override",
      by: "fix@example.com",
      reason: "Approved the wrong run",
      replaces_event_id: original.id,
    });
    expect(correction.decision?.replaces_event_id).toBe(original.id);
    expect(correction.run_id).toBe("run-8");
    expect(await decisionsBy("fix@example.com")).toEqual([correction, original]);
  });

  it.each([
    ["a body that is not JSON", "{", "Expected a JSON body"],
    ["an array", [], "Expected a JSON object"],
    ["a missing person", { verdict: "approve", run_id: "r" }, "by: Expected required property"],
    ["a rule verdict", { verdict: "block", by: "no@example.com", run_id: "r" }, "verdict: "],
    ["nothing it answers", { verdict: "approve", by: "no@example.com" }, "item_id: Expected"],
    [
      "a key without a time",
      { verdict: "approve", by: "no@example.com", run_id: "r", key: "k" },
      "ts: Required with key",
    ],
    [
      "an unknown decision to replace",
      {
        verdict: "override",
        by: "no@example.com",
        replaces_event_id: "01930c4e-2f1a-7b2c-8d3e-4f5a6b7c8dff",
      },
      "replaces_event_id: No decision",
    ],
  ])("rejects %s with 400 and writes nothing", async (_, body, message) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as ApiError;
    expect(json.error.code).toBe("invalid_decision");
    expect(json.error.message).toContain(message);
    expect(await decisionsBy("no@example.com")).toEqual([]);
  });

  it("requires the admin token", async () => {
    const res = await server.app.request("/v1/decisions", {
      method: "POST",
      body: JSON.stringify({ verdict: "approve", by: "x@example.com", run_id: "r" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/decisions", () => {
  const seeded: LedgerEvent[] = [];

  beforeAll(async () => {
    const base = { by: "query@example.com", repo: "acme/query" } as const;
    seeded.push(
      await created({
        ...base,
        verdict: "approve",
        question: "Run migration 0004 on staging?",
        reason: "Backfill finished",
        paths: ["db/migrations/0004_orders.sql"],
        run_id: "run-q1",
        ts: "2026-11-07T08:00:00.000Z",
      }),
      await created({
        ...base,
        verdict: "deny",
        reason: "Keep retries in the client",
        paths: ["src/http/retry.ts"],
        pr_url: "https://github.com/acme/query/pull/4",
        ts: "2026-11-07T08:05:00.000Z",
      }),
    );
  });

  const get = async (query: string) => {
    const res = await server.request(`/v1/decisions?repo=acme%2Fquery&${query}`);
    return { status: res.status, res };
  };
  const ids = (page: DecisionsPage) => page.decisions.map((e) => e.id);

  it("finds decisions by path and by topic", async () => {
    const byFolder = await get("path=db%2Fmigrations");
    expect(byFolder.status).toBe(200);
    const page = (await byFolder.res.json()) as DecisionsPage;
    matches(DecisionsPageSchema, page);
    expect(ids(page)).toEqual([seeded[0]?.id]);
    expect(page.next_cursor).toBeNull();

    const byTopic = (await (await get("topic=STAGING%20migration")).res.json()) as DecisionsPage;
    expect(ids(byTopic)).toEqual([seeded[0]?.id]);
    const byReason = (await (await get("topic=retries")).res.json()) as DecisionsPage;
    expect(ids(byReason)).toEqual([seeded[1]?.id]);
    const both = (await (await get("limit=1")).res.json()) as DecisionsPage;
    expect(ids(both)).toEqual([seeded[1]?.id]);
    expect(both.next_cursor).toBeTypeOf("string");
  });

  it("returns plain text with the decision id and links for format=text", async () => {
    const { status, res } = await get("path=src%2Fhttp%2Fretry.ts&format=text");
    expect(status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(
      [
        "1 decision, newest first.",
        "",
        `${seeded[1]?.id}  2026-11-07T08:05:00.000Z  deny by query@example.com`,
        "  reason: Keep retries in the client",
        "  repo: acme/query",
        "  files: src/http/retry.ts",
        "  pr: https://github.com/acme/query/pull/4",
        "",
      ].join("\n"),
    );
  });

  it.each([
    ["format=xml", "format"],
    ["limit=ten", "limit"],
    ["path=.", "path"],
    ["verdict=maybe", "verdict"],
    ["topik=x", "topik"],
    ["path=a&path=b", "path"],
  ])("rejects %s with 400 naming %s", async (query, field) => {
    const { status, res } = await get(query);
    expect(status).toBe(400);
    const json = (await res.json()) as ApiError;
    expect(json.error.code).toBe("invalid_query");
    expect(json.error.message).toMatch(new RegExp(`^${field}: `));
  });
});

describe("person tokens", () => {
  it("cannot record or read decisions yet", async () => {
    const team = await server.request("/v1/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Decisions" }),
    });
    const { invite } = (await team.json()) as { invite: string };
    const joined = await server.app.request("/v1/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite, person: "member@example.com" }),
    });
    const { token } = (await joined.json()) as { token: string };
    for (const method of ["GET", "POST"]) {
      const res = await server.app.request("/v1/decisions", {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(method === "POST"
          ? { body: JSON.stringify({ verdict: "approve", by: "member@example.com", run_id: "r" }) }
          : {}),
      });
      expect(res.status, method).toBe(403);
    }
  });
});
