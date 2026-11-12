import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  type AdvisorReport,
  type ApiError,
  type CreateTeamResponse,
  EVENT_SCHEMA,
  type JoinResponse,
  type LedgerEvent,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { serverDirectory } from "../src/notify.js";
import { caller, TOKEN } from "./helpers.js";

const NOW = new Date("2026-11-12T10:30:00.000Z");

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  ts: "2026-11-10T10:20:00.000Z",
  source: "hook",
  actor: { kind: "person", id: "lead@example.com" },
  agent: { vendor: "claude_code" },
  repo: "acme/web",
  ...fields,
});

const cost = (person: string, session: string, usd: number) =>
  event({
    kind: "cost.recorded",
    source: "otel",
    session_id: session,
    actor: { kind: "person", id: person },
    cost: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usd,
      estimated: false,
    },
  });

describe("GET /v1/advisor", () => {
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
    // The first person in a team is its owner; the next one a member.
    as.lead = caller(app, await join(web.invite, "lead@example.com"));
    as.ana = caller(app, await join(web.invite, "ana@example.com"));
    as.dora = caller(app, await join(data.invite, "dora@example.com"));
    const lead = [
      event({ kind: "session.started", session_id: "s-lead" }),
      cost("lead@example.com", "s-lead", 3),
    ];
    expect((await as.lead("/v1/events", "POST", { events: lead })).status).toBe(200);
    // Only the server records pull requests, from the GitHub App.
    const opened = event({
      kind: "pr.opened",
      source: "github",
      actor: { kind: "system", id: "github" },
      session_id: "s-lead",
      links: { pr_url: "https://github.com/acme/web/pull/1" },
    });
    await ledger.append([opened], { team: "web" });
    const ana = [
      event({
        kind: "session.started",
        session_id: "s-ana",
        actor: { kind: "person", id: "ana@example.com" },
      }),
      cost("ana@example.com", "s-ana", 2),
    ];
    expect((await as.ana("/v1/events", "POST", { events: ana })).status).toBe(200);
    const dora = [cost("dora@example.com", "s-dora", 7)];
    expect((await as.dora("/v1/events", "POST", { events: dora })).status).toBe(200);
  });

  afterAll(async () => {
    await ledger.close();
  });

  const advisor = async (who: ReturnType<typeof caller>, query = "") => {
    const res = await who(`/v1/advisor${query}`);
    return { status: res.status, body: (await res.json()) as AdvisorReport & ApiError };
  };

  it("gives an owner the team report of the teams they read", async () => {
    const { status, body } = await advisor(as.lead);
    expect(status).toBe(200);
    expect(body).toMatchObject({ schema: "selfhost.advisor/v1", scope: "team", teams: ["web"] });
    expect(body.from).toBe("2026-11-05T10:30:00.000Z");
    expect(body.spend.usd).toBe(5);
    expect(body.spend.by.map((row) => row.person)).toEqual(["lead@example.com", "ana@example.com"]);
    expect(body.shipped.opened).toBe(1);
  });

  it("gives a member only their own work, and refuses a team they are not in", async () => {
    const { status, body } = await advisor(as.ana);
    expect(status).toBe(200);
    expect(body).toMatchObject({ scope: "self", person: "ana@example.com", teams: ["web"] });
    expect(body.spend.by.map((row) => row.person)).toEqual(["ana@example.com"]);
    expect(body.shipped.opened).toBe(0);
    expect((await advisor(as.ana, "?team=data")).status).toBe(403);
  });

  it("gives the admin token every team, and checks the query", async () => {
    const { body } = await advisor(as.admin);
    expect(body).toMatchObject({ scope: "team", teams: null });
    expect(body.spend.usd).toBe(12);
    const earlier = await advisor(as.admin, "?to=2026-11-01T00:00:00.000Z");
    expect(earlier.body.spend.usd).toBe(0);
    expect((await advisor(as.admin, "?to=yesterday")).status).toBe(400);
  });

  it("sends the weekly note to owners and admins, and to members when [notify] advisor is everyone", async () => {
    const directory = serverDirectory(ledger, undefined);
    expect(await directory.advisor?.("lead@example.com", "default")).toEqual({ teams: ["web"] });
    expect(await directory.advisor?.("ana@example.com", "default")).toBeUndefined();
    const policy = `version = 1
[notify]
advisor = "everyone"
advisor_timezone = "Europe/Berlin"
`;
    expect((await as.lead("/v1/policy", "PUT", { text: policy })).status).toBe(200);
    expect(await directory.advisor?.("ana@example.com", "default")).toEqual({
      teams: ["web"],
      person: "ana@example.com",
    });
    expect((await directory.settingsFor("ana@example.com", "default"))?.advisor_timezone).toBe(
      "Europe/Berlin",
    );
    const off = `version = 1
[notify]
advisor = "off"
`;
    expect((await as.lead("/v1/policy", "PUT", { text: off })).status).toBe(200);
    expect(await directory.advisor?.("lead@example.com", "default")).toBeUndefined();
  });
});
