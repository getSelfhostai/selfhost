import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapClaudeCodeHook } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  type BudgetResponse,
  type CreateTeamResponse,
  createValidator,
  type EventsPage,
  type InvalidPolicyError,
  type JoinResponse,
  type LedgerEvent,
  type MeResponse,
  type OrgOverview,
  OrgOverviewSchema,
  type OrgPolicyResponse,
  OrgPolicyResponseSchema,
  type PolicyResponse,
  PolicyResponseSchema,
  type ReviewItemsPage,
  type TeamOverview,
  TeamOverviewSchema,
  type TeamRepo,
  type TeamReposResponse,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { BACKENDS, caller, TOKEN } from "./helpers.js";

/**
 * A fixture org: Acme with teams Web and Data, a lead in both, a developer shared between them,
 * one developer in each, repos mapped by remote URL, and org floor rules.
 */

const NOW = new Date("2026-11-20T12:00:00.000Z");
const TS = "2026-11-10T10:00:00.000Z";
/** Approvals wait for 30 minutes, so these are still open at NOW. */
const ASKED = "2026-11-20T11:55:00.000Z";

const ORG_FLOOR = `version = 1

[[rules]]
id = "no-force-push"
mode = "enforce"
match = { tool = "Bash", command = "git push --force" }
action = "block"
message = "No force pushes in Acme."

[mcp]
mode = "enforce"
allow = ["github", "acme-*"]

[[redaction]]
name = "ticket"
pattern = "ACME-[0-9]+"

[budget]
monthly_usd = 1000
`;

const WEB_POLICY = `version = 1

[[rules]]
id = "no-force-push"
mode = "enforce"
agents = ["all"]
match = { tool = "Bash", command = "git push --force" }
action = "block"
message = "Web never force pushes."

[[rules]]
id = "ask-before-deploy"
match = { tool = "Bash", command = "npm run deploy" }
action = "ask"
message = "Ask before deploying the site."

[mcp]
allow = ["github", "acme-web"]

[models]
allow = ["gpt-5*"]

[budget]
monthly_usd = 300
`;

const DATA_POLICY = `version = 1

[review]
fallback = ["dora@example.com"]

[budget]
monthly_usd = 100
`;

const notification = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "fixtures",
      "hooks",
      "claude-code",
      "Notification.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;

let n = 0;
const event = (overrides: Partial<LedgerEvent>): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: "selfhost.event/v1",
  ts: TS,
  source: "local_log",
  kind: "session.started",
  actor: { kind: "person", id: "x@example.com" },
  ...overrides,
});

const cost = (person: string, usd: number, overrides: Partial<LedgerEvent> = {}) =>
  event({
    kind: "cost.recorded",
    actor: { kind: "person", id: person },
    agent: { vendor: "claude_code" },
    model: "claude-opus-4",
    cost: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usd,
      estimated: true,
    },
    ...overrides,
  });

const matches = (schema: Parameters<typeof createValidator>[0], body: unknown) => {
  const result = createValidator(schema).validate(body);
  expect(result.ok ? [] : result.errors).toEqual([]);
};

