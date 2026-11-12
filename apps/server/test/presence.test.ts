import { type Ledger, openLedger } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  type ApiError,
  type CreateTeamResponse,
  EVENT_SCHEMA,
  type JoinResponse,
  type LedgerEvent,
  type PresenceResponse,
  validatePresenceResponse,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { raiseNamedAgentBudgets } from "../src/budget-alerts.js";
import { raiseOverlapAlerts } from "../src/presence.js";
import { caller, TOKEN } from "./helpers.js";

const NOW = new Date("2026-11-12T10:30:00.000Z");

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  ts: "2026-11-12T10:20:00.000Z",
  source: "hook",
  actor: { kind: "person", id: "lead@example.com" },
  agent: { vendor: "claude_code" },
  repo: "acme/web",
  ...fields,
});

const edit = (session: string, file: string, fields: Partial<LedgerEvent> = {}) =>
  event({
    kind: "tool.called",
    session_id: session,
    tool: { name: "Edit" },
    target: { type: "file", value: file },
    ...fields,
  });

const JANITOR = { kind: "agent" as const, id: "agent:janitor", name: "janitor" };

describe("presence on a team server", () => {
  let ledger: Ledger;
  let app: Hono;
  const as = {} as Record<"admin" | "lead" | "ana" | "dora", ReturnType<typeof caller>>;

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    app = createApp({ version: "test", ledger, token: TOKEN, now: () => NOW });
    as.admin = caller(app, TOKEN);
    const team = async (name: string) =>
      (await (await as.admin("/v1/teams", "POST", { name })).json()) as CreateTeamResponse;
    const join = async (invite: string, person: string) =>
      ((await (await as.admin("/v1/join", "POST", { invite, person })).json()) as JoinResponse)
        .token;
    const web = await team("Web");
    const data = await team("Data");
    as.lead = caller(app, await join(web.invite, "lead@example.com"));
    as.ana = caller(app, await join(web.invite, "ana@example.com"));
    as.dora = caller(app, await join(data.invite, "dora@example.com"));
    const policy = `version = 1
[presence]
idle_minutes = 20

[agents.janitor]
owner = "ana@example.com"
daily_usd = 1
`;
    expect((await as.lead("/v1/policy", "PUT", { text: policy })).status).toBe(200);
    // Two concurrent runs in acme/web edit src/app.ts: Lead's, and the janitor agent Ana owns.
    const written = [
      edit("s-lead", "src/app.ts", { data: { branch: "main" } }),
      edit("s-lead", "src/routes.ts", { data: { branch: "main" } }),
      edit("s-janitor", "src/app.ts", {
        ts: "2026-11-12T10:25:00.000Z",
        actor: JANITOR,
        agent: { vendor: "codex" },
        data: { branch: "janitor/deps" },
      }),
      event({
        kind: "cost.recorded",
        session_id: "s-janitor",
        actor: JANITOR,
        agent: { vendor: "codex" },
        model: "gpt-5-codex",
        cost: {
          input_tokens: 1000,
          output_tokens: 100,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          usd: 1.5,
          estimated: true,
        },
      }),
    ];
    expect((await as.lead("/v1/events", "POST", { events: written })).status).toBe(200);
    const other = [
      edit("s-dora", "pipelines/etl.py", { actor: { kind: "person", id: "dora@example.com" } }),
    ];
    expect((await as.dora("/v1/events", "POST", { events: other })).status).toBe(200);
  });

  afterAll(async () => {
    await ledger.close();
  });

  const presence = async (who: ReturnType<typeof caller>, query = "") => {
    const res = await who(`/v1/presence${query}`);
    return { status: res.status, body: (await res.json()) as PresenceResponse & ApiError };
  };

  it("answers who works where, with owners and the overlap, in the caller's teams only", async () => {
    const lead = await presence(as.lead);
    expect(lead.status).toBe(200);
    expect(validatePresenceResponse(lead.body).ok).toBe(true);
    expect(lead.body.runs.map((run) => [run.id, run.branch, run.owner, run.owner_via])).toEqual([
      ["s-janitor", "janitor/deps", "ana@example.com", "named_agent"],
      ["s-lead", "main", "lead@example.com", "person"],
    ]);
    expect(lead.body.runs[0]).toMatchObject({ named_agent: "janitor", team: "web" });
    expect(lead.body.overlaps).toEqual([
      {
        repo: "acme/web",
        file: "src/app.ts",
        runs: ["s-lead", "s-janitor"],
        owners: ["lead@example.com", "ana@example.com"],
        since: "2026-11-12T10:25:00.000Z",
      },
    ]);
    // The web team's [presence] idle_minutes, else 30.
    expect((await presence(as.lead, "?team=web")).body.idle_minutes).toBe(20);

    const dora = await presence(as.dora);
    expect(dora.body.runs.map((run) => run.id)).toEqual(["s-dora"]);
    expect(dora.body.overlaps).toEqual([]);
    expect((await presence(as.dora, "?team=web")).status).toBe(403);

    const admin = await presence(as.admin);
    expect(admin.body.runs.map((run) => run.id).sort()).toEqual(["s-dora", "s-janitor", "s-lead"]);
    expect((await presence(as.admin, "?repo=acme/web&idle_minutes=6")).body.runs).toEqual([
      expect.objectContaining({ id: "s-janitor" }),
    ]);
    expect((await presence(as.admin, "?idle_minutes=0")).status).toBe(400);
  });

  it("warns both owners once with an overlap item, before either run opens a pull request", async () => {
    expect(await raiseOverlapAlerts(ledger, NOW)).toBe(2);
    expect(await raiseOverlapAlerts(ledger, NOW)).toBe(0);
    const list = openReviewList(ledger, { now: () => NOW });
    await refreshReviewList(ledger, list);
    const items = (await list.list({})).items.filter((item) => item.kind === "overlap");
    expect(items.map((item) => [item.owners, item.title, item.repo]).sort()).toEqual([
      [["ana@example.com"], "2 active runs are editing src/app.ts in acme/web", "acme/web"],
      [["lead@example.com"], "2 active runs are editing src/app.ts in acme/web", "acme/web"],
    ]);
  });

  it("raises a named agent's daily budget item for its owner", async () => {
    const policy = (await ledger.orgs.effectivePolicy("web"))?.config;
    if (!policy) throw new Error("no policy");
    expect(await raiseNamedAgentBudgets(ledger, "default", "web", policy, NOW)).toBe(1);
    expect(await raiseNamedAgentBudgets(ledger, "default", "web", policy, NOW)).toBe(0);
    const list = openReviewList(ledger, { now: () => NOW });
    await refreshReviewList(ledger, list);
    const items = (await list.list({})).items.filter((item) => item.kind === "budget");
    expect(items.map((item) => [item.owners, item.title, item.route?.from])).toEqual([
      [
        ["ana@example.com"],
        "Agent janitor spent $1.50 of its $1.00 daily budget",
        "[agents.janitor] owner",
      ],
    ]);
  });

  it("names the run's owner on the run view", async () => {
    const res = await as.lead("/v1/runs/s-janitor");
    const body = (await res.json()) as { run: Record<string, unknown> };
    expect(body.run).toMatchObject({
      owner: "ana@example.com",
      owner_via: "named_agent",
      named_agent: "janitor",
    });
  });
});
