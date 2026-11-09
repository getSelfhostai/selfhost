import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  type ApiError,
  type CreateTeamResponse,
  createValidator,
  EVENT_SCHEMA,
  type JoinResponse,
  type LedgerEvent,
  type TailResponse,
  TailResponseSchema,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { caller, TOKEN } from "./helpers.js";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const PROMPT = "Rotate the staging keys and paste them here";
const valid = createValidator(TailResponseSchema);

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  ts: "2026-11-09T11:59:00.000Z",
  source: "hook",
  actor: { kind: "person", id: "lead@example.com" },
  agent: { vendor: "claude_code" },
  session_id: "web-run",
  ...fields,
});

describe("GET /v1/events/tail", () => {
  let ledger: Ledger;
  let app: Hono;
  const as = {} as Record<"admin" | "lead" | "outsider", ReturnType<typeof caller>>;

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    app = createApp({ version: "test", ledger, token: TOKEN, now: () => NOW });
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
    as.outsider = caller(app, await join(data.invite, "dora@example.com"));
  });

  afterAll(async () => {
    await ledger.close();
  });

  const tail = async (who: ReturnType<typeof caller>, query: string) => {
    const res = await who(`/v1/events/tail?${query}`);
    return { status: res.status, body: (await res.json()) as TailResponse & ApiError };
  };

  it("starts now, then answers what landed after the cursor, redacted, to each team", async () => {
    const start = await tail(as.lead, "");
    expect(start.status).toBe(200);
    expect(valid.validate(start.body).ok).toBe(true);
    expect(start.body.events).toEqual([]);
    const fromData = await tail(as.outsider, "");

    const written = [
      event({ kind: "session.started", repo: "acme/web" }),
      event({ kind: "prompt.submitted", data: { prompt: PROMPT } }),
      event({
        kind: "tool.called",
        tool: { name: "Bash", input_summary: "export AWS_SECRET_ACCESS_KEY=abcd1234abcd1234abcd" },
      }),
    ];
    expect((await as.lead("/v1/events", "POST", { events: written })).status).toBe(200);

    const page = await tail(as.lead, `after=${start.body.cursor}`);
    expect(page.status).toBe(200);
    expect(valid.validate(page.body).ok).toBe(true);
    expect(page.body.events.map((e) => e.kind)).toEqual([
      "session.started",
      "prompt.submitted",
      "tool.called",
    ]);
    expect(JSON.stringify(page.body)).not.toContain(PROMPT);
    expect(JSON.stringify(page.body)).not.toContain("abcd1234abcd1234abcd");

    // Another team's person sees none of it; the admin token sees all of it.
    expect((await tail(as.outsider, `after=${fromData.body.cursor}`)).body.events).toEqual([]);
    expect((await tail(as.admin, `since=2026-11-09T00:00:00Z`)).body.events).toHaveLength(3);
    expect((await tail(as.outsider, "team=web")).status).toBe(403);

    const next = await tail(as.lead, `after=${page.body.cursor}`);
    expect(next.body.events).toEqual([]);
    expect(next.body.cursor).toBe(page.body.cursor);
  });

  it("filters by kind, person, agent and repo", async () => {
    const since = "since=2026-11-09T00:00:00Z";
    const kinds = async (query: string) =>
      (await tail(as.admin, `${since}&${query}`)).body.events.map((e) => e.kind);
    expect(await kinds("kind=tool,session")).toEqual(["session.started", "tool.called"]);
    expect(await kinds("person=dora@example.com")).toEqual([]);
    expect(await kinds("agent=codex")).toEqual([]);
    expect(await kinds("repo=acme/web")).toHaveLength(3);
    expect((await tail(as.admin, `${since}&kind=tools`)).status).toBe(400);
    expect((await tail(as.admin, "after=not-a-cursor")).status).toBe(400);
  });

  it("holds the request while nothing lands, and answers as soon as something does", async () => {
    const start = await tail(as.admin, "");
    const held = app.request(`/v1/events/tail?after=${start.body.cursor}&wait=5`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ledger.append([event({ kind: "session.ended", session_id: "late" })]);
    const begun = Date.now();
    const body = (await (await held).json()) as TailResponse;
    expect(body.events.map((e) => e.session_id)).toEqual(["late"]);
    expect(Date.now() - begun).toBeLessThan(2000);
  });
});
