import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken, type TeamStore } from "../src/teams.js";
import { BACKENDS, type Store } from "./helpers.js";

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

  it.skipIf(backend.skip)("creates a team once and keeps only token hashes", async () => {
    const created = await teams.createTeam({ id: "platform", name: "Platform" });
    expect(created?.team).toMatchObject({ id: "platform", name: "Platform" });
    expect(created?.invite).toMatch(/^selfhost_inv_[A-Za-z0-9_-]{43}$/);
    expect(await teams.createTeam({ id: "platform", name: "Other" })).toBeUndefined();
    expect(await teams.getTeam("platform")).toEqual(created?.team);

    const joined = await teams.join(created?.invite ?? "", { id: "alice@example.com" });
    const rows = await store.db.query<{ hash: string; kind: string }>(
      "SELECT hash, kind FROM tokens WHERE team_id = 'platform' ORDER BY kind",
    );
    expect(rows).toEqual([
      { hash: hashToken(created?.invite ?? ""), kind: "invite" },
      { hash: hashToken(joined?.token ?? ""), kind: "person" },
    ]);
    const stored = JSON.stringify(await store.db.query("SELECT * FROM tokens"));
    expect(stored).not.toContain(created?.invite);
    expect(stored).not.toContain(joined?.token);
  });

  it.skipIf(backend.skip)("makes the first person the owner and the rest members", async () => {
    const created = await teams.createTeam({ id: "roles", name: "Roles" });
    const invite = created?.invite ?? "";
    const first = await teams.join(invite, { id: "owner@example.com", name: "Owner" });
    const second = await teams.join(invite, { id: "member@example.com" });
    expect(first?.person).toMatchObject({
      id: "owner@example.com",
      name: "Owner",
      team: "roles",
      role: "owner",
    });
    expect(second?.person).toMatchObject({ id: "member@example.com", role: "member" });
    expect(second?.person).not.toHaveProperty("name");
    expect(first?.token).toMatch(/^selfhost_pt_[A-Za-z0-9_-]{43}$/);

    const again = await teams.join(invite, { id: "owner@example.com" });
    expect(again?.person).toEqual(first?.person);
    expect(again?.token).not.toBe(first?.token);
    expect(await teams.personForToken(first?.token ?? "")).toEqual(first?.person);
    expect(await teams.personForToken(again?.token ?? "")).toEqual(first?.person);
  });

  it.skipIf(backend.skip)("refuses unknown and revoked invites and tokens", async () => {
    const created = await teams.createTeam({ id: "revoked", name: "Revoked" });
    const invite = created?.invite ?? "";
    expect(await teams.join("selfhost_inv_nope", { id: "x@example.com" })).toBeUndefined();
    expect(await teams.personForToken("selfhost_pt_nope")).toBeUndefined();
    // An invite is not a person token.
    expect(await teams.personForToken(invite)).toBeUndefined();

    const joined = await teams.join(invite, { id: "x@example.com" });
    await store.db.query("UPDATE tokens SET revoked_at = now() WHERE team_id = 'revoked'");
    expect(await teams.personForToken(joined?.token ?? "")).toBeUndefined();
    expect(await teams.join(invite, { id: "y@example.com" })).toBeUndefined();
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
});
