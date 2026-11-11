import { type Ledger, openLedger } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  type CreateTeamResponse,
  EVENT_SCHEMA,
  type JoinResponse,
  type NotifySettings,
  type ReviewItemsPage,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { serverDirectory } from "../src/notify.js";
import { caller, TOKEN } from "./helpers.js";

const open: Ledger[] = [];
afterEach(async () => {
  for (const ledger of open.splice(0)) await ledger.close();
});

let n = 0;
const id = () => `019a7000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
const ts = (minute: number) => new Date(Date.UTC(2026, 10, 11, 10, minute)).toISOString();

async function setup() {
  const ledger = await openLedger({ dataDir: "memory://" });
  open.push(ledger);
  const app: Hono = createApp({ version: "test", ledger, token: TOKEN });
  const admin = caller(app, TOKEN);
  const join = async (invite: string, person: string) => {
    const res = await app.request("/v1/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite, person }),
    });
    return ((await res.json()) as JoinResponse).token;
  };
  const team = async (name: string, org?: string) =>
    (await (
      await admin("/v1/teams", "POST", { name, ...(org ? { org } : {}) })
    ).json()) as CreateTeamResponse;
  const list = openReviewList(ledger, {});
  const refresh = () => refreshReviewList(ledger, list, { log: () => {} });
  return { ledger, app, admin, join, team, refresh };
}

describe("person ids are per org: notification targets", () => {
  it("keeps a person's targets from someone in another org under the same id", async () => {
    const h = await setup();
    await h.admin("/v1/orgs", "POST", { name: "acme" });
    await h.admin("/v1/orgs", "POST", { name: "evil" });
    const acme = await h.team("web", "acme");
    const evil = await h.team("mallory-co", "evil");
    const victim = caller(h.app, await h.join(acme.invite, "victim@acme.com"));
    expect(
      (
        await victim("/v1/notify/targets", "POST", {
          url: "tgram://123456:TOKEN/987",
          name: "phone",
        })
      ).status,
    ).toBe(201);

    // The other org's owner, under the victim's id.
    const attacker = caller(h.app, await h.join(evil.invite, "victim@acme.com"));
    expect(((await (await attacker("/v1/notify")).json()) as NotifySettings).targets).toEqual([]);
    expect((await attacker("/v1/notify/targets/phone", "DELETE")).status).toBe(404);
    expect(
      (
        await attacker("/v1/notify/targets", "POST", {
          url: "json://attacker.example/hook",
          name: "x",
        })
      ).status,
    ).toBe(201);
    expect((await attacker("/v1/notify/digest", "PUT", { digest: "off" })).status).toBe(200);

    const mine = (await (await victim("/v1/notify")).json()) as NotifySettings;
    expect(mine.targets.map((t) => t.name)).toEqual(["phone"]);
    expect(mine.digest_set).toBe(false);

    // The job reads each org's settings for that org only.
    const directory = serverDirectory(h.ledger, undefined);
    expect(await directory.settingsFor("victim@acme.com", "acme")).toBeDefined();
    expect(await directory.settingsFor("victim@acme.com", "other")).toBeUndefined();
    expect(await directory.orgOf?.("mallory-co")).toBe("evil");
  });

  it("checks the role for an any-host target in the caller's own org", async () => {
    const h = await setup();
    await h.admin("/v1/orgs", "POST", { name: "acme" });
    await h.admin("/v1/orgs", "POST", { name: "evil" });
    const acme = await h.team("web", "acme");
    await caller(h.app, await h.join(acme.invite, "lead@acme.com"));
    const member = caller(h.app, await h.join(acme.invite, "dev@acme.com"));
    // Owner of a team in another org under the same id.
    const evil = await h.team("own", "evil");
    await h.join(evil.invite, "dev@acme.com");
    expect(
      (await member("/v1/notify/targets", "POST", { url: "json://anywhere.example/hook" })).status,
    ).toBe(403);
  });
});

describe("writes into another team", () => {
  async function twoTeams() {
    const h = await setup();
    const web = await h.team("web");
    const data = await h.team("data");
    const lead = caller(h.app, await h.join(web.invite, "lead@example.com"));
    const dora = caller(h.app, await h.join(data.invite, "dora@example.com"));
    expect((await lead("/v1/teams/web/repos", "POST", { remote: "acme/web" })).status).toBe(201);
    return { ...h, lead, dora };
  }

  const PR = "https://github.com/acme/web/pull/7";
  const opened = () => ({
    id: id(),
    schema: EVENT_SCHEMA,
    ts: ts(0),
    source: "cli",
    kind: "pr.opened",
    repo: "acme/web",
    agent: { vendor: "claude_code" },
    links: { pr_url: PR },
    data: { title: "web PR" },
  });

  it("keeps a member's events naming another team's repo in their own team", async () => {
    const h = await twoTeams();
    expect((await h.lead("/v1/events", "POST", { events: [opened()] })).status).toBe(200);
    await h.refresh();
    const decision = {
      id: id(),
      schema: EVENT_SCHEMA,
      ts: ts(2),
      source: "cli",
      kind: "decision.recorded",
      repo: "acme/web",
      links: { pr_url: PR },
      decision: { verdict: "approve", by: "dora@example.com", reason: "lgtm from another team" },
    };
    expect((await h.dora("/v1/events", "POST", { events: [decision] })).status).toBe(200);
    await h.refresh();
    const [stored] = (await h.ledger.query({ kind: "decision.recorded" })).events;
    expect(stored?.team).toBe("data");
    const items = (await (await h.lead("/v1/review-items?team=web")).json()) as ReviewItemsPage;
    expect(items.items.map((i) => `${i.kind}:${i.state}`)).toEqual(["pr:open"]);
  });

  it("refuses review.submitted, pr.merged and pr.closed from a person token", async () => {
    const h = await twoTeams();
    expect((await h.lead("/v1/events", "POST", { events: [opened()] })).status).toBe(200);
    for (const kind of ["review.submitted", "pr.merged", "pr.closed"]) {
      const forged = {
        id: id(),
        schema: EVENT_SCHEMA,
        ts: ts(5),
        source: "github",
        kind,
        repo: "acme/web",
        links: { pr_url: PR },
        data: {
          second_opinion: { tool: "coderabbit", reviewer: "coderabbitai[bot]", verdict: "approve" },
        },
      };
      const res = await h.lead("/v1/events", "POST", { events: [forged] });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("only the GitHub App's webhook");
    }
    // The webhook's own write, as the reviewer's system actor, still counts.
    await h.ledger.append([
      {
        id: id(),
        schema: EVENT_SCHEMA,
        ts: ts(6),
        source: "github",
        kind: "review.submitted",
        actor: { kind: "system", id: "coderabbitai[bot]" },
        repo: "acme/web",
        links: { pr_url: PR },
        data: {
          second_opinion: { tool: "coderabbit", reviewer: "coderabbitai[bot]", verdict: "changes" },
        },
      },
    ]);
    await h.refresh();
    const items = (await (await h.lead("/v1/review-items?team=web")).json()) as ReviewItemsPage;
    expect(items.items[0]?.second_opinion).toMatchObject({ verdict: "changes" });
  });
});

describe("another person's waiting agent", () => {
  it("is answered and snoozed only by its person and the team's owners and admins", async () => {
    const h = await setup();
    const web = await h.team("web");
    const lead = caller(h.app, await h.join(web.invite, "lead@example.com"));
    const ana = caller(h.app, await h.join(web.invite, "ana@example.com"));
    const mia = caller(h.app, await h.join(web.invite, "mia@example.com"));
    const waiting = {
      id: id(),
      schema: EVENT_SCHEMA,
      ts: ts(10),
      source: "hook",
      kind: "approval.requested",
      session_id: "ana-session",
      agent: { vendor: "claude_code" },
      tool: { name: "Bash", input_summary: "rm -rf build" },
      data: { message: "Claude needs your permission to use Bash" },
    };
    expect((await ana("/v1/events", "POST", { events: [waiting] })).status).toBe(200);
    await h.refresh();
    const [item] = ((await (await ana("/v1/review-items")).json()) as ReviewItemsPage).items;
    expect(item).toMatchObject({ kind: "approval", owners: ["ana@example.com"] });
    const path = `/v1/review-items/${item?.id}`;
    const until = new Date(Date.UTC(2026, 10, 12)).toISOString();
    expect((await mia(`${path}/decision`, "POST", { verdict: "approve" })).status).toBe(403);
    expect((await mia(`${path}/snooze`, "POST", { until })).status).toBe(403);
    expect((await lead(`${path}/snooze`, "POST", { until })).status).toBe(200);
    expect((await ana(`${path}/decision`, "POST", { verdict: "deny" })).status).toBe(200);
  });
});
