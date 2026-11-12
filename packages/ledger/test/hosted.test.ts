import { describe, expect, it } from "vitest";
import { createSecretBox } from "../src/hosted.js";
import { asSystem, currentOrg, withOrg } from "../src/scope.js";
import { BACKENDS } from "./helpers.js";

describe("org scope", () => {
  it("follows the request through awaits, and the server's own work leaves it", async () => {
    expect(currentOrg()).toBeUndefined();
    await withOrg("acme", async () => {
      await Promise.resolve();
      expect(currentOrg()).toBe("acme");
      await asSystem(async () => {
        await Promise.resolve();
        expect(currentOrg()).toBeUndefined();
      });
      expect(currentOrg()).toBe("acme");
    });
    expect(() => withOrg("", () => 1)).toThrow(/org id/);
  });
});

describe.each(BACKENDS)("hosted tenancy on $name", ({ skip, open }) => {
  it.skipIf(skip)(
    "stops joins at the org's seats, counting people once and not the revoked",
    async () => {
      const { ledger, close } = await open();
      try {
        const { teams, orgs, hosted } = ledger;
        await orgs.createOrg({ id: "small", name: "small" });
        const web = await teams.createTeam({ id: "web", name: "web", org: "small" });
        const data = await teams.createTeam({ id: "data", name: "data", org: "small" });
        if (!web || !data) throw new Error("no teams");
        const seats = { seats: 2 };
        expect(await teams.join(web.invite, { id: "a@x.dev" }, seats)).toHaveProperty("token");
        expect(await teams.join(web.invite, { id: "b@x.dev" }, seats)).toHaveProperty("token");
        // A third person, in either team, is past the limit.
        expect(await teams.join(data.invite, { id: "c@x.dev" }, seats)).toEqual({
          refused: "seat_limit",
        });
        // Someone already in the org takes no new seat in another team.
        const email = await teams.createInvite("data", { email: "a@x.dev" });
        expect(await teams.join(email?.invite ?? "", { id: "a@x.dev" }, seats)).toHaveProperty(
          "token",
        );
        expect(await hosted.seats("small")).toEqual({ used: 2, limit: null });
        // The org's own limit wins over the server's.
        expect(await hosted.setSeats("small", 3)).toBe(true);
        expect(await teams.join(data.invite, { id: "c@x.dev" }, seats)).toHaveProperty("token");
        expect(await teams.join(data.invite, { id: "d@x.dev" }, seats)).toEqual({
          refused: "seat_limit",
        });
        // A revoked person's seat is free again; without seats there is no limit.
        await teams.revokePerson("data", "c@x.dev");
        expect(await teams.join(data.invite, { id: "d@x.dev" }, seats)).toHaveProperty("token");
        expect(await teams.join(data.invite, { id: "e@x.dev" })).toHaveProperty("token");
      } finally {
        await close();
      }
    },
  );

  it.skipIf(skip)(
    "finds people by email and gives them new tokens only where they are active",
    async () => {
      const { ledger, close } = await open();
      try {
        const { teams, hosted } = ledger;
        const team = await teams.createTeam({ id: "web", name: "web" });
        await teams.join(team?.invite ?? "", { id: "Ana@x.dev" });
        const [found] = await hosted.memberships("ana@X.dev");
        expect(found).toMatchObject({ org: "default", person: { id: "Ana@x.dev", role: "owner" } });
        const token = await hosted.issueToken("web", "Ana@x.dev");
        expect(token).toMatch(/^selfhost_pt_/);
        expect((await teams.personForToken(token ?? ""))?.id).toBe("Ana@x.dev");
        expect(await hosted.issueToken("web", "nobody@x.dev")).toBeUndefined();
      } finally {
        await close();
      }
    },
  );

  it.skipIf(skip)("seals secrets with a key of their org, wrapped with the server's", async () => {
    const { db, ledger, close } = await open();
    try {
      await ledger.orgs.createOrg({ id: "other", name: "other" });
      const box = createSecretBox(db, Buffer.alloc(32, 1));
      const sealed = await box.seal("default", "tgram://bot:token/1");
      expect(sealed).toMatch(/^sealed:v1:/);
      expect(sealed).not.toContain("token");
      expect(await box.open("default", sealed)).toBe("tgram://bot:token/1");
      // A value written before sealing was on reads as it is.
      expect(await box.open("default", "tgram://plain")).toBe("tgram://plain");
      // Each org has its own key: another org's key cannot open it.
      await box.seal("other", "x");
      await expect(box.open("other", sealed)).rejects.toThrow();
      const keys = await db.query<{ org_id: string; wrapped_key: string }>(
        "SELECT org_id, wrapped_key FROM org_keys ORDER BY org_id",
      );
      expect(keys.map((k) => k.org_id)).toEqual(["default", "other"]);
      // Another server with the same key reads what this one sealed.
      expect(await createSecretBox(db, Buffer.alloc(32, 1)).open("default", sealed)).toBe(
        "tgram://bot:token/1",
      );
      await expect(
        createSecretBox(db, Buffer.alloc(32, 2)).open("default", sealed),
      ).rejects.toThrow();
      expect(() => createSecretBox(db, Buffer.alloc(16))).toThrow(/32 bytes/);
    } finally {
      await close();
    }
  });
});
