import { type Ledger, openLedger } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  type ApiError,
  type CreateTeamResponse,
  createValidator,
  EVENT_SCHEMA,
  type JoinResponse,
  type LedgerEvent,
  type ReviewItemsPage,
  type RunResponse,
  RunResponseSchema,
} from "@selfhost/schema";
import { exportTraces, traceIdOf } from "@selfhost/traces";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { caller, TOKEN } from "./helpers.js";

const RUN = "5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87";
const PR = "https://github.com/acme/api/pull/7";
const PROMPT = "Add rate limiting to the public API and ship it today";
const PUBLIC_URL = "https://selfhost.acme.example.com";
const NOW = new Date("2026-11-08T00:00:00Z");

const valid = createValidator(RunResponseSchema);

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind" | "ts">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  source: "hook",
  actor: { kind: "person", id: "lead@example.com" },
  agent: { vendor: "claude_code", version: "2.1.0" },
  session_id: RUN,
  ...fields,
});

const RUN_EVENTS = [
  event({ kind: "session.started", ts: "2026-10-12T09:00:00.000Z" }),
  event({ kind: "prompt.submitted", ts: "2026-10-12T09:00:05.000Z", data: { prompt: PROMPT } }),
  event({
    kind: "tool.called",
    ts: "2026-10-12T09:01:00.000Z",
    tool: { name: "Bash", input_summary: "curl -H 'X-Ticket: ACME-4521' https://api.example.com" },
    data: { tool_use_id: "toolu_01" },
  }),
  event({
    kind: "tool.result",
    ts: "2026-10-12T09:01:04.000Z",
    tool: { name: "Bash" },
    data: { tool_use_id: "toolu_01" },
  }),
  event({
    kind: "cost.recorded",
    source: "otel",
    ts: "2026-10-12T09:02:00.000Z",
    model: "claude-sonnet-4-5",
    cost: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 3000,
      cache_write_tokens: 0,
      usd: 0.0123,
      estimated: false,
    },
  }),
  event({
    kind: "commit.created",
    ts: "2026-10-12T09:05:00.000Z",
    repo: "acme/api",
    links: { commit_sha: "4f2a9c1d7e3b5a8f0c6d2e9b1a7f3c5d8e0b2a4c", pr_url: PR },
  }),
  event({ kind: "session.ended", ts: "2026-10-12T09:10:00.000Z" }),
];

