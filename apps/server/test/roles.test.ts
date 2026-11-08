import {
  type CreateTeamResponse,
  createValidator,
  type JoinResponse,
  type MeResponse,
  MeResponseSchema,
  type PersonRole,
  ROLE_PERMISSIONS,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { BACKENDS, caller, TOKEN } from "./helpers.js";

type Role = PersonRole | "admin token";
const ROLES: Role[] = ["owner", "admin", "member", "admin token"];

/** What each protected endpoint answers for each role, from the permission table. */
const ALLOWED = (status: number, ...roles: Role[]) =>
  Object.fromEntries(ROLES.map((role) => [role, roles.includes(role) ? status : 403])) as Record<
    Role,
    number
  >;

describe.each(BACKENDS)("roles on $name", (backend) => {
  let store: Awaited<ReturnType<(typeof BACKENDS)[number]["open"]>>;
  let app: Hono;
  let admin: ReturnType<typeof caller>;
  let web: CreateTeamResponse;
  let data: CreateTeamResponse;
  const tokens = {} as Record<Role, string>;
  let next = 0;
  const fresh = (prefix: string) => `${prefix}-${++next}@example.com`;

  const join = async (invite: string, person: string) => {
    const res = await app.request("/v1/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite, person }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as JoinResponse;
  };

  const setRole = async (team: string, person: string, role: PersonRole) => {
    const path = `/v1/teams/${team}/people/${encodeURIComponent(person)}/role`;
    expect((await admin(path, "PUT", { role })).status).toBe(200);
  };

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    app = createApp({ version: "test", ledger: store.ledger, token: TOKEN });
    admin = caller(app, TOKEN);
    expect((await admin("/v1/orgs", "POST", { name: "Acme" })).status).toBe(201);
    web = (await (
      await admin("/v1/teams", "POST", { name: "Web", org: "acme" })
    ).json()) as CreateTeamResponse;
    data = (await (
      await admin("/v1/teams", "POST", { name: "Data", org: "acme" })
    ).json()) as CreateTeamResponse;
    tokens.owner = (await join(web.invite, "ada@example.com")).token;
    tokens.admin = (await join(web.invite, "adam@example.com")).token;
    tokens.member = (await join(web.invite, "mia@example.com")).token;
    tokens["admin token"] = TOKEN;
    await setRole("web", "adam@example.com", "admin");
    await join(data.invite, "dan@example.com");
  });

  afterAll(async () => {
    await store?.close();
  });

  /** Someone in team data only, whom web can add. */
  const inData = async () => (await join(data.invite, fresh("data"))).person.id;
  /** A new person in web, with a role. */
  const inWeb = async (role: PersonRole = "member") => {
    const id = (await join(web.invite, fresh("web"))).person.id;
    if (role !== "member") await setRole("web", id, role);
    return id;
  };

  const calls: [
    string,
    Record<Role, number>,
    (as: ReturnType<typeof caller>) => Promise<Response>,
  ][] = [
    [
      "PUT /v1/policy (the team's rules)",
      ALLOWED(200, "owner", "admin", "admin token"),
      (as) => as("/v1/policy?team=web", "PUT", { text: "version = 1\n" }),
    ],
    [
      "PUT /v1/policy?repo= (a repo's rules)",
      ALLOWED(200, "owner", "admin", "admin token"),
      async (as) => {
        const remote = `acme/policy-${++next}`;
        await admin("/v1/teams/web/repos", "POST", { remote });
        return as(`/v1/policy?team=web&repo=${remote}`, "PUT", { text: "version = 1\n" });
      },
    ],
    [
      "PATCH /v1/teams/{team} (team settings)",
      ALLOWED(200, "owner", "admin", "admin token"),
      (as) => as("/v1/teams/web", "PATCH", { name: "Web" }),
    ],
    [
      "POST /v1/teams/{team}/repos",
      ALLOWED(201, "owner", "admin", "admin token"),
      (as) => as("/v1/teams/web/repos", "POST", { remote: `acme/new-${++next}` }),
    ],
    [
      "DELETE /v1/teams/{team}/repos/{owner}/{name}",
      ALLOWED(200, "owner", "admin", "admin token"),
      async (as) => {
        const remote = `acme/old-${++next}`;
        await admin("/v1/teams/web/repos", "POST", { remote });
        return as(`/v1/teams/web/repos/${remote}`, "DELETE");
      },
    ],
    [
      "POST /v1/teams/{team}/invites",
      ALLOWED(201, "owner", "admin", "admin token"),
      (as) => as("/v1/teams/web/invites", "POST", {}),
    ],
    [
      "DELETE /v1/invites/{id}",
      ALLOWED(200, "owner", "admin", "admin token"),
      async (as) => {
        const invite = await (await admin("/v1/teams/web/invites", "POST", {})).json();
        return as(`/v1/invites/${(invite as { id: string }).id}`, "DELETE");
      },
    ],
    [
      "POST /v1/teams/{team}/people as a member",
      ALLOWED(201, "owner", "admin", "admin token"),
      async (as) => as("/v1/teams/web/people", "POST", { person: await inData() }),
    ],
    [
      "POST /v1/teams/{team}/people as an admin",
      ALLOWED(201, "owner", "admin token"),
      async (as) => as("/v1/teams/web/people", "POST", { person: await inData(), role: "admin" }),
    ],
    [
      "DELETE a member's tokens",
      ALLOWED(200, "owner", "admin", "admin token"),
      async (as) => as(`/v1/teams/web/people/${await inWeb()}/tokens`, "DELETE"),
    ],
    [
      "DELETE an owner's tokens",
      ALLOWED(200, "owner", "admin token"),
      async (as) => as(`/v1/teams/web/people/${await inWeb("owner")}/tokens`, "DELETE"),
    ],
    [
      "PUT /v1/teams/{team}/people/{person}/role",
      ALLOWED(200, "owner", "admin token"),
      async (as) => as(`/v1/teams/web/people/${await inWeb()}/role`, "PUT", { role: "admin" }),
    ],
    [
      "GET /v1/orgs/{org}/overview (the cross-team view)",
      ALLOWED(200, "owner", "admin", "admin token"),
      (as) => as("/v1/orgs/acme/overview"),
    ],
  ];

  describe.each(calls)("%s", (_name, expected, run) => {
    it.skipIf(backend.skip).each(ROLES)("answers %s as the table says", async (role) => {
      const res = await run(caller(app, tokens[role]));
      expect(res.status, await res.clone().text()).toBe(expected[role]);
      if (res.status === 403) {
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("forbidden");
        expect(body.error.message).toMatch(
          /needs the (owner or admin|owner) role in (team web; you are an? (admin|member) there|at least one team of the org)\./,
        );
      }
    });
  });

  it.skipIf(backend.skip)("lets every role read its team", async () => {
    for (const role of ROLES) {
      const as = caller(app, tokens[role]);
      for (const path of [
        "/v1/policy?team=web",
        "/v1/teams/web/people",
        "/v1/teams/web/repos",
        "/v1/teams/web/overview",
        "/v1/budget?team=web",
        "/v1/events?team=web",
        "/v1/review-items?team=web",
      ]) {
        expect((await as(path)).status, `${role} ${path}`).toBe(200);
      }
    }
  });

  it.skipIf(backend.skip)("refuses people outside the team, saying so", async () => {
    const invite = (await (await admin("/v1/teams/data/invites", "POST", {})).json()) as {
      invite: string;
    };
    const dan = (await join(invite.invite, fresh("outsider"))).token;
    for (const [path, method, body] of [
      ["/v1/policy?team=web", "GET"],
      ["/v1/teams/web/people", "GET"],
      ["/v1/policy?team=web", "PUT", { text: "version = 1\n" }],
      ["/v1/teams/web/invites", "POST", {}],
    ] as const) {
      const res = await caller(app, dan)(path, method, body);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({
        error: { code: "forbidden", message: "You are not in team web." },
      });
    }
  });

  it.skipIf(backend.skip)("lists each role's allowed actions on /v1/me", async () => {
    for (const role of ["owner", "admin", "member"] as const) {
      const body = (await (await caller(app, tokens[role])("/v1/me")).json()) as MeResponse;
      const result = createValidator(MeResponseSchema).validate(body);
      expect(result.ok ? [] : result.errors).toEqual([]);
      expect(body.role).toBe(role);
      expect([...(body.allowed ?? [])].sort()).toEqual([...ROLE_PERMISSIONS[role]].sort());
    }
    const me = (await (await caller(app, tokens.owner)("/v1/me")).json()) as MeResponse;
    expect(me.memberships).toEqual([{ team: "web", role: "owner" }]);
  });

  it.skipIf(backend.skip)("keeps at least one owner", async () => {
    const team = (await (
      await admin("/v1/teams", "POST", { name: "Owners", org: "acme" })
    ).json()) as CreateTeamResponse;
    const first = await join(team.invite, fresh("first"));
    const second = await join(team.invite, fresh("second"));
    const as = caller(app, first.token);
    const role = (person: string, value: PersonRole) =>
      as(`/v1/teams/owners/people/${encodeURIComponent(person)}/role`, "PUT", { role: value });

    const last = await role(first.person.id, "member");
    expect(last.status).toBe(409);
    expect(await last.json()).toMatchObject({ error: { code: "last_owner" } });
    expect((await role(second.person.id, "owner")).status).toBe(200);
    const demoted = await role(first.person.id, "admin");
    expect(demoted.status).toBe(200);
    expect(await demoted.json()).toMatchObject({ id: first.person.id, role: "admin" });
    // first is an admin now, and admins do not change roles.
    expect((await role(second.person.id, "member")).status).toBe(403);
    const byAdmin = await admin(
      `/v1/teams/owners/people/${encodeURIComponent(second.person.id)}/role`,
      "PUT",
      { role: "member" },
    );
    expect(byAdmin.status).toBe(409);
    expect((await role("nobody@example.com", "member")).status).toBe(403);
    const missing = await admin("/v1/teams/owners/people/nobody%40example.com/role", "PUT", {
      role: "member",
    });
    expect(missing.status).toBe(404);
    const bad = await admin(`/v1/teams/owners/people/${second.person.id}/role`, "PUT", {
      role: "boss",
    });
    expect(bad.status).toBe(400);
  });

  it.skipIf(backend.skip)("adds only people already in the org, once", async () => {
    const as = caller(app, tokens.owner);
    const stranger = await as("/v1/teams/web/people", "POST", { person: "eve@example.com" });
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toMatchObject({ error: { code: "not_in_org" } });
    const person = await inData();
    expect((await as("/v1/teams/web/people", "POST", { person })).status).toBe(201);
    const again = await as("/v1/teams/web/people", "POST", { person });
    expect(again.status).toBe(409);
  });
});