describe.each(BACKENDS)("a fixture org with two teams on $name", (backend) => {
  let store: Awaited<ReturnType<(typeof BACKENDS)[number]["open"]>>;
  let app: Hono;
  let admin: ReturnType<typeof caller>;
  const as = {} as Record<"lead" | "wendy" | "dora" | "sam" | "dan", ReturnType<typeof caller>>;

  const joinTeam = async (invite: string, person: string) => {
    const res = await app.request("/v1/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite, person }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as JoinResponse;
  };

  const write = async (who: ReturnType<typeof caller>, events: LedgerEvent[]) => {
    const res = await who("/v1/events", "POST", { events });
    expect(res.status, await res.clone().text()).toBe(200);
  };

  const refresh = () =>
    refreshReviewList(store.ledger, openReviewList(store.ledger, { now: () => NOW }));

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
    const web = await team("Web");
    const data = await team("Data");
    as.lead = caller(app, (await joinTeam(web.invite, "lead@example.com")).token);
    as.wendy = caller(app, (await joinTeam(web.invite, "wendy@example.com")).token);
    as.sam = caller(app, (await joinTeam(web.invite, "sam@example.com")).token);
    as.dora = caller(app, (await joinTeam(data.invite, "dora@example.com")).token);
    as.dan = caller(app, (await joinTeam(data.invite, "dan@example.com")).token);
    // A person in one team joins another by being added, not with its team-wide invite.
    const refused = await app.request("/v1/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: data.invite, person: "sam@example.com" }),
    });
    expect(refused.status).toBe(401);
    expect(
      (await as.dora("/v1/teams/data/people", "POST", { person: "sam@example.com" })).status,
    ).toBe(201);
    expect(
      (
        await as.dora("/v1/teams/data/people", "POST", {
          person: "lead@example.com",
          role: "admin",
        })
      ).status,
    ).toBe(201);
  });

  afterAll(async () => {
    await store?.close();
  });

  it.skipIf(backend.skip)(
    "holds teams in one org, each person in the teams they joined",
    async () => {
      const me = await (await as.sam("/v1/me")).json();
      expect(me).toMatchObject({
        team: { id: "web", org: "acme" },
        memberships: [
          { team: "data", role: "member" },
          { team: "web", role: "member" },
        ],
      });
      const lead = (await (await as.lead("/v1/me")).json()) as MeResponse;
      expect(lead.memberships).toEqual([
        { team: "data", role: "admin" },
        { team: "web", role: "owner" },
      ]);
    },
  );

  it.skipIf(backend.skip)("gives each repo, by remote URL, to one team", async () => {
    const web = await as.lead("/v1/teams/web/repos", "POST", {
      remote: "https://github.com/Acme/Web.git",
    });
    expect(web.status).toBe(201);
    expect((await web.json()) as TeamRepo).toMatchObject({
      repo: "acme/web",
      remote: "github.com/acme/web",
      team: "web",
      org: "acme",
    });
    const data = await as.dora("/v1/teams/data/repos", "POST", {
      remote: "git@github.com:acme/pipeline.git",
    });
    expect(data.status).toBe(201);
    const taken = await as.dora("/v1/teams/data/repos", "POST", { remote: "acme/web" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: { code: "repo_taken" } });
    const bad = await as.dora("/v1/teams/data/repos", "POST", { remote: "not a remote" });
    expect(bad.status).toBe(400);
    const listed = (await (await as.sam("/v1/teams/data/repos")).json()) as TeamReposResponse;
    expect(listed.repos.map((r: TeamRepo) => r.repo)).toEqual(["acme/pipeline"]);
  });

  describe("org floor rules", () => {
    it.skipIf(backend.skip)("are set with the admin token only", async () => {
      const byLead = await as.lead("/v1/orgs/acme/policy", "PUT", { text: ORG_FLOOR });
      expect(byLead.status).toBe(403);
      expect((await as.lead("/v1/orgs/acme/policy")).status).toBe(404);
      const res = await admin("/v1/orgs/acme/policy", "PUT", { text: ORG_FLOOR });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OrgPolicyResponse;
      matches(OrgPolicyResponseSchema, body);
      expect(body).toMatchObject({ org: "acme", text: ORG_FLOOR, conflicts: [] });
      // Everyone in the org reads the floor; other orgs do not.
      expect((await as.dan("/v1/orgs/acme/policy")).status).toBe(200);
      expect((await as.dan("/v1/orgs/default/policy")).status).toBe(403);
      const invalid = await admin("/v1/orgs/acme/policy", "PUT", { text: "version = 2\n" });
      expect(invalid.status).toBe(400);
    });

    it.skipIf(backend.skip)(
      "refuse a team policy that relaxes them, naming the org rule",
      async () => {
        const relaxed = WEB_POLICY.replace(
          'mode = "enforce"\nagents = ["all"]',
          'mode = "observe"\nagents = ["all"]',
        ).replace('allow = ["github", "acme-web"]', 'allow = ["github", "slack"]');
        const res = await as.lead("/v1/policy?team=web", "PUT", { text: relaxed });
        expect(res.status).toBe(400);
        const body = (await res.json()) as InvalidPolicyError;
        expect(body.error.message).toMatch(/relaxes the org floor/);
        expect(body.errors).toEqual([
          {
            field: "rules[0].mode",
            org_rule: "no-force-push",
            message:
              'Relaxes org rule "no-force-push": mode "observe" is below the org\'s "enforce"',
            line: 5,
          },
          {
            field: "mcp.allow[1]",
            org_rule: "[mcp] allow",
            message: 'Widens the org\'s [mcp] allow: "slack" is not in it',
            line: 18,
          },
        ]);
        // Nothing was stored.
        expect((await as.wendy("/v1/policy")).status).toBe(200);
        expect(((await (await as.wendy("/v1/policy")).json()) as PolicyResponse).layers).toEqual([
          { kind: "org", name: "acme" },
        ]);
      },
    );

    it.skipIf(backend.skip)("let teams tighten them and add rules", async () => {
      expect((await as.lead("/v1/policy?team=web", "PUT", { text: WEB_POLICY })).status).toBe(200);
      expect((await as.dora("/v1/policy?team=data", "PUT", { text: DATA_POLICY })).status).toBe(
        200,
      );
      const res = await as.wendy("/v1/policy");
      const body = (await res.json()) as PolicyResponse;
      matches(PolicyResponseSchema, body);
      expect(body.layers).toEqual([
        { kind: "org", name: "acme" },
        { kind: "team", name: "web" },
      ]);
      expect(body.text).toMatch(/# The policy in use: org acme, then team web\./);
      expect(body.hash).toBe(
        createHash("sha256")
          .update(body.text ?? "")
          .digest("hex"),
      );
      expect(body.effective_rules.map((r) => [r.id, r.mode, r.message])).toEqual([
        ["no-force-push", "enforce", "Web never force pushes."],
        ["ask-before-deploy", "observe", "Ask before deploying the site."],
      ]);
      expect(body.config.mcp).toEqual({ mode: "enforce", allow: ["github", "acme-web"] });
      // Data's people get the org floor with Data's own settings, not Web's.
      const data = (await (await as.dan("/v1/policy")).json()) as PolicyResponse;
      expect(data.effective_rules.map((r) => r.id)).toEqual(["no-force-push"]);
      expect(data.config.review?.fallback).toEqual(["dora@example.com"]);
      expect(data.config.redaction?.map((r) => r.name)).toEqual(["ticket"]);
    });

    it.skipIf(backend.skip)("hold for a repo's own rules too", async () => {
      const relax = `version = 1
[[rules]]
id = "no-force-push"
mode = "off"
match = { tool = "Bash", command = "git push --force" }
action = "block"
message = "x"
`;
      const refused = await as.dora("/v1/policy?team=data&repo=acme/pipeline", "PUT", {
        text: relax,
      });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as InvalidPolicyError).errors[0]).toMatchObject({
        org_rule: "no-force-push",
      });
      const add = `version = 1
[[rules]]
id = "no-drop"
match = { tool = "Bash", command = "DROP TABLE" }
action = "block"
message = "Not in the pipeline."
`;
      expect(
        (await as.dora("/v1/policy?team=data&repo=acme/pipeline", "PUT", { text: add })).status,
      ).toBe(200);
      const repo = (await (await as.dan("/v1/policy?repo=acme/pipeline")).json()) as PolicyResponse;
      expect(repo.repo).toBe("acme/pipeline");
      expect(repo.effective_rules.map((r) => r.id)).toEqual(["no-force-push", "no-drop"]);
      // A repo of another team is not this team's.
      expect((await as.dan("/v1/policy?repo=acme/web")).status).toBe(404);
      expect(
        (await as.lead("/v1/policy?team=web&repo=acme/pipeline", "PUT", { text: add })).status,
      ).toBe(404);
    });

    it.skipIf(backend.skip)("win when the org raises them over a stored team policy", async () => {
      const raised = `${ORG_FLOOR}\n[models]\nallow = ["claude-*"]\n`;
      const res = await admin("/v1/orgs/acme/policy", "PUT", { text: raised });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OrgPolicyResponse;
      expect(body.conflicts).toEqual([
        {
          team: "web",
          field: "models.allow[0]",
          org_rule: "[models] allow",
          message: 'Widens the org\'s [models] allow: "gpt-5*" is not in it',
        },
      ]);
      const web = (await (await as.wendy("/v1/policy")).json()) as PolicyResponse;
      expect(web.config.models?.allow).toEqual(["claude-*"]);
      expect((await admin("/v1/orgs/acme/policy", "PUT", { text: ORG_FLOOR })).status).toBe(200);
    });
  });

  describe("runs, spend and review routing", () => {
    beforeAll(async () => {
      if (backend.skip) return;
      // Sam, in both teams, works through the Web token on Data's pipeline in Codex: the run
      // names its repo, so it is Data's.
      await write(as.sam, [
        event({
          actor: { kind: "person", id: "sam@example.com" },
          session_id: "codex-1",
          repo: "acme/pipeline",
          agent: { vendor: "codex" },
        }),
        cost("sam@example.com", 4, {
          session_id: "codex-1",
          agent: { vendor: "codex" },
          data: { note: "fixes ACME-12" },
        }),
      ]);
      // A Claude Code run of Sam's carries no repo, so it is Web's, the team Sam wrote it from...
      await write(as.sam, [
        cost("sam@example.com", 2, { session_id: "claude-1" }),
        cost("sam@example.com", 1, { session_id: "claude-1" }),
      ]);
      // ...and stays Web's when selfhost scan later finds its commit in the pipeline: repo
      // ownership never moves spend another team already holds.
      await write(as.sam, [
        event({
          kind: "commit.created",
          source: "cli",
          actor: { kind: "person", id: "sam@example.com" },
          session_id: "claude-1",
          repo: "acme/pipeline",
          links: { commit_sha: "abc1234" },
        }),
      ]);
      await write(as.wendy, [
        cost("wendy@example.com", 10, { session_id: "web-1", repo: "acme/web" }),
      ]);
      await write(as.dan, [cost("dan@example.com", 50)]);
      // Approvals: one in Data's run, one in Web's.
      await write(
        as.sam,
        mapClaudeCodeHook(
          { ...notification, session_id: "codex-1" },
          { ts: ASKED, person: "sam@example.com" },
        ),
      );
      await write(
        as.wendy,
        mapClaudeCodeHook(
          { ...notification, session_id: "web-1" },
          { ts: ASKED, person: "wendy@example.com" },
        ),
      );
      await refresh();
    });

    it.skipIf(backend.skip)("assigns every run to the team that owns its repo", async () => {
      const page = (await (await as.dora("/v1/events?limit=1000")).json()) as EventsPage;
      const sessions = new Set(page.events.map((e) => e.session_id));
      expect(sessions.has("codex-1")).toBe(true);
      expect(page.events.every((e) => e.team === "data")).toBe(true);
      // The org's redaction floor applied to Data's event.
      const note = page.events.find((e) => e.data?.note !== undefined)?.data?.note;
      expect(note).toBe("fixes [redacted:ticket]");
      // Sam reads Data's events as a member there; Wendy is not in Data.
      expect((await as.sam("/v1/events?team=data")).status).toBe(200);
      expect((await as.wendy("/v1/events?team=data")).status).toBe(403);
    });

    it.skipIf(backend.skip)("routes review items to the team of the run", async () => {
      const data = (await (await as.dora("/v1/review-items")).json()) as ReviewItemsPage;
      expect(data.items.map((i) => [i.session_id, i.owners])).toEqual([
        ["codex-1", ["sam@example.com"]],
      ]);
      const web = (await (await as.wendy("/v1/review-items")).json()) as ReviewItemsPage;
      expect(web.items.map((i) => i.session_id)).toEqual(["web-1"]);
      // Sam answers Data's item with the Web token: they are in Data too.
      const sam = (await (await as.sam("/v1/review-items?team=data")).json()) as ReviewItemsPage;
      const [item] = sam.items;
      expect(item?.session_id).toBe("codex-1");
      expect((await as.wendy(`/v1/review-items/${item?.id}`)).status).toBe(404);
      expect((await as.wendy("/v1/review-items?team=data")).status).toBe(403);
      const answered = await as.sam(`/v1/review-items/${item?.id}/decision`, "POST", {
        verdict: "approve",
      });
      expect(answered.status).toBe(200);
    });

    it.skipIf(backend.skip)("shows spend, budget and review per team", async () => {
      const res = await as.dan("/v1/teams/data/overview");
      expect(res.status).toBe(200);
      const data = (await res.json()) as TeamOverview;
      matches(TeamOverviewSchema, data);
      expect(data).toMatchObject({
        team: { id: "data", org: "acme" },
        people: 4,
        repos: ["acme/pipeline"],
        spend: { usd: 54, requests: 2 },
        budget: { period: "month", spent_usd: 54, limit_usd: 100, remaining_usd: 46 },
        review: { open: 0 },
      });
      expect(data.by_person).toEqual([
        { key: "dan@example.com", usd: 50, tokens: 1100, requests: 1 },
        { key: "sam@example.com", usd: 4, tokens: 1100, requests: 1 },
      ]);
      const web = (await (await as.wendy("/v1/teams/web/overview")).json()) as TeamOverview;
      expect(web).toMatchObject({
        spend: { usd: 13, requests: 3 },
        budget: { limit_usd: 300, spent_usd: 13 },
        review: { open: 1, blocking: 1 },
      });
      expect((await as.wendy("/v1/teams/data/overview")).status).toBe(403);

      const budget = (await (await as.wendy("/v1/budget")).json()) as BudgetResponse;
      expect(budget).toMatchObject({
        period: "month",
        from: "2026-11-01T00:00:00.000Z",
        to: "2026-12-01T00:00:00.000Z",
        spent_usd: 13,
        limit_usd: 300,
        remaining_usd: 287,
      });
      expect(budget.forecast_usd).toBeCloseTo(13 / (19.5 / 30), 2);
      const samInData = (await (
        await as.dora("/v1/budget?team=data&person=sam%40example.com")
      ).json()) as BudgetResponse;
      expect(samInData).toMatchObject({ spent_usd: 4, limit_usd: null, remaining_usd: null });
      const week = (await (await as.dora("/v1/budget?period=week")).json()) as BudgetResponse;
      expect(week).toMatchObject({
        from: "2026-11-16T00:00:00.000Z",
        spent_usd: 0,
        limit_usd: null,
      });
    });

    it.skipIf(backend.skip)("gives the lead a cross-team view, and no one else", async () => {
      const res = await as.lead("/v1/orgs/acme/overview");
      expect(res.status).toBe(200);
      const view = (await res.json()) as OrgOverview;
      matches(OrgOverviewSchema, view);
      expect(view.teams.map((t) => [t.team.id, t.spend.usd])).toEqual([
        ["data", 54],
        ["web", 13],
      ]);
      expect(view.total).toMatchObject({ usd: 67, requests: 5 });
      // The org budget is the org's, set in its floor; no team's spend is charged to another.
      expect(view.budget).toMatchObject({ limit_usd: 1000, spent_usd: 67 });
      expect(view).toMatchObject({ from: "2026-11-01T00:00:00.000Z", to: NOW.toISOString() });

      // An owner of one team sees that team only, and not the org's budget.
      const dora = (await (await as.dora("/v1/orgs/acme/overview")).json()) as OrgOverview;
      expect(dora.teams.map((t) => t.team.id)).toEqual(["data"]);
      expect(dora.budget).toBeNull();
      for (const member of [as.wendy, as.sam, as.dan]) {
        expect((await member("/v1/orgs/acme/overview")).status).toBe(403);
      }
      expect((await as.lead("/v1/orgs/default/overview")).status).toBe(403);
      const all = (await (await admin("/v1/orgs/acme/overview")).json()) as OrgOverview;
      expect(all.teams).toHaveLength(2);
      const window = await as.lead(
        "/v1/orgs/acme/overview?from=2026-11-11T00:00:00Z&to=2026-11-20T00:00:00Z",
      );
      expect(((await window.json()) as OrgOverview).total.usd).toBe(0);
      expect(
        (await as.lead("/v1/orgs/acme/overview?from=2026-11-20T00:00:00Z&to=2026-11-01T00:00:00Z"))
          .status,
      ).toBe(400);
    });
  });

  it.skipIf(backend.skip)("leaves a single-team install as it was", async () => {
    const res = await admin("/v1/teams", "POST", { name: "Solo" });
    const solo = (await res.json()) as CreateTeamResponse;
    expect(solo.team).toMatchObject({ id: "solo", org: "default" });
    const owner = caller(app, (await joinTeam(solo.invite, "lone@example.com")).token);
    const text = "version = 1\n# our rules\n";
    expect((await owner("/v1/policy", "PUT", { text })).status).toBe(200);
    const policy = (await (await owner("/v1/policy")).json()) as PolicyResponse;
    expect(policy).toMatchObject({ text, layers: [{ kind: "team", name: "solo" }] });
    expect(policy.hash).toBe(createHash("sha256").update(text).digest("hex"));
    await write(owner, [cost("lone@example.com", 3, { repo: "acme/web" })]);
    // acme/web is Acme's, not the default org's: the event stays with the writer's team.
    const page = (await (await owner("/v1/events")).json()) as EventsPage;
    expect(page.events.map((e) => e.team)).toEqual(["solo"]);
  });
});
