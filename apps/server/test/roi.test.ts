import {
  type CreateTeamResponse,
  createValidator,
  type JoinResponse,
  type LedgerEvent,
  ROI_DEFINITION,
  type RoiResponse,
  RoiResponseSchema,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { BACKENDS, caller, TOKEN } from "./helpers.js";

/**
 * GET /v1/teams/{team}/roi on a ledger written through the API with person tokens. Org Acme:
 * Web owns acme/site, Data owns acme/etl.
 *
 * Web's first week (11-02 to 11-09): b1 spends $3, joined to site/9 (merged, claude_code).
 * => 1 merged agent PR at $3.
 * The range (11-09 to 11-16): w1 spends $6, joined to site/1 (merged, claude_code
 * claude-opus-4); w2 spends $2 in acme/site joined to nothing, shared to site/1; site/2 merges
 * with no agent. => 1 agent PR, $6 + $2 = $8, 1 human PR.
 * Data: d1 spends $5 joined to etl/1 (merged, codex); its first event is on 11-12.
 */

const NOW = new Date("2026-11-16T12:00:00.000Z");
const RANGE = "from=2026-11-09T00:00:00.000Z&to=2026-11-16T00:00:00.000Z";
const SITE = "https://github.com/acme/site/pull";
const LEAD = "lead@example.com";
const DORA = "dora@example.com";

let n = 0;
const event = (who: string, fields: Partial<LedgerEvent>): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: "selfhost.event/v1",
  ts: "2026-11-10T09:00:00.000Z",
  source: "otel",
  kind: "session.started",
  actor: { kind: "person", id: who },
  ...fields,
});

const spend = (
  who: string,
  session: string,
  usd: number,
  ts: string,
  repo: string,
  vendor = "claude_code",
) =>
  event(who, {
    kind: "cost.recorded",
    ts,
    session_id: session,
    repo,
    agent: { vendor: vendor as "claude_code" },
    cost: {
      input_tokens: 10,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usd,
      estimated: true,
    },
  });

const commit = (who: string, session: string, pr: string, repo: string) =>
  event(who, {
    kind: "commit.created",
    source: "cli",
    session_id: session,
    repo,
    links: { commit_sha: (++n).toString(16).padStart(40, "b"), pr_url: pr },
  });

const merged = (
  who: string,
  url: string,
  ts: string,
  repo: string,
  agent?: LedgerEvent["agent"],
  model?: string,
) =>
  event(who, {
    kind: "pr.merged",
    source: "github",
    ts,
    repo,
    target: { type: "pr", value: url },
    links: { pr_url: url },
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
  });

const WEB_EVENTS = [
  spend(LEAD, "b1", 3, "2026-11-02T10:00:00.000Z", "acme/site"),
  commit(LEAD, "b1", `${SITE}/9`, "acme/site"),
  merged(LEAD, `${SITE}/9`, "2026-11-03T10:00:00.000Z", "acme/site", { vendor: "claude_code" }),
  spend(LEAD, "w1", 6, "2026-11-10T10:00:00.000Z", "acme/site"),
  commit(LEAD, "w1", `${SITE}/1`, "acme/site"),
  merged(
    LEAD,
    `${SITE}/1`,
    "2026-11-10T12:00:00.000Z",
    "acme/site",
    { vendor: "claude_code" },
    "claude-opus-4",
  ),
  spend(LEAD, "w2", 2, "2026-11-11T10:00:00.000Z", "acme/site", "codex"),
  merged(LEAD, `${SITE}/2`, "2026-11-11T12:00:00.000Z", "acme/site"),
];

const DATA_EVENTS = [
  spend(DORA, "d1", 5, "2026-11-12T10:00:00.000Z", "acme/etl", "codex"),
  commit(DORA, "d1", "https://github.com/acme/etl/pull/1", "acme/etl"),
  merged(DORA, "https://github.com/acme/etl/pull/1", "2026-11-12T12:00:00.000Z", "acme/etl", {
    vendor: "codex",
  }),
];

const valid = createValidator(RoiResponseSchema);

