import { INVITE_TTL_DEFAULT_SECONDS } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db.js";
import { MIGRATIONS } from "../src/migrations.generated.js";
import { hashToken, type JoinResult, type TeamStore } from "../src/teams.js";
import { BACKENDS, makeEvent, type Store } from "./helpers.js";

/** The join result, failing the test when the invite was refused. */
function joined(result: Awaited<ReturnType<TeamStore["join"]>>): JoinResult {
  if ("refused" in result) throw new Error(`join refused: ${result.refused}`);
  return result;
}

const seconds = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;

describe.each(BACKENDS)("team store on $name", (backend) => {
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

  /** Moves an invite's expiry into the past, as if its lifetime had run out. */
  const expire = (invite: string) =>
    store.db.query("UPDATE tokens SET expires_at = now() - interval '1 second' WHERE hash = $1", [
      hashToken(invite),
    ]);

  it.skipIf(backend.skip)("creates a team once and keeps only token hashes", async () => {
    const created = await teams.createTeam({ id: "platform", name: "Platform" });
    expect(created?.team).toMatchObject({ id: "platform", name: "Platform" });
    expect(created?.invite).toMatch(/^selfhost_inv_[A-Za-z0-9_-]{43}$/);
    expect(await teams.createTeam({ id: "platform", name: "Other" })).toBeUndefined();
    expect(await teams.getTeam("platform")).toEqual(created?.team);

    const { token } = joined(await teams.join(created?.invite ?? "", { id: "alice@example.com" }));
    const rows = await store.db.query<{ hash: string; kind: string }>(
      "SELECT hash, kind FROM tokens WHERE team_id = 'platform' ORDER BY kind",
    );
    expect(rows).toEqual([
      { hash: hashToken(created?.invite ?? ""), kind: "invite" },
      { hash: hashToken(token), kind: "person" },
    ]);
    const stored = JSON.stringify(await store.db.query("SELECT * FROM tokens"));
    expect(stored).not.toContain(created?.invite);
    expect(stored).not.toContain(token);
  });

  it.skipIf(backend.skip)("makes the first person the owner and the rest members", async () => {
    const created = await teams.createTeam({ id: "roles", name: "Roles" });
    const invite = created?.invite ?? "";
    const first = joined(await teams.join(invite, { id: "owner@example.com", name: "Owner" }));
    const second = joined(await teams.join(invite, { id: "member@example.com" }));
    expect(first.person).toMatchObject({
      id: "owner@example.com",
      name: "Owner",
      team: "roles",
      role: "owner",
    });
    expect(second.person).toMatchObject({ id: "member@example.com", role: "member" });
    expect(second.person).not.toHaveProperty("name");
    expect(first.token).toMatch(/^selfhost_pt_[A-Za-z0-9_-]{43}$/);

    // A new machine for the same person needs an invite for that person.
    const forOwner = await teams.createInvite("roles", { email: "owner@example.com" });
    const again = joined(await teams.join(forOwner?.invite ?? "", { id: "owner@example.com" }));
    expect(again.person).toEqual(first.person);
    expect(again.token).not.toBe(first.token);
    expect(await teams.personForToken(first.token)).toEqual(first.person);
    expect(await teams.personForToken(again.token)).toEqual(first.person);
  });

  it.skipIf(backend.skip)("adds only new people with a team-wide invite", async () => {
    const created = await teams.createTeam({ id: "claims", name: "Claims" });
    const invite = created?.invite ?? "";
    const owner = joined(await teams.join(invite, { id: "owner@example.com" }));
    const member = joined(await teams.join(invite, { id: "member@example.com" }));
    expect(member.person.role).toBe("member");

    // Not the owner, and not anyone else who joined, whatever the case of the id.
    expect(await teams.join(invite, { id: "owner@example.com" })).toEqual({
      refused: "existing_person",
    });
    expect(await teams.join(invite, { id: "Member@Example.com" })).toEqual({
      refused: "existing_person",
    });
    // Revoked people are still in the team.
    await teams.revokePerson("claims", "member@example.com");
    expect(await teams.join(invite, { id: "member@example.com" })).toEqual({
      refused: "existing_person",
    });
    const tokens = await store.db.query(
      "SELECT 1 FROM tokens WHERE team_id = 'claims' AND kind = 'person' AND revoked_at IS NULL",
    );
    expect(tokens).toHaveLength(1);
    expect(await teams.personForToken(owner.token)).toEqual(owner.person);

    // An invite for the person brings them back with their role.
    const back = await teams.createInvite("claims", { email: "member@example.com" });
    const rejoined = joined(await teams.join(back?.invite ?? "", { id: "member@example.com" }));
    expect(rejoined.person).toEqual(member.person);
    joined(await teams.join(invite, { id: "new@example.com" }));
  });

  it.skipIf(backend.skip)("refuses unknown and revoked invites and tokens", async () => {
    const created = await teams.createTeam({ id: "revoked", name: "Revoked" });
    const invite = created?.invite ?? "";
    expect(await teams.join("selfhost_inv_nope", { id: "x@example.com" })).toEqual({
      refused: "unknown",
    });
    expect(await teams.personForToken("selfhost_pt_nope")).toBeUndefined();
    // An invite is not a person token.
    expect(await teams.personForToken(invite)).toBeUndefined();

    const { token } = joined(await teams.join(invite, { id: "x@example.com" }));
    await store.db.query("UPDATE tokens SET revoked_at = now() WHERE team_id = 'revoked'");
    expect(await teams.personForToken(token)).toBeUndefined();
    expect(await teams.join(invite, { id: "y@example.com" })).toEqual({ refused: "revoked" });
  });

  it.skipIf(backend.skip)("expires invites after 7 days unless told otherwise", async () => {
    const created = await teams.createTeam({ id: "expiry", name: "Expiry" });
    const [row] = await store.db.query<{ created_at: string }>(
      "SELECT created_at FROM tokens WHERE hash = $1",
      [hashToken(created?.invite ?? "")],
    );
    const createdAt = new Date(row?.created_at ?? "").toISOString();
    expect(seconds(createdAt, created?.invite_expires_at ?? "")).toBe(INVITE_TTL_DEFAULT_SECONDS);

    const short = await teams.createTeam({ id: "short", name: "Short" }, { ttlSeconds: 3600 });
    const hour = seconds(new Date().toISOString(), short?.invite_expires_at ?? "");
    expect(hour).toBeGreaterThan(3500);
    expect(hour).toBeLessThanOrEqual(3600);

    const another = await teams.createInvite("expiry", { ttlSeconds: 120 });
    expect(another).toMatchObject({ team: "expiry", id: hashToken(another?.invite ?? "") });
    expect(another).not.toHaveProperty("email");
    expect(await teams.createInvite("missing")).toBeUndefined();

    await expire(another?.invite ?? "");
    expect(await teams.join(another?.invite ?? "", { id: "late@example.com" })).toEqual({
      refused: "expired",
    });
    // Other invites of the team keep working.
    joined(await teams.join(created?.invite ?? "", { id: "on-time@example.com" }));
  });

  it.skipIf(backend.skip)("revokes an invite by its id, once", async () => {
    await teams.createTeam({ id: "invites", name: "Invites" });
    const invite = await teams.createInvite("invites");
    const revoked = await teams.revokeInvite(invite?.id ?? "");
    expect(revoked).toMatchObject({ id: invite?.id, team: "invites" });
    expect(Date.parse(revoked?.revoked_at ?? "")).not.toBeNaN();
    expect(await teams.join(invite?.invite ?? "", { id: "a@example.com" })).toEqual({
      refused: "revoked",
    });
    // Revoking again keeps the first time.
    expect((await teams.revokeInvite(invite?.id ?? ""))?.revoked_at).toBe(revoked?.revoked_at);
    expect(await teams.revokeInvite("0".repeat(64))).toBeUndefined();
  });

  it.skipIf(backend.skip)("binds the person id to an invite's email", async () => {
    await teams.createTeam({ id: "bound", name: "Bound" });
    const invite = await teams.createInvite("bound", { email: "Carol@Example.com" });
    expect(invite?.email).toBe("Carol@Example.com");
    const code = invite?.invite ?? "";

    expect(await teams.join(code, { id: "mallory@example.com" })).toEqual({
      refused: "wrong_person",
    });
    expect(
      await store.db.query("SELECT id FROM people WHERE team_id = 'bound' AND id LIKE 'mallory%'"),
    ).toEqual([]);

    const carol = joined(await teams.join(code, { id: " carol@example.COM" }));
    expect(carol.person).toMatchObject({ id: "Carol@Example.com", team: "bound" });
    expect(await teams.personForToken(carol.token)).toEqual(carol.person);
  });

  it.skipIf(backend.skip)("revokes all of a person's tokens, or one token", async () => {
    const created = await teams.createTeam({ id: "leavers", name: "Leavers" });
    const invite = created?.invite ?? "";
    const laptop = joined(await teams.join(invite, { id: "dan@example.com" }));
    const rejoin = await teams.createInvite("leavers", { email: "dan@example.com" });
    const desktop = joined(await teams.join(rejoin?.invite ?? "", { id: "dan@example.com" }));
    const erin = joined(await teams.join(invite, { id: "erin@example.com" }));

    expect(await teams.revokeToken(laptop.token)).toEqual({
      team: "leavers",
      person: "dan@example.com",
      revoked: 1,
    });
    expect(await teams.revokeToken(laptop.token)).toBeUndefined();
    expect(await teams.personForToken(laptop.token)).toBeUndefined();
    expect(await teams.personForToken(desktop.token)).toMatchObject({ id: "dan@example.com" });

    // The desktop token and the open invite for dan's email.
    expect(await teams.revokePerson("leavers", "dan@example.com")).toEqual({
      team: "leavers",
      person: "dan@example.com",
      revoked: 2,
    });
    expect(await teams.personForToken(desktop.token)).toBeUndefined();
    expect(await teams.join(rejoin?.invite ?? "", { id: "dan@example.com" })).toEqual({
      refused: "revoked",
    });
    expect(await teams.personForToken(erin.token)).toMatchObject({ id: "erin@example.com" });
    expect(await teams.revokePerson("leavers", "dan@example.com")).toMatchObject({ revoked: 0 });
    expect(await teams.revokePerson("leavers", "nobody@example.com")).toBeUndefined();
    expect(await teams.revokePerson("roles", "erin@example.com")).toBeUndefined();
  });

  it.skipIf(backend.skip)("stores and replaces a team policy", async () => {
    await teams.createTeam({ id: "policy", name: "Policy" });
    expect(await teams.getPolicy("policy")).toBeUndefined();
    const first = await teams.setPolicy("policy", "version = 1\n");
    expect(first).toMatchObject({ team: "policy", text: "version = 1\n" });
    expect(Date.parse(first.updatedAt)).not.toBeNaN();
    await teams.setPolicy("policy", "version = 1\n# two\n");
    expect((await teams.getPolicy("policy"))?.text).toBe("version = 1\n# two\n");
    await expect(teams.setPolicy("missing", "version = 1\n")).rejects.toThrow(/no team/);
  });

  it.skipIf(backend.skip)(
    "stores the writer's team with each event and filters on it",
    async () => {
      const { ledger } = store;
      const red = makeEvent(9001, { team: "blue" });
      const blue = makeEvent(9002);
      const local = makeEvent(9003, { team: "red" });
      await ledger.append([red], { team: "red" });
      await ledger.append([blue], { team: "blue" });
      await ledger.append([local]);
      // A duplicate keeps the team it was first written with.
      expect(await ledger.append([red], { team: "blue" })).toEqual({
        accepted: [],
        duplicates: [red.id],
      });

      expect((await ledger.query({ team: "red" })).events).toEqual([red]);
      expect((await ledger.query({ team: "blue" })).events).toEqual([blue]);
      const rows = await store.db.query<{ id: string; team: string | null }>(
        "SELECT id::text AS id, team FROM events WHERE id IN ($1::uuid, $2::uuid, $3::uuid) ORDER BY id",
        [red.id, blue.id, local.id],
      );
      expect(rows.map((row) => row.team)).toEqual(["red", "blue", null]);
    },
  );

  it.skipIf(backend.skip)("indexes the team column in page order", async () => {
    const indexes = await store.db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = 'events_team_ts_idx'`,
    );
    expect(indexes.map((index) => index.indexdef)).toEqual([
      expect.stringMatching(/ON \S*events USING btree \(team, ts DESC, id DESC\)$/),
    ]);
  });
});

describe.each(BACKENDS)("upgrading team tables on $name", (backend) => {
  it.skipIf(backend.skip)(
    "gives existing invites the default expiry and keeps events",
    async () => {
      // Created long ago, so the backfilled expiry is in the past.
      const before = MIGRATIONS.filter((m) => m.version < "0003");
      const store = await backend.open(before);
      try {
        await store.db.exec(`
        INSERT INTO teams (id, name) VALUES ('old', 'Old');
        INSERT INTO tokens (hash, kind, team_id, created_at)
          VALUES ('${hashToken("old-invite")}', 'invite', 'old', '2020-01-01T00:00:00Z');
      `);
        const event = makeEvent(1, { team: "old" });
        await store.db.query(
          `INSERT INTO events (id, ts, source, kind, actor_kind, actor_id, body)
         VALUES ($1, $2, 'hook', 'session.started', 'person', 'alice@example.com', $3::text::jsonb)`,
          [event.id, event.ts, JSON.stringify(event)],
        );

        expect(await migrate(store.db)).toEqual(
          MIGRATIONS.filter((m) => m.version >= "0003").map((m) => m.version),
        );
        const [invite] = await store.db.query<{ expires_at: string }>(
          "SELECT expires_at FROM tokens WHERE team_id = 'old'",
        );
        expect(new Date(invite?.expires_at ?? "").toISOString()).toBe("2020-01-08T00:00:00.000Z");
        expect(await store.ledger.teams.join("old-invite", { id: "a@example.com" })).toEqual({
          refused: "expired",
        });
        const events = await store.ledger.query({});
        expect(events.events).toEqual([event]);
        // Only events written with a person token from now on carry a team.
        expect((await store.ledger.query({ team: "old" })).events).toEqual([]);
      } finally {
        await store.close();
      }
    },
  );
});
