import {
  type CreateTeamResponse,
  createValidator,
  type JoinResponse,
  type LedgerEvent,
  SANDBOX_RECORD_SCHEMA,
  type SandboxWasteResponse,
  SandboxWasteResponseSchema,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { BACKENDS, caller, TOKEN } from "./helpers.js";

/**
 * GET /v1/teams/{team}/sandboxes on events a team's runner wrote: run-1's E2B sandbox billed an
 * hour, 90% of it idle; run-2's sandbox still runs 40 minutes after the run ended.
 */
const NOW = new Date("2026-11-09T12:00:00.000Z");
const LEAD = "lead@example.com";
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind" | "ts">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: "selfhost.event/v1",
  source: "server",
  actor: { kind: "person", id: LEAD },
  ...fields,
});

const box = (
  kind: "sandbox.started" | "sandbox.stopped",
  minutesAgo: number,
  id: string,
  run: string,
  extra: Record<string, unknown> = {},
  usd?: number,
) =>
  event({
    kind,
    ts: at(minutesAgo),
    run_id: run,
    data: {
      sandbox: {
        schema: SANDBOX_RECORD_SCHEMA,
        runtime: "e2b",
        sandbox_id: id,
        usd_per_hour: 0.1656,
        billing: "reserved",
        ...extra,
      },
      owner: LEAD,
    },
    ...(usd === undefined
      ? {}
      : {
          cost: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            usd,
            estimated: true,
          },
        }),
  });

const EVENTS = [
  box("sandbox.started", 240, "e1", "run-1"),
  box(
    "sandbox.stopped",
    180,
    "e1",
    "run-1",
    { reason: "run_ended", billed_seconds: 3600, busy_seconds: 360, idle_seconds: 3240 },
    0.1656,
  ),
  event({
    kind: "cost.recorded",
    ts: at(200),
    run_id: "run-1",
    cost: {
      input_tokens: 9,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usd: 1.5,
      estimated: true,
    },
  }),
  box("sandbox.started", 100, "e2", "run-2"),
  event({ kind: "session.ended", ts: at(40), run_id: "run-2", source: "hook" }),
];

const valid = createValidator(SandboxWasteResponseSchema);

describe.each(BACKENDS)("sandbox waste over the API on $name", (backend) => {
  let store: Awaited<ReturnType<(typeof BACKENDS)[number]["open"]>>;
  let app: Hono;
  let lead: ReturnType<typeof caller>;

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    app = createApp({ version: "test", ledger: store.ledger, token: TOKEN, now: () => NOW });
    const admin = caller(app, TOKEN);
    expect((await admin("/v1/orgs", "POST", { name: "Acme" })).status).toBe(201);
    const team = (await (
      await admin("/v1/teams", "POST", { name: "Web", org: "acme" })
    ).json()) as CreateTeamResponse;
    const res = await app.request("/v1/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: team.invite, person: LEAD }),
    });
    lead = caller(app, ((await res.json()) as JoinResponse).token);
    const sent = await lead("/v1/events", "POST", { events: EVENTS });
    expect(sent.status, await sent.clone().text()).toBe(200);
  });

  afterAll(async () => {
    await store?.close();
  });

  it.skipIf(backend.skip)("answers idle share, leftovers and per-run cost", async () => {
    const res = await lead("/v1/teams/web/sandboxes");
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as SandboxWasteResponse;
    const checked = valid.validate(body);
    expect(checked.ok ? [] : checked.errors).toEqual([]);
    expect(body).toMatchObject({ team: "web", leftover_minutes: 15 });
    expect(body.leftovers).toMatchObject([
      { sandbox_id: "e2", run_id: "run-2", owner: LEAD, stopped_at: null, minutes_after_run: 40 },
    ]);
    expect(body.runs.find((run) => run.run_id === "run-1")).toMatchObject({
      idle_seconds: 3240,
      sandbox_usd: 0.1656,
      model_usd: 1.5,
    });
    const week = body.windows[0];
    expect(week?.by_runtime[0]).toMatchObject({ runtime: "e2b", sandboxes: 2 });
    expect(week?.by_runtime[0]?.idle_share).toBeGreaterThan(0.5);
    expect(week?.by_runtime[0]?.suggestion?.text).toContain("active CPU only");
  });

  it.skipIf(backend.skip)(
    "takes leftover_minutes from the query, and refuses a bad one",
    async () => {
      const res = await lead("/v1/teams/web/sandboxes?leftover_minutes=60");
      expect(((await res.json()) as SandboxWasteResponse).leftovers).toEqual([]);
      expect((await lead("/v1/teams/web/sandboxes?leftover_minutes=0")).status).toBe(400);
      expect((await lead("/v1/teams/nope/sandboxes")).status).toBe(403);
    },
  );
});
