import { type Ledger, openLedger } from "@selfhost/ledger";
import type {
  BudgetResponse,
  CreateTeamResponse,
  JoinResponse,
  LedgerEvent,
  RoiResponse,
  UsageResponse,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { raiseBudgetAlerts } from "../src/budget-alerts.js";
import { caller, TOKEN } from "./helpers.js";

/**
 * Spend is counted by the team and org an event was stored with. Three writers name the platform
 * team's repo acme/api: a platform member, a member of another team of the same org and a member
 * of another org. Only the platform member's spend is the platform team's, in usage, budget,
 * cost per merged PR and budget alerts.
 */

const NOW = new Date("2026-11-20T12:00:00.000Z");
const RANGE = "from=2026-11-01T00:00:00.000Z&to=2026-11-21T00:00:00.000Z";
const PR = "https://github.com/acme/api/pull/7";

let n = 0;
const event = (who: string, fields: Partial<LedgerEvent>): LedgerEvent => ({
  id: `019a7100-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`,
  schema: "selfhost.event/v1",
  ts: "2026-11-18T10:00:00.000Z",
  source: "local_log",
  kind: "cost.recorded",
  actor: { kind: "person", id: who },
  repo: "acme/api",
  ...fields,
});

const cost = (who: string, session: string, usd: number) =>
  event(who, {
    session_id: session,
    agent: { vendor: "claude_code" },
    model: "claude-opus-4",
    cost: {
      input_tokens: 10,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usd,
      estimated: true,
    },
  });

const commit = (who: string, session: string) =>
  event(who, {
    kind: "commit.created",
    source: "cli",
    session_id: session,
    links: { commit_sha: (++n).toString(16).padStart(40, "c"), pr_url: PR },
  });

const ledgers: Ledger[] = [];
afterEach(async () => {
  for (const ledger of ledgers.splice(0)) await ledger.close();
});

async function seeded() {
  const ledger = await openLedger({ dataDir: "memory://" });
  ledgers.push(ledger);
  const app: Hono = createApp({ version: "test", ledger, token: TOKEN, now: () => NOW });
  const admin = caller(app, TOKEN);
  const join = async (invite: string, person: string) => {
    const res = await app.request("/v1/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite, person }),
    });
    expect(res.status).toBe(200);
    return caller(app, ((await res.json()) as JoinResponse).token);
  };
  const team = async (name: string, org: string) =>
    (await (await admin("/v1/teams", "POST", { name, org })).json()) as CreateTeamResponse;
  expect((await admin("/v1/orgs", "POST", { name: "Acme" })).status).toBe(201);
  expect((await admin("/v1/orgs", "POST", { name: "Evil" })).status).toBe(201);
  const own = await join((await team("Platform", "acme")).invite, "pat@acme.com");
  const sibling = await join((await team("Web", "acme")).invite, "wes@acme.com");
  const outsider = await join((await team("Rivals", "evil")).invite, "mallory@evil.com");
  expect((await own("/v1/teams/platform/repos", "POST", { remote: "acme/api" })).status).toBe(201);
  const policy = "version = 1\n[budget]\nmonthly_usd = 10\n";
  expect((await own("/v1/policy", "PUT", { text: policy })).status).toBe(200);

  // Each writer spends in a session tied to the platform team's pull request.
  for (const [who, id, session, usd] of [
    [own, "pat@acme.com", "s-own", 6],
    [sibling, "wes@acme.com", "s-web", 40],
    [outsider, "mallory@evil.com", "s-evil", 400],
  ] as const) {
    const res = await who("/v1/events", "POST", {
      events: [cost(id, session, usd), commit(id, session)],
    });
    expect(res.status, await res.clone().text()).toBe(200);
  }
  const merged = event("pat@acme.com", {
    kind: "pr.merged",
    source: "github",
    ts: "2026-11-19T10:00:00.000Z",
    target: { type: "pr", value: PR },
    links: { pr_url: PR },
    agent: { vendor: "claude_code" },
    model: "claude-opus-4",
  });
  expect((await admin("/v1/events", "POST", { events: [merged] })).status).toBe(200);
  return { ledger, admin, own, sibling, outsider };
}

describe("spend naming another team's repo", () => {
  it("counts only the platform team's own spend in usage, budget, ROI and alerts", async () => {
    const h = await seeded();

    const usage = (await (
      await h.admin(`/v1/usage?${RANGE}&org=acme&group_by=team`)
    ).json()) as UsageResponse;
    expect(usage.rows.map((row) => [row.group.team, row.usd])).toEqual([
      ["web", 40],
      ["platform", 6],
    ]);
    expect(usage.total.usd).toBe(46);
    const mine = (await (await h.own(`/v1/usage?${RANGE}`)).json()) as UsageResponse;
    expect(mine.total.usd).toBe(6);
    const evil = (await (
      await h.admin(`/v1/usage?${RANGE}&org=evil&group_by=team`)
    ).json()) as UsageResponse;
    expect(evil.rows.map((row) => [row.group.team, row.usd])).toEqual([["rivals", 400]]);

    const budget = (await (await h.own("/v1/budget")).json()) as BudgetResponse;
    expect(budget.spent_usd).toBe(6);

    const roi = (await (await h.own(`/v1/teams/platform/roi?${RANGE}`)).json()) as RoiResponse;
    expect(roi.merged_prs).toBe(1);
    expect(roi.cost_usd).toBe(6);

    // $6 of $10 is past 50% only; the other writers' $440 would have crossed 100%.
    expect(await raiseBudgetAlerts(h.ledger, NOW)).toBe(1);
    const alerts = (await h.ledger.query({ kind: "alert.raised" })).events;
    expect(alerts.map((a) => [a.team, a.data?.alert, a.data?.percent])).toEqual([
      ["platform", "budget", 50],
    ]);
  });
});