describe.each(BACKENDS)("cost per merged PR over the API on $name", (backend) => {
  let store: Awaited<ReturnType<(typeof BACKENDS)[number]["open"]>>;
  let app: Hono;
  let admin: ReturnType<typeof caller>;
  const as = {} as Record<string, ReturnType<typeof caller>>;

  const join = async (invite: string, id: string) => {
    const res = await app.request("/v1/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite, person: id }),
    });
    expect(res.status).toBe(200);
    as[id] = caller(app, ((await res.json()) as JoinResponse).token);
  };

  const roi = async (who: ReturnType<typeof caller>, team: string, query = RANGE) => {
    const res = await who(`/v1/teams/${team}/roi?${query}`);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as RoiResponse;
    const checked = valid.validate(body);
    expect(checked.ok ? [] : checked.errors).toEqual([]);
    return body;
  };

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    app = createApp({ version: "test", ledger: store.ledger, token: TOKEN, now: () => NOW });
    admin = caller(app, TOKEN);
    expect((await admin("/v1/orgs", "POST", { name: "Acme" })).status).toBe(201);
    const team = async (name: string) =>
      (await (
        await admin("/v1/teams", "POST", { name, org: "acme" })
      ).json()) as CreateTeamResponse;
    await join((await team("Web")).invite, LEAD);
    await join((await team("Data")).invite, DORA);
    const lead = as[LEAD] as ReturnType<typeof caller>;
    const dora = as[DORA] as ReturnType<typeof caller>;
    expect((await lead("/v1/teams/web/repos", "POST", { remote: "acme/site" })).status).toBe(201);
    expect((await dora("/v1/teams/data/repos", "POST", { remote: "acme/etl" })).status).toBe(201);
    // Merges come from the GitHub App's webhook, which writes with the server's own access; a
    // person token cannot write them.
    const fromGitHub = (event: LedgerEvent) => event.kind === "pr.merged";
    for (const [who, events] of [
      [lead, WEB_EVENTS],
      [dora, DATA_EVENTS],
    ] as const) {
      const res = await who("/v1/events", "POST", {
        events: events.filter((event) => !fromGitHub(event)),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const merges = await admin("/v1/events", "POST", { events: events.filter(fromGitHub) });
      expect(merges.status, await merges.clone().text()).toBe(200);
    }
  });

  afterAll(async () => {
    await store?.close();
  });

  it.skipIf(backend.skip)("answers the team's numbers and its first-week baseline", async () => {
    expect(await roi(as[LEAD] as ReturnType<typeof caller>, "web")).toEqual({
      schema: "selfhost.roi/v1",
      definition: ROI_DEFINITION,
      team: "web",
      from: "2026-11-09T00:00:00.000Z",
      to: "2026-11-16T00:00:00.000Z",
      merged_prs: 1,
      cost_usd: 8,
      cost_per_merged_pr: 8,
      human_prs: 1,
      closed_prs: 0,
      attributed_usd: 6,
      shared_usd: 2,
      unattributed_usd: 2,
      closed_usd: 0,
      unallocated_usd: 0,
      baseline: {
        from: "2026-11-02T00:00:00.000Z",
        to: "2026-11-09T00:00:00.000Z",
        merged_prs: 1,
        cost_usd: 3,
        cost_per_merged_pr: 3,
        human_prs: 0,
        period: "first_week",
        definition: ROI_DEFINITION,
        computed_at: NOW.toISOString(),
      },
      by_agent: [
        {
          agent: "claude_code",
          model: "claude-opus-4",
          merged_prs: 1,
          cost_usd: 8,
          cost_per_merged_pr: 8,
        },
      ],
    });
  });

  it.skipIf(backend.skip)(
    "keeps each team to its own numbers, with the admin token too",
    async () => {
      const data = await roi(admin, "data");
      expect(data).toMatchObject({ team: "data", merged_prs: 1, cost_usd: 5, baseline: null });
      expect(data.by_agent).toEqual([
        { agent: "codex", model: "unknown", merged_prs: 1, cost_usd: 5, cost_per_merged_pr: 5 },
      ]);
    },
  );

  it.skipIf(backend.skip)(
    "defaults to the last 7 days and shows no value with no merge",
    async () => {
      const body = await roi(as[LEAD] as ReturnType<typeof caller>, "web", "");
      expect(body).toMatchObject({
        from: "2026-11-09T12:00:00.000Z",
        to: NOW.toISOString(),
        merged_prs: 1,
      });
      const empty = await roi(
        admin,
        "web",
        "from=2026-11-14T00:00:00.000Z&to=2026-11-16T00:00:00.000Z",
      );
      expect(empty).toMatchObject({ merged_prs: 0, cost_usd: 0, cost_per_merged_pr: null });
    },
  );

  it.skipIf(backend.skip)("uses the baseline period [roi] sets, frozen apart", async () => {
    const res = await admin("/v1/policy?team=web", "PUT", {
      text: 'version = 1\n\n[roi]\nbaseline_from = "2026-11-09"\nbaseline_to = "2026-11-16"\n',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await roi(admin, "web");
    expect(body.baseline).toMatchObject({
      from: "2026-11-09T00:00:00.000Z",
      to: "2026-11-16T00:00:00.000Z",
      merged_prs: 1,
      cost_usd: 8,
      period: "configured",
    });
  });

  it.skipIf(backend.skip)(
    "refuses people of other teams, bad ranges and unknown teams",
    async () => {
      const dora = as[DORA] as ReturnType<typeof caller>;
      expect((await dora(`/v1/teams/web/roi?${RANGE}`)).status).toBe(403);
      expect((await admin("/v1/teams/nope/roi")).status).toBe(404);
      const backwards = "from=2026-11-16T00:00:00.000Z&to=2026-11-09T00:00:00.000Z";
      expect((await admin(`/v1/teams/web/roi?${backwards}`)).status).toBe(400);
      expect((await admin("/v1/teams/web/roi?team=web")).status).toBe(400);
    },
  );
});