describe("GET /v1/runs/{run_id}", () => {
  let ledger: Ledger;
  let app: Hono;
  const as = {} as Record<"admin" | "lead" | "member" | "outsider", ReturnType<typeof caller>>;

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    app = createApp({
      version: "test",
      ledger,
      token: TOKEN,
      now: () => NOW,
      github: { publicUrl: PUBLIC_URL },
    });
    as.admin = caller(app, TOKEN);
    const team = async (name: string) =>
      (await (await as.admin("/v1/teams", "POST", { name })).json()) as CreateTeamResponse;
    const join = async (invite: string, person: string) => {
      const res = await app.request("/v1/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite, person }),
      });
      return ((await res.json()) as JoinResponse).token;
    };
    const web = await team("Web");
    const data = await team("Data");
    as.lead = caller(app, await join(web.invite, "lead@example.com"));
    as.member = caller(app, await join(web.invite, "mia@example.com"));
    as.outsider = caller(app, await join(data.invite, "dora@example.com"));
    expect((await as.lead("/v1/events", "POST", { events: RUN_EVENTS })).status).toBe(200);
    // The pull request's state comes from GitHub's events, written with the admin token.
    await ledger.append([
      event({
        kind: "pr.opened",
        source: "github",
        ts: "2026-10-12T09:06:00.000Z",
        session_id: undefined,
        links: { pr_url: PR },
      }),
      event({
        kind: "pr.merged",
        source: "github",
        ts: "2026-10-13T10:00:00.000Z",
        session_id: undefined,
        links: { pr_url: PR },
      }),
    ]);
  });

  afterAll(async () => {
    await ledger.close();
  });

  const read = async (who: ReturnType<typeof caller>, path = `/v1/runs/${RUN}`) => {
    const res = await who(path);
    return { status: res.status, body: (await res.json()) as RunResponse };
  };

  it("answers a member of the run's team with the run in the documented shape", async () => {
    const { status, body } = await read(as.member);
    expect(status).toBe(200);
    expect(valid.validate(body).ok).toBe(true);
    expect(Object.keys(body)).toEqual([
      "schema",
      "run",
      "events",
      "next_cursor",
      "prs",
      "trace_url",
    ]);
    expect(body.schema).toBe("selfhost.run/v1");
    expect(body.run).toEqual({
      id: RUN,
      agent: { vendor: "claude_code", version: "2.1.0" },
      model: "claude-sonnet-4-5",
      person: "lead@example.com",
      team: "web",
      repo: "acme/api",
      started_at: "2026-10-12T09:00:00.000Z",
      ended_at: "2026-10-12T09:10:00.000Z",
      cost_usd: 0.0123,
      tokens: 4200,
    });
    expect(body.events.map((e) => e.kind)).toEqual(RUN_EVENTS.map((e) => e.kind));
    expect(body.next_cursor).toBeNull();
    expect(body.prs).toEqual([{ url: PR, state: "merged" }]);
    // No [integrations.tracer] yet.
    expect(body.trace_url).toBeNull();
  });

  it("shows no prompt text while log_prompts is off", async () => {
    const res = await as.lead(`/v1/runs/${RUN}`);
    expect(await res.text()).not.toContain(PROMPT);
  });

  it("refuses anyone outside the run's team, the same way whether or not the run exists", async () => {
    const other = await as.outsider(`/v1/runs/${RUN}`);
    const missing = await as.outsider("/v1/runs/no-such-run");
    expect(other.status).toBe(403);
    expect(missing.status).toBe(403);
    const [a, b] = [(await other.json()) as ApiError, (await missing.json()) as ApiError];
    expect(a.error.code).toBe("forbidden");
    expect(JSON.stringify(a)).not.toContain("acme");
    expect(b.error.code).toBe("forbidden");
    expect((await as.admin("/v1/runs/no-such-run")).status).toBe(404);
    expect((await as.admin(`/v1/runs/${RUN}`)).status).toBe(200);
    const anonymous = await app.request(`/v1/runs/${RUN}`);
    expect(anonymous.status).toBe(401);
  });

  it("pages through the events with a cursor", async () => {
    const first = await read(as.lead, `/v1/runs/${RUN}?limit=3`);
    expect(first.body.events).toHaveLength(3);
    expect(first.body.next_cursor).toBeTypeOf("string");
    const second = await read(as.lead, `/v1/runs/${RUN}?limit=3&cursor=${first.body.next_cursor}`);
    const third = await read(as.lead, `/v1/runs/${RUN}?limit=3&cursor=${second.body.next_cursor}`);
    expect(third.body.next_cursor).toBeNull();
    const ids = [...first.body.events, ...second.body.events, ...third.body.events].map(
      (e) => e.id,
    );
    expect(ids).toEqual(RUN_EVENTS.map((e) => e.id));
    // The summary covers the whole run on every page.
    expect(second.body.run.cost_usd).toBe(0.0123);
    expect((await as.lead(`/v1/runs/${RUN}?limit=0`)).status).toBe(400);
    expect((await as.lead(`/v1/runs/${RUN}?cursor=nope`)).status).toBe(400);
  });

  it("masks the team's [[redaction]] patterns and links the tracer once the run is sent", async () => {
    const policy = [
      "version = 1",
      "[[redaction]]",
      'name = "ticket"',
      'pattern = "ACME-[0-9]+"',
      "[integrations.tracer]",
      'tool = "langfuse"',
      'endpoint = "https://langfuse.example.com/api/public/otel"',
      'run_url = "https://langfuse.example.com/trace/{trace_id}?run={run_id}"',
      "",
    ].join("\n");
    expect((await as.lead("/v1/policy?team=web", "PUT", { text: policy })).status).toBe(200);

    const before = await read(as.lead);
    const call = before.body.events.find((e) => e.kind === "tool.called");
    expect(call?.tool?.input_summary).toContain("[redacted:ticket]");
    expect(JSON.stringify(before.body)).not.toContain("ACME-4521");
    expect(before.body.trace_url).toBeNull();

    const sent: string[] = [];
    await exportTraces(ledger, {
      settingsFor: async () => ({
        tracer: { tool: "langfuse", endpoint: "https://langfuse.example.com/api/public/otel" },
        logPrompts: false,
        patterns: [],
      }),
      sender: () => async (spans) => {
        sent.push(...spans.map((s) => s.name));
      },
      now: new Date(Date.now() + 120_000),
    });
    expect(sent).toContain("invoke_agent claude_code");

    const after = await read(as.lead);
    expect(after.body.trace_url).toBe(
      `https://langfuse.example.com/trace/${traceIdOf(RUN)}?run=${RUN}`,
    );
  });

  it("links review items to the run view and the tracer", async () => {
    expect(
      (
        await as.lead("/v1/events", "POST", {
          events: [
            event({
              kind: "policy.evaluated",
              source: "hook",
              // Recent: the review list reads rule verdicts from the last few days only.
              ts: "2026-11-07T09:04:00.000Z",
              actor: { kind: "system", id: "selfhost-policy" },
              tool: { name: "Bash", input_summary: "git push --force" },
              decision: {
                verdict: "block",
                by: "selfhost-policy",
                rule_id: "no-force-push",
                mode: "enforce",
              },
            }),
          ],
        })
      ).status,
    ).toBe(200);
    await refreshReviewList(ledger, openReviewList(ledger, { now: () => NOW }));
    const res = await as.lead("/v1/review-items?state=open");
    const { items } = (await res.json()) as ReviewItemsPage;
    const item = items.find((i) => i.session_id === RUN);
    expect(item?.run_url).toBe(`${PUBLIC_URL}/runs/${RUN}`);
    expect(item?.trace_url).toBe(`https://langfuse.example.com/trace/${traceIdOf(RUN)}?run=${RUN}`);
  });
});
