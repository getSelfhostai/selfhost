import type { LedgerEvent } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db.js";
import { MIGRATIONS } from "../src/migrations.generated.js";
import type { JoinResult, TeamStore } from "../src/teams.js";
import { BACKENDS, makeEvent, type Store } from "./helpers.js";

function joined(result: Awaited<ReturnType<TeamStore["join"]>>): JoinResult {
  if ("refused" in result) throw new Error(`join refused: ${result.refused}`);
  return result;
}

const cost = (n: number, overrides: Partial<LedgerEvent> = {}): LedgerEvent =>
  makeEvent(n, {
    kind: "cost.recorded",
    source: "local_log",
    agent: { vendor: "claude_code" },
    model: "claude-opus-4",
    cost: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usd: 1,
      estimated: true,
    },
    ...overrides,
  });

describe.each(BACKENDS)("orgs, roles and repos on $name", (backend) => {
  let store: Store;
  let teams: TeamStore;

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    teams = store.ledger.teams;
  });

  afterAll(async () => {
    await store?.close();
  });

  async function teamWith(id: string, org: string | undefined, people: string[]) {
    const created = await teams.createTeam({ id, name: id, ...(org ? { org } : {}) });
    if (!created) throw new Error(`team ${id} not created`);
    const tokens: Record<string, string> = {};
    for (const person of people) {
      tokens[person] = joined(await teams.join(created.invite, { id: person })).token;
    }
    return tokens;
  }

  /** A token for someone already in the org, from an invite for their email. */
  async function invited(team: string, person: string) {
    const invite = await teams.createInvite(team, { email: person });
    return joined(await teams.join(invite?.invite ?? "", { id: person })).token;
  }

  it.skipIf(backend.skip)("puts teams in the default org unless told otherwise", async () => {
    await teamWith("solo", undefined, []);
    expect(await teams.getTeam("solo")).toMatchObject({ id: "solo", org: "default" });
    expect(await store.ledger.orgs.getOrg("default")).toMatchObject({ id: "default" });
    expect(await teams.createTeam({ id: "orphan", name: "Orphan", org: "nope" })).toBeUndefined();
    expect(await teams.getTeam("orphan")).toBeUndefined();

    expect(await store.ledger.orgs.createOrg({ id: "acme", name: "Acme" })).toMatchObject({
      id: "acme",
      name: "Acme",
    });
    expect(await store.ledger.orgs.createOrg({ id: "acme", name: "Again" })).toBeUndefined();
    await teamWith("acme-web", "acme", []);
    expect((await teams.listTeams("acme")).map((t) => t.id)).toEqual(["acme-web"]);
    expect(await teams.renameTeam("acme-web", "Web")).toMatchObject({ name: "Web", org: "acme" });
    expect(await teams.renameTeam("missing", "x")).toBeUndefined();
  });

  it.skipIf(backend.skip)("changes roles, keeping at least one owner", async () => {
    await teamWith("roles", undefined, ["ada@example.com", "bob@example.com"]);
    expect(await teams.setRole("roles", "ada@example.com", "member", "ada@example.com")).toEqual({
      refused: "last_owner",
    });
    expect(await teams.setRole("roles", "eve@example.com", "admin", "ada@example.com")).toEqual({
      refused: "not_found",
    });
    const promoted = await teams.setRole("roles", "bob@example.com", "owner", "ada@example.com");
    expect(promoted).toMatchObject({ person: { id: "bob@example.com", role: "owner" } });
    const demoted = await teams.setRole("roles", "ada@example.com", "admin", "bob@example.com");
    expect(demoted).toMatchObject({ person: { role: "admin" } });
    const [row] = await store.db.query<{ role_changed_by: string; role_changed_at: unknown }>(
      "SELECT role_changed_by, role_changed_at FROM people WHERE team_id = 'roles' AND id = 'ada@example.com'",
    );
    expect(row?.role_changed_by).toBe("bob@example.com");
    expect(row?.role_changed_at).not.toBeNull();
    expect((await teams.listPeople("roles")).map((p) => [p.id, p.role])).toEqual([
      ["bob@example.com", "owner"],
      ["ada@example.com", "admin"],
    ]);

    // Two owners demoting each other at once still leave one.
    await teams.setRole("roles", "ada@example.com", "owner", "bob@example.com");
    const both = await Promise.all([
      teams.setRole("roles", "ada@example.com", "member", "bob@example.com"),
      teams.setRole("roles", "bob@example.com", "member", "ada@example.com"),
    ]);
    expect(both.filter((r) => "refused" in r)).toEqual([{ refused: "last_owner" }]);
    const owners = (await teams.listPeople("roles")).filter((p) => p.role === "owner");
    expect(owners).toHaveLength(1);

    // The database refuses it too.
    await expect(
      store.db.query("UPDATE people SET role = 'member' WHERE team_id = 'roles'"),
    ).rejects.toThrow(/would have no owner/);
  });

  it.skipIf(backend.skip)("adds org people to more teams and lists their memberships", async () => {
    await store.ledger.orgs.createOrg({ id: "multi", name: "Multi" });
    await teamWith("multi-a", "multi", ["lead@example.com", "dev@example.com"]);
    await teamWith("multi-b", "multi", ["other@example.com"]);
    await teamWith("elsewhere", undefined, ["stranger@example.com"]);

    expect(await teams.addPerson("multi-b", "Lead@Example.com", "admin", "x")).toMatchObject({
      person: { id: "lead@example.com", team: "multi-b", role: "admin" },
    });
    expect(await teams.addPerson("multi-b", "lead@example.com", "member", "x")).toEqual({
      refused: "existing_person",
    });
    expect(await teams.addPerson("multi-b", "stranger@example.com", "member", "x")).toEqual({
      refused: "not_in_org",
    });
    expect(await teams.addPerson("missing", "lead@example.com", "member", "x")).toEqual({
      refused: "no_team",
    });
    expect(await teams.memberships("multi", "LEAD@example.com")).toEqual([
      { team: "multi-a", role: "owner" },
      { team: "multi-b", role: "admin" },
    ]);
    expect(await teams.memberships("default", "lead@example.com")).toEqual([]);
    expect(await teams.getPerson("multi-b", "lead@example.com")).toMatchObject({ role: "admin" });
  });

  it.skipIf(backend.skip)(
    "ends a revoked membership, so a token from another team of the org no longer reaches it",
    async () => {
      await store.ledger.orgs.createOrg({ id: "gone", name: "Gone" });
      const a = await teamWith("gone-a", "gone", ["owner-a@example.com", "eve@example.com"]);
      const b = await teamWith("gone-b", "gone", ["owner-b@example.com"]);
      b["eve@example.com"] = await invited("gone-b", "eve@example.com");
      await teams.setRole("gone-a", "eve@example.com", "admin", "owner-a@example.com");
      expect(await teams.memberships("gone", "eve@example.com")).toEqual([
        { team: "gone-a", role: "admin" },
        { team: "gone-b", role: "member" },
      ]);

      expect(await teams.revokePerson("gone-a", "eve@example.com")).toMatchObject({ revoked: 1 });
      // Her token for gone-b still works, for gone-b only.
      expect(await teams.personForToken(b["eve@example.com"] ?? "")).toMatchObject({
        team: "gone-b",
      });
      expect(await teams.personForToken(a["eve@example.com"] ?? "")).toBeUndefined();
      expect(await teams.memberships("gone", "eve@example.com")).toEqual([
        { team: "gone-b", role: "member" },
      ]);
      expect(await teams.getPerson("gone-a", "eve@example.com")).toBeUndefined();
      expect((await teams.listPeople("gone-a")).map((p) => p.id)).toEqual(["owner-a@example.com"]);
      expect((await store.ledger.orgs.peopleCounts(["gone-a"])).get("gone-a")).toBe(1);
      expect((await teams.peopleWithAccess("eve@example.com")).map((a) => a.person.team)).toEqual([
        "gone-b",
      ]);
      expect(await teams.setRole("gone-a", "eve@example.com", "member", "x")).toEqual({
        refused: "not_found",
      });
      // Revoking again finds her, and changes nothing.
      expect(await teams.revokePerson("gone-a", "eve@example.com")).toMatchObject({ revoked: 0 });

      // Added back from her other team: a member again, with the role given now.
      expect(await teams.addPerson("gone-a", "eve@example.com", "member", "x")).toMatchObject({
        person: { team: "gone-a", role: "member" },
      });
      expect(await teams.memberships("gone", "eve@example.com")).toEqual([
        { team: "gone-a", role: "member" },
        { team: "gone-b", role: "member" },
      ]);
      // Someone revoked from every team of the org is in no other team to be added from.
      await teams.revokePerson("gone-a", "eve@example.com");
      await teams.revokePerson("gone-b", "eve@example.com");
      expect(await teams.addPerson("gone-a", "eve@example.com", "member", "x")).toEqual({
        refused: "not_in_org",
      });
    },
  );

  it.skipIf(backend.skip)(
    "ends the membership of someone added from another team when they are revoked",
    async () => {
      await store.ledger.orgs.createOrg({ id: "added", name: "Added" });
      await teamWith("added-a", "added", ["owner-a@example.com"]);
      const b = await teamWith("added-b", "added", ["fay@example.com"]);
      await teams.addPerson("added-a", "fay@example.com", "admin", "owner-a@example.com");
      expect(await teams.memberships("added", "fay@example.com")).toHaveLength(2);
      // She holds no token for added-a: before, revoking her there changed nothing.
      expect(await teams.revokePerson("added-a", "fay@example.com")).toMatchObject({ revoked: 0 });
      expect(await teams.memberships("added", "fay@example.com")).toEqual([
        { team: "added-b", role: "owner" },
      ]);
      expect(await teams.personForToken(b["fay@example.com"] ?? "")).toMatchObject({
        team: "added-b",
      });
    },
  );

  it.skipIf(backend.skip)("ends a membership when its last token leaves the team", async () => {
    await store.ledger.orgs.createOrg({ id: "leave", name: "Leave" });
    const a = await teamWith("leave-a", "leave", ["owner@example.com", "gus@example.com"]);
    const b = await teamWith("leave-b", "leave", ["owner-b@example.com"]);
    b["gus@example.com"] = await invited("leave-b", "gus@example.com");
    const laptop = await teams.createInvite("leave-a", { email: "gus@example.com" });
    const second = joined(await teams.join(laptop?.invite ?? "", { id: "gus@example.com" }));
    // One machine leaves: the other still holds a token, so gus stays in leave-a.
    await teams.revokeToken(second.token);
    expect((await teams.memberships("leave", "gus@example.com")).map((m) => m.team)).toEqual([
      "leave-a",
      "leave-b",
    ]);
    await teams.revokeToken(a["gus@example.com"] ?? "");
    expect((await teams.memberships("leave", "gus@example.com")).map((m) => m.team)).toEqual([
      "leave-b",
    ]);
    expect(await teams.personForToken(b["gus@example.com"] ?? "")).toMatchObject({
      team: "leave-b",
    });
    // An invite for him brings him back, as a member.
    const back = await teams.createInvite("leave-a", { email: "gus@example.com" });
    expect(
      joined(await teams.join(back?.invite ?? "", { id: "gus@example.com" })).person,
    ).toMatchObject({ team: "leave-a", role: "member" });
    expect((await teams.memberships("leave", "gus@example.com")).map((m) => m.team)).toEqual([
      "leave-a",
      "leave-b",
    ]);
  });

  it.skipIf(backend.skip)("gives each repo to one team per org", async () => {
    const { orgs } = store.ledger;
    await orgs.createOrg({ id: "repos", name: "Repos" });
    await teamWith("repos-a", "repos", []);
    await teamWith("repos-b", "repos", []);
    await teamWith("repos-other", undefined, []);

    const added = await orgs.addRepo("repos-a", {
      repo: "acme/api",
      remote: "github.com/acme/api",
    });
    expect(added).toMatchObject({
      repo: "acme/api",
      team: "repos-a",
      org: "repos",
      has_policy: false,
    });
    expect(await orgs.addRepo("repos-b", { repo: "acme/api", remote: "x" })).toEqual({
      taken: "repos-a",
    });
    // The same repo in another org is that org's business.
    expect(
      await orgs.addRepo("repos-other", { repo: "acme/api", remote: "github.com/acme/api" }),
    ).toMatchObject({ team: "repos-other", org: "default" });
    // Adding it again to its own team keeps it.
    expect(
      await orgs.addRepo("repos-a", { repo: "acme/api", remote: "gitlab.com/acme/api" }),
    ).toMatchObject({ remote: "gitlab.com/acme/api" });
    expect(await orgs.addRepo("missing", { repo: "acme/x", remote: "x" })).toBeUndefined();
    expect((await orgs.listRepos("repos-a")).map((r) => r.repo)).toEqual(["acme/api"]);
    expect(await orgs.repoOwner("repos", "acme/api")).toMatchObject({ team: "repos-a" });

    await orgs.setRepoPolicy("repos", "acme/api", "version = 1\n");
    expect(await orgs.getRepoPolicy("repos", "acme/api")).toBe("version = 1\n");
    expect((await orgs.listRepos("repos-a"))[0]?.has_policy).toBe(true);
    expect(await orgs.removeRepo("repos-b", "acme/api")).toBe(false);
    expect(await orgs.removeRepo("repos-a", "acme/api")).toBe(true);
    expect(await orgs.listRepos("repos-a")).toEqual([]);
  });

  describe("runs and the team of their repo", () => {
    beforeAll(async () => {
      if (backend.skip) return;
      const { orgs } = store.ledger;
      await orgs.createOrg({ id: "runs", name: "Runs" });
      await teamWith("runs-web", "runs", []);
      await teamWith("runs-data", "runs", []);
      await teamWith("runs-elsewhere", undefined, []);
      await orgs.addRepo("runs-data", {
        repo: "acme/pipeline",
        remote: "github.com/acme/pipeline",
      });
      await orgs.addRepo("runs-elsewhere", { repo: "acme/shared", remote: "x" });
      await orgs.addRepo("runs-web", { repo: "acme/shared", remote: "x" });
    });

    const teamsOf = async (ids: string[]) => {
      const rows = await store.db.query<{ id: string; team: string | null; body_team: string }>(
        `SELECT id::text AS id, team, body->>'team' AS body_team FROM events
         WHERE id::text IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY id`,
        [JSON.stringify(ids)],
      );
      return rows.map((row) => [row.team, row.body_team]);
    };

    it.skipIf(backend.skip)("assigns events to the team that owns their repo", async () => {
      const { ledger } = store;
      const inRepo = makeEvent(7001, { repo: "Acme/Pipeline", session_id: "run-1" });
      const sameRun = makeEvent(7002, { session_id: "run-1" });
      const noRepo = makeEvent(7003, { session_id: "run-2" });
      const otherOrgRepo = makeEvent(7004, { repo: "acme/unmapped" });
      await ledger.append([inRepo, sameRun, noRepo, otherOrgRepo], { team: "runs-web" });
      expect(await teamsOf([inRepo.id, sameRun.id, noRepo.id, otherOrgRepo.id])).toEqual([
        ["runs-data", "runs-data"],
        ["runs-data", "runs-data"],
        ["runs-web", "runs-web"],
        ["runs-web", "runs-web"],
      ]);
      // A later batch of the same run goes to the run's team as well.
      const later = makeEvent(7005, { session_id: "run-1" });
      await ledger.append([later], { team: "runs-web" });
      expect(await teamsOf([later.id])).toEqual([["runs-data", "runs-data"]]);
    });

    it.skipIf(backend.skip)(
      "moves a person's event to the repo's team only when that person is in it",
      async () => {
        const { ledger } = store;
        await store.ledger.orgs.createOrg({ id: "move", name: "Move" });
        await teamWith("move-web", "move", ["vic@example.com"]);
        await teamWith("move-data", "move", ["dora@example.com"]);
        await store.ledger.orgs.addRepo("move-web", { repo: "acme/web", remote: "x" });
        await teams.addPerson("move-web", "dora@example.com", "member", "vic@example.com");
        // Someone outside move-web naming its repo stays in their own team; dora, added to
        // move-web, writes into it.
        const forged = makeEvent(7151, { repo: "acme/web", session_id: "move-run" });
        await ledger.append([forged], { team: "move-data", person: "nobody@example.com" });
        const outsider = makeEvent(7152, { repo: "acme/web" });
        await ledger.append([outsider], { team: "move-data", person: "Nobody@Example.com" });
        expect(await teamsOf([forged.id, outsider.id])).toEqual([
          ["move-data", "move-data"],
          ["move-data", "move-data"],
        ]);
        const member = makeEvent(7153, { repo: "acme/web" });
        await ledger.append([member], { team: "move-data", person: "Dora@example.com" });
        expect(await teamsOf([member.id])).toEqual([["move-web", "move-web"]]);
        // Revoked from move-web, her move-data token no longer writes into it.
        await teams.revokePerson("move-web", "dora@example.com");
        const revoked = makeEvent(7154, { repo: "acme/web" });
        await ledger.append([revoked], { team: "move-data", person: "dora@example.com" });
        expect(await teamsOf([revoked.id])).toEqual([["move-data", "move-data"]]);
      },
    );

    it.skipIf(backend.skip)(
      "uses only the writer's org, and an unambiguous repo for the admin token",
      async () => {
        const { ledger } = store;
        const shared = makeEvent(7101, { repo: "acme/shared", team: "body-team" });
        await ledger.append([shared], { team: "runs-data" });
        // acme/shared belongs to runs-web in this org; the other org's mapping does not count.
        expect(await teamsOf([shared.id])).toEqual([["runs-web", "runs-web"]]);

        const admin = makeEvent(7102, { repo: "acme/pipeline", team: "body-team" });
        const ambiguous = makeEvent(7103, { repo: "acme/shared", team: "body-team" });
        const none = makeEvent(7104, { team: "body-team" });
        await ledger.append([admin, ambiguous, none]);
        // Without a writer the body is kept; the column says where the run belongs.
        expect(await teamsOf([admin.id, ambiguous.id, none.id])).toEqual([
          ["runs-data", "body-team"],
          [null, "body-team"],
          [null, "body-team"],
        ]);
      },
    );

    it.skipIf(backend.skip)(
      "moves a run's spend to its repo's team once the repo is known",
      async () => {
        const { ledger, db } = store;
        const from = "2026-11-01T00:00:00.000Z";
        const to = "2026-12-01T00:00:00.000Z";
        // A Claude Code run: its cost events carry no repo, and arrive first.
        await ledger.append(
          [cost(7201, { session_id: "late-run" }), cost(7202, { session_id: "late-run" })],
          { team: "runs-web" },
        );
        await ledger.append([cost(7203, { session_id: "web-run" })], { team: "runs-web" });
        const before = await ledger.orgs.teamCosts("runs", ["runs-web", "runs-data"], from, to);
        expect(before.map((c) => c.team)).toEqual(["runs-web", "runs-web", "runs-web"]);

        // selfhost scan finds the run's commit in acme/pipeline.
        await ledger.append([
          makeEvent(7204, {
            kind: "commit.created",
            source: "cli",
            repo: "acme/pipeline",
            session_id: "late-run",
            links: { commit_sha: "abc1234" },
          }),
        ]);
        const after = await ledger.orgs.teamCosts("runs", ["runs-web", "runs-data"], from, to);
        expect(after.map((c) => [c.event.id.slice(-4), c.team])).toEqual([
          ["1c21", "runs-data"],
          ["1c22", "runs-data"],
          ["1c23", "runs-web"],
        ]);
        expect(
          await ledger.orgs.teamCosts("runs", ["runs-data"], to, "2027-01-01T00:00:00Z"),
        ).toEqual([]);
        const [run] = await db.query<{ repo: string }>(
          "SELECT repo FROM run_repos WHERE session_id = 'late-run'",
        );
        expect(run?.repo).toBe("acme/pipeline");
      },
    );
  });

  it.skipIf(backend.skip)("composes the org floor, the team and the repo policy", async () => {
    const { orgs } = store.ledger;
    await orgs.createOrg({ id: "layered", name: "Layered" });
    await teamWith("layered-team", "layered", ["ada@example.com"]);
    await orgs.addRepo("layered-team", { repo: "acme/app", remote: "github.com/acme/app" });
    expect(await orgs.effectivePolicy("layered-team")).toBeUndefined();
    expect(await orgs.effectivePolicy("missing")).toBeUndefined();

    await teams.setPolicy("layered-team", "version = 1\n# team\n");
    const teamOnly = await orgs.effectivePolicy("layered-team");
    expect(teamOnly?.text).toBe("version = 1\n# team\n");
    expect(teamOnly?.layers.map((l) => l.kind)).toEqual(["team"]);

    await orgs.setOrgPolicy(
      "layered",
      'version = 1\n[[redaction]]\nname = "ticket"\npattern = "TICKET-[0-9]+"\n',
    );
    await orgs.setRepoPolicy("layered", "acme/app", 'version = 1\n[review]\nfallback = ["x"]\n');
    const full = await orgs.effectivePolicy("layered-team", "acme/app");
    expect(full?.layers.map((l) => l.kind)).toEqual(["org", "team", "repo"]);
    expect(full?.config.redaction.map((r) => r.name)).toEqual(["ticket"]);
    expect(full?.config.review.fallback).toEqual(["x"]);
    expect(full?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await orgs.storedLayers("layered")).map((l) => [l.team, l.repo])).toEqual([
      ["layered-team", undefined],
      ["layered-team", "acme/app"],
    ]);

    // The org's redaction patterns apply to the team's events.
    await store.ledger.append(
      [
        makeEvent(7301, {
          data: { note: "see TICKET-42" },
          actor: { kind: "person", id: "ada@example.com" },
        }),
      ],
      { team: "layered-team" },
    );
    const [stored] = (await store.ledger.query({ team: "layered-team" })).events;
    expect(stored?.data?.note).toBe("see [redacted:ticket]");
  });

  it.skipIf(backend.skip)("counts people and open review items per team", async () => {
    const { orgs } = store.ledger;
    await teamWith("counted", undefined, ["a@example.com", "b@example.com"]);
    expect(await orgs.peopleCounts(["counted", "missing"])).toEqual(new Map([["counted", 2]]));
    expect(await orgs.reviewCounts(["counted"])).toEqual(new Map());
  });

  it.skipIf(backend.skip)("moves existing teams into the default org on upgrade", async () => {
    const upgrade = await backend.open(MIGRATIONS.filter((m) => m.version < "0007"));
    try {
      await upgrade.db.exec("INSERT INTO teams (id, name) VALUES ('legacy', 'Legacy')");
      expect(await migrate(upgrade.db)).toEqual(
        MIGRATIONS.filter((m) => m.version >= "0007").map((m) => m.version),
      );
      expect(await upgrade.ledger.teams.getTeam("legacy")).toMatchObject({ org: "default" });
    } finally {
      await upgrade.close();
    }
  });

  it.skipIf(backend.skip)(
    "ends the memberships of people with no live token left on upgrade, and keeps added people",
    async () => {
      const upgrade = await backend.open(MIGRATIONS.filter((m) => m.version < "0015"));
      try {
        await upgrade.db.exec(`
          INSERT INTO teams (id, name) VALUES ('up-a', 'A'), ('up-b', 'B');
          INSERT INTO people (team_id, id, role) VALUES ('up-a', 'owner@example.com', 'owner'),
            ('up-a', 'gone@example.com', 'member'), ('up-b', 'gone@example.com', 'owner'),
            ('up-a', 'added@example.com', 'member');
          INSERT INTO tokens (hash, kind, team_id, person_id, revoked_at) VALUES
            ('h1', 'person', 'up-a', 'owner@example.com', NULL),
            ('h2', 'person', 'up-a', 'gone@example.com', now()),
            ('h3', 'person', 'up-b', 'gone@example.com', NULL);
        `);
        expect(await migrate(upgrade.db)).toEqual(["0015_membership_revocation"]);
        const { teams: upgraded } = upgrade.ledger;
        expect((await upgraded.listPeople("up-a")).map((p) => p.id)).toEqual([
          "owner@example.com",
          "added@example.com",
        ]);
        expect(await upgraded.memberships("default", "gone@example.com")).toEqual([
          { team: "up-b", role: "owner" },
        ]);
      } finally {
        await upgrade.close();
      }
    },
  );
});
