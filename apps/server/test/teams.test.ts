import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import {
  type ApiError,
  type CreateInviteResponse,
  CreateInviteResponseSchema,
  CreateTeamResponseSchema,
  createValidator,
  type EventsPage,
  INVITE_TTL_DEFAULT_SECONDS,
  type InvalidPolicyError,
  InvalidPolicyErrorSchema,
  type Invite,
  InviteSchema,
  type JoinResponse,
  JoinResponseSchema,
  type LedgerEvent,
  MeResponseSchema,
  type PolicyResponse,
  PolicyResponseSchema,
  RevokeTokensResponseSchema,
  TEAM_ACTIONS,
} from "@selfhost/schema";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { stampEvents, teamId } from "../src/teams.js";
import { startTestServer, type TestServer } from "./helpers.js";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.ledger.close();
});

const matches = (schema: Parameters<typeof createValidator>[0], body: unknown) => {
  const result = createValidator(schema).validate(body);
  expect(result.ok ? [] : result.errors).toEqual([]);
};

const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const as = (token: string, init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
});

/**
 * A team in an org of its own, so the people of one test's team are not people of another's:
 * a person's tokens act in every team of their org.
 */
async function createTeam(name: string, options: { invite_ttl_seconds?: number } = {}) {
  const org = await server.request("/v1/orgs", json("POST", { name: `${name} Org` }));
  expect(org.status).toBe(201);
  const { id } = (await org.json()) as { id: string };
  const res = await server.request("/v1/teams", json("POST", { name, org: id, ...options }));
  expect(res.status).toBe(201);
  const body = await res.json();
  matches(CreateTeamResponseSchema, body);
  return body as { team: { id: string }; invite: string; invite_expires_at: string };
}

async function createInvite(team: string, body: { ttl_seconds?: number; email?: string } = {}) {
  const res = await server.request(`/v1/teams/${team}/invites`, json("POST", body));
  expect(res.status).toBe(201);
  const invite = await res.json();
  matches(CreateInviteResponseSchema, invite);
  return invite as CreateInviteResponse;
}

const joinAs = (invite: string, person: string) =>
  server.app.request("/v1/join", json("POST", { invite, person }));

async function refused(res: Response) {
  expect(res.status).toBe(401);
  const body = (await res.json()) as ApiError;
  expect(body.error.code).toBe("invalid_invite");
  return body.error.message;
}

async function join(invite: string, person: string): Promise<JoinResponse> {
  const res = await server.app.request("/v1/join", json("POST", { invite, person }));
  expect(res.status).toBe(200);
  const body = await res.json();
  matches(JoinResponseSchema, body);
  return body as JoinResponse;
}

let next = 1;
function makeEvent(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  const n = next++;
  return {
    id: `01930c4e-2f1a-7b2c-9d3e-${n.toString(16).padStart(12, "0")}`,
    schema: "selfhost.event/v1",
    ts: "2026-11-07T10:00:00.000Z",
    source: "local_log",
    kind: "session.started",
    actor: { kind: "person", id: "ada@example.com" },
    ...overrides,
  };
}

describe("teamId", () => {
  it.each([
    ["Platform", "platform"],
    ["  Data Eng / ML ", "data-eng-ml"],
    ["Crème Brûlée", "creme-brulee"],
    ["!!!", undefined],
  ])("%s becomes %s", (name, id) => {
    expect(teamId(name)).toBe(id);
  });
});

describe("POST /v1/teams and /v1/join", () => {
  it("creates a team with an invite that people exchange for tokens", async () => {
    const { team, invite } = await createTeam("Join Team");
    expect(team.id).toBe("join-team");
    expect(invite).toMatch(/^selfhost_inv_/);

    const first = await join(invite, "ada@example.com");
    expect(first.person).toMatchObject({ id: "ada@example.com", team: "join-team", role: "owner" });
    expect(first.token).toMatch(/^selfhost_pt_/);
    const second = await join(invite, "  bob@example.com ");
    expect(second.person).toMatchObject({ id: "bob@example.com", role: "member" });
  });

  it("refuses a taken name, an empty name, and a person token", async () => {
    const { invite } = await createTeam("Taken");
    const res = await server.request("/v1/teams", json("POST", { name: "taken" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiError).error.code).toBe("team_exists");
    const empty = await server.request("/v1/teams", json("POST", { name: "--" }));
    expect(empty.status).toBe(400);
    const extra = await server.request("/v1/teams", json("POST", { name: "x", owner: "me" }));
    expect(extra.status).toBe(400);

    const { token } = await join(invite, "ada@example.com");
    const asPerson = await server.app.request("/v1/teams", as(token, json("POST", { name: "x" })));
    expect(asPerson.status).toBe(403);
    expect(((await asPerson.json()) as ApiError).error.code).toBe("forbidden");
    const anonymous = await server.app.request("/v1/teams", json("POST", { name: "x" }));
    expect(anonymous.status).toBe(401);
  });

  it("refuses an unknown invite and a bad body", async () => {
    const bad = await joinAs("selfhost_inv_nope", "x@example.com");
    expect(bad.headers.get("www-authenticate")).toBe('Bearer realm="selfhost"');
    expect(await refused(bad)).toBe("Unknown invite code");
    const noPerson = await server.app.request("/v1/join", json("POST", { invite: "x" }));
    expect(noPerson.status).toBe(400);
    const blank = await server.app.request("/v1/join", json("POST", { invite: "x", person: " " }));
    expect(blank.status).toBe(400);
    const notJson = await server.app.request("/v1/join", { method: "POST", body: "{" });
    expect(notJson.status).toBe(400);
  });
});

describe("GET /v1/me", () => {
  it("names the admin, the person and the team", async () => {
    const admin = await server.request("/v1/me");
    expect(await admin.json()).toEqual({ kind: "admin", allowed: [...TEAM_ACTIONS] });

    const { invite } = await createTeam("Me Team");
    const { token, person } = await join(invite, "ada@example.com");
    const res = await server.app.request("/v1/me", as(token));
    const body = await res.json();
    matches(MeResponseSchema, body);
    expect(body).toMatchObject({
      kind: "person",
      person,
      team: { id: "me-team", name: "Me Team" },
    });

    const unknown = await server.app.request("/v1/me", as("selfhost_pt_nope"));
    expect(unknown.status).toBe(401);
  });
});

describe("events written with a person token", () => {
  let token: string;

  beforeAll(async () => {
    const { invite } = await createTeam("Events Team");
    ({ token } = await join(invite, "ada@example.com"));
  });

  const write = (events: unknown[]) =>
    server.app.request("/v1/events", as(token, json("POST", { events })));

  const stored = async (person: string) => {
    const res = await server.request(`/v1/events?person=${encodeURIComponent(person)}`);
    return ((await res.json()) as EventsPage).events;
  };

  it("set team, keep the person's own actor and fill a missing one", async () => {
    const own = makeEvent({ team: "someone-else" });
    const agent = makeEvent({ actor: { kind: "agent", id: "claude_code:session:a" } });
    const { actor: _drop, ...noActor } = makeEvent();
    const res = await write([own, agent, noActor]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 3, duplicates: 0 });

    const mine = await stored("ada@example.com");
    expect(mine.map((e) => e.id).sort()).toEqual([own.id, noActor.id].sort());
    expect(mine.every((e) => e.team === "events-team")).toBe(true);
    expect((await stored("claude_code:session:a"))[0]?.team).toBe("events-team");
  });

  it("refuse another person's and system actors, writing nothing", async () => {
    const good = makeEvent({ actor: { kind: "person", id: "ada@example.com" } });
    const other = makeEvent({ actor: { kind: "person", id: "eve@example.com" } });
    const system = makeEvent({ actor: { kind: "system", id: "litellm:key" } });
    const res = await write([good, other, system]);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "invalid_events" },
      errors: [
        {
          index: 1,
          field: "actor.id",
          message: "Expected ada@example.com, the person this token belongs to",
        },
        { index: 2, field: "actor.kind", message: "A person token cannot write system events" },
      ],
    });
    expect((await stored("ada@example.com")).map((e) => e.id)).not.toContain(good.id);
  });

  it("take the laptop's own rule verdicts and alerts, stamped with who sent them", async () => {
    const verdict = makeEvent({
      source: "hook",
      kind: "policy.evaluated",
      actor: { kind: "system", id: "selfhost-policy" },
      decision: { verdict: "block", by: "selfhost-policy", rule_id: "no-curl", mode: "enforce" },
      data: { exception: { id: "0193ffff-0000-7000-8000-000000000001", fingerprint: "f" } },
    });
    const alert = makeEvent({
      source: "cli",
      kind: "alert.raised",
      actor: { kind: "system", id: "selfhost" },
      data: { alert: "spend_spike", sent_by: "eve@example.com" },
    });
    const res = await write([verdict, alert]);
    expect(res.status).toBe(200);
    const stored = await server.request("/v1/events?team=events-team&limit=1000");
    const events = ((await stored.json()) as EventsPage).events;
    for (const sent of [verdict, alert]) {
      const event = events.find((e) => e.id === sent.id);
      expect(event?.actor.kind).toBe("system");
      expect(event?.team).toBe("events-team");
      // Whatever the batch said, the person who sent it.
      expect(event?.data?.sent_by).toBe("ada@example.com");
    }
  });

  it("refuse system events that would speak for a person or the server", async () => {
    const policy = (overrides: Partial<LedgerEvent>) =>
      makeEvent({
        source: "hook",
        kind: "policy.evaluated",
        actor: { kind: "system", id: "selfhost-policy" },
        decision: { verdict: "block", by: "selfhost-policy" },
        ...overrides,
      });
    const cases: [LedgerEvent, string][] = [
      [policy({ decision: { verdict: "approve", by: "selfhost-policy" } }), "decision.verdict"],
      [policy({ decision: { verdict: "block", by: "eve@example.com" } }), "decision.by"],
      [policy({ actor: { kind: "system", id: "selfhost" } }), "actor.id"],
      [policy({ source: "server" }), "source"],
      [
        makeEvent({
          kind: "decision.recorded",
          actor: { kind: "system", id: "selfhost" },
          decision: { verdict: "deny", by: "selfhost" },
        }),
        "actor.kind",
      ],
      [
        makeEvent({
          source: "hook",
          kind: "alert.raised",
          actor: { kind: "system", id: "selfhost" },
          data: { alert: "spend_spike" },
        }),
        "source",
      ],
      [
        makeEvent({
          source: "cli",
          kind: "alert.raised",
          actor: { kind: "system", id: "litellm:key" },
          data: { alert: "spend_spike" },
        }),
        "actor.id",
      ],
    ];
    for (const [event, field] of cases) {
      const res = await write([event]);
      expect(res.status, field).toBe(400);
      expect(await res.json()).toMatchObject({ errors: [{ index: 0, field }] });
    }
  });

  it("are idempotent and validated like any other batch", async () => {
    const event = makeEvent();
    await write([event]);
    expect(await (await write([event])).json()).toEqual({ accepted: 0, duplicates: 1 });
    const invalid = await write([{ ...makeEvent(), ts: "yesterday" }]);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ errors: [{ index: 0, field: "ts" }] });
    const notJson = await server.app.request(
      "/v1/events",
      as(token, { method: "POST", body: "{", headers: { "content-type": "application/json" } }),
    );
    expect(notJson.status).toBe(400);
  });

  it("cannot reach the admin token's routes", async () => {
    for (const [method, path] of [
      ["POST", "/v1/teams"],
      ["POST", "/v1/orgs"],
    ] as const) {
      const res = await server.app.request(path, as(token, json(method, { name: "x" })));
      expect(res.status, path).toBe(403);
    }
  });
});

describe("invites", () => {
  it("expire after 7 days by default, or after the lifetime asked for", async () => {
    const before = Date.now();
    const plain = await createTeam("Week Team");
    const week = (Date.parse(plain.invite_expires_at) - before) / 1000;
    expect(week).toBeGreaterThan(INVITE_TTL_DEFAULT_SECONDS - 60);
    expect(week).toBeLessThanOrEqual(INVITE_TTL_DEFAULT_SECONDS + 60);

    const short = await createTeam("Hour Team", { invite_ttl_seconds: 3600 });
    expect((Date.parse(short.invite_expires_at) - before) / 1000).toBeLessThanOrEqual(3660);
    const another = await createInvite("hour-team", { ttl_seconds: 600 });
    expect(another).toMatchObject({ team: "hour-team" });
    expect(another.id).toMatch(/^[0-9a-f]{64}$/);
    expect((Date.parse(another.expires_at) - before) / 1000).toBeLessThanOrEqual(660);

    for (const ttl of [0, 59, 366 * 86_400, 1.5]) {
      const bad = await server.request(
        "/v1/teams/hour-team/invites",
        json("POST", { ttl_seconds: ttl }),
      );
      expect(bad.status, String(ttl)).toBe(400);
    }
    const badTeam = await server.request(
      "/v1/teams",
      json("POST", { name: "x", invite_ttl_seconds: 1 }),
    );
    expect(badTeam.status).toBe(400);
    const missing = await server.request("/v1/teams/nope/invites", json("POST", {}));
    expect(missing.status).toBe(404);
    const anonymous = await server.app.request("/v1/teams/hour-team/invites", json("POST", {}));
    expect(anonymous.status).toBe(401);
  });

  it("answer 401 once expired", async () => {
    const { invite } = await createTeam("Expired Team");
    // The ledger tests move real expiry times; here the store reports the invite as expired.
    vi.spyOn(server.ledger.teams, "join").mockResolvedValueOnce({ refused: "expired" });
    expect(await refused(await joinAs(invite, "late@example.com"))).toMatch(/expired/);
    vi.restoreAllMocks();
    expect((await joinAs(invite, "late@example.com")).status).toBe(200);
  });

  it("answer 401 once revoked, and only the admin token, owners and admins revoke them", async () => {
    const { invite } = await createTeam("Revoke Team");
    const extra = await createInvite("revoke-team");
    const { token } = await join(extra.invite, "ada@example.com");
    const { token: member } = await join(invite, "mia@example.com");

    const asMember = await server.app.request(
      `/v1/invites/${extra.id}`,
      as(member, { method: "DELETE" }),
    );
    expect(asMember.status).toBe(403);
    const res = await server.request(`/v1/invites/${extra.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const revoked = (await res.json()) as Invite;
    matches(InviteSchema, revoked);
    expect(revoked).toMatchObject({ id: extra.id, team: "revoke-team" });
    expect(await refused(await joinAs(extra.invite, "bob@example.com"))).toMatch(/revoked/);
    // People who joined keep their tokens, and other invites keep working.
    expect((await server.app.request("/v1/me", as(token))).status).toBe(200);
    expect((await joinAs(invite, "bob@example.com")).status).toBe(200);

    const again = await server.request(`/v1/invites/${extra.id}`, { method: "DELETE" });
    expect(((await again.json()) as { revoked_at: string }).revoked_at).toBe(revoked.revoked_at);
    const unknown = await server.request(`/v1/invites/${"0".repeat(64)}`, { method: "DELETE" });
    expect(unknown.status).toBe(404);
  });

  it("team-wide add only new people; the owner and others who joined need their own invite", async () => {
    const { invite } = await createTeam("Claim Team");
    const owner = await join(invite, "ada@example.com");
    expect(owner.person.role).toBe("owner");
    const bob = await join(invite, "bob@example.com");
    expect(bob.person.role).toBe("member");

    for (const person of ["ada@example.com", "bob@example.com", "ADA@example.com"]) {
      expect(await refused(await joinAs(invite, person)), person).toMatch(
        /already in the team.*invite for this person.*revoke them and invite them again/,
      );
    }
    expect((await joinAs(invite, "carol@example.com")).status).toBe(200);

    // An invite for the owner adds another token for the owner, with the owner's role.
    const forOwner = await createInvite("claim-team", { email: "ada@example.com" });
    const again = await join(forOwner.invite, "ada@example.com");
    expect(again.person).toEqual(owner.person);
    expect(again.token).not.toBe(owner.token);
  });

  it("with an email join only that person, under that email", async () => {
    await createTeam("Email Team");
    const invite = await createInvite("email-team", { email: "carol@example.com" });
    expect(invite.email).toBe("carol@example.com");

    expect(await refused(await joinAs(invite.invite, "mallory@example.com"))).toMatch(
      /for someone else/,
    );
    const joined = await join(invite.invite, "Carol@Example.com");
    expect(joined.person).toMatchObject({ id: "carol@example.com", team: "email-team" });

    const notEmail = await server.request(
      "/v1/teams/email-team/invites",
      json("POST", { email: "carol" }),
    );
    expect(notEmail.status).toBe(400);
  });
});

describe("revoking person tokens", () => {
  it("lets a person revoke the token they use, and only that one", async () => {
    const { invite } = await createTeam("Leave Team");
    const laptop = await join(invite, "ada@example.com");
    const forAda = await createInvite("leave-team", { email: "ada@example.com" });
    const desktop = await join(forAda.invite, "ada@example.com");

    const res = await server.app.request("/v1/me/token", as(laptop.token, { method: "DELETE" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    matches(RevokeTokensResponseSchema, body);
    expect(body).toEqual({ team: "leave-team", person: "ada@example.com", revoked: 1 });
    expect((await server.app.request("/v1/me", as(laptop.token))).status).toBe(401);
    const again = await server.app.request("/v1/me/token", as(laptop.token, { method: "DELETE" }));
    expect(again.status).toBe(401);
    expect((await server.app.request("/v1/me", as(desktop.token))).status).toBe(200);

    const admin = await server.request("/v1/me/token", { method: "DELETE" });
    expect(admin.status).toBe(403);
  });

  it("lets the admin token revoke every token a person holds", async () => {
    const { invite } = await createTeam("Offboard Team");
    const owner = await join(invite, "ada@example.com");
    const first = await join(invite, "bob@example.com");
    const carol = await join(invite, "carol@example.com");
    const forBob = await createInvite("offboard-team", { email: "bob@example.com" });
    const second = await join(forBob.invite, "bob@example.com");
    const path = "/v1/teams/offboard-team/people/bob%40example.com/tokens";

    // A member cannot cut off another member, or the owner.
    expect((await server.app.request(path, as(carol.token, { method: "DELETE" }))).status).toBe(
      403,
    );
    const ownerPath = "/v1/teams/offboard-team/people/ada%40example.com/tokens";
    expect(
      (await server.app.request(ownerPath, as(carol.token, { method: "DELETE" }))).status,
    ).toBe(403);
    const res = await server.request(path, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    matches(RevokeTokensResponseSchema, body);
    // Both tokens, and the open invite for bob's email.
    expect(body).toEqual({ team: "offboard-team", person: "bob@example.com", revoked: 3 });
    expect(await refused(await joinAs(forBob.invite, "bob@example.com"))).toMatch(/revoked/);
    for (const { token } of [first, second]) {
      const write = await server.app.request(
        "/v1/events",
        as(
          token,
          json("POST", {
            events: [makeEvent({ actor: { kind: "person", id: "bob@example.com" } })],
          }),
        ),
      );
      expect(write.status).toBe(401);
    }
    expect((await server.app.request("/v1/me", as(owner.token))).status).toBe(200);

    const unknown = await server.request(
      "/v1/teams/offboard-team/people/eve%40example.com/tokens",
      {
        method: "DELETE",
      },
    );
    expect(unknown.status).toBe(404);
  });
});

describe("reading events with a person token", () => {
  let red: { ada: string; bob: string };
  let blue: string;
  const written: Record<string, string[]> = { red: [], blue: [] };

  beforeAll(async () => {
    const redTeam = await createTeam("Red Readers");
    const blueTeam = await createTeam("Blue Readers");
    red = {
      ada: (await join(redTeam.invite, "ada@example.com")).token,
      bob: (await join(redTeam.invite, "bob@example.com")).token,
    };
    blue = (await join(blueTeam.invite, "eve@example.com")).token;

    const write = async (token: string, team: string, events: LedgerEvent[]) => {
      const res = await server.app.request("/v1/events", as(token, json("POST", { events })));
      expect(res.status).toBe(200);
      written[team]?.push(...events.map((e) => e.id));
    };
    const ts = (n: number) => `2026-11-0${n}T10:00:00.000Z`;
    await write(red.ada, "red", [
      makeEvent({ ts: ts(1), actor: { kind: "person", id: "ada@example.com" } }),
      makeEvent({ ts: ts(2), actor: { kind: "agent", id: "codex:session:red" } }),
    ]);
    await write(red.bob, "red", [
      makeEvent({ ts: ts(3), actor: { kind: "person", id: "bob@example.com" } }),
    ]);
    await write(blue, "blue", [
      makeEvent({ ts: ts(4), actor: { kind: "person", id: "eve@example.com" } }),
    ]);
    // The admin token can write any team into the body; that does not make it the team's.
    const admin = await server.request(
      "/v1/events",
      json("POST", { events: [makeEvent({ ts: ts(5), team: "red-readers" })] }),
    );
    expect(admin.status).toBe(200);
  });

  const read = async (token: string, query = "") => {
    const res = await server.app.request(`/v1/events${query}`, as(token));
    expect(res.status).toBe(200);
    return (await res.json()) as EventsPage;
  };

  it("sees every event its team wrote and nothing else", async () => {
    const page = await read(red.bob);
    expect(page.events.map((e) => e.id).sort()).toEqual([...(written.red ?? [])].sort());
    expect(page.events.every((e) => e.team === "red-readers")).toBe(true);
    expect((await read(blue)).events.map((e) => e.id)).toEqual(written.blue);
  });

  it("filters and pages inside the team", async () => {
    expect((await read(red.ada, "?person=eve%40example.com")).events).toEqual([]);
    expect((await read(red.ada, "?team=red-readers&person=bob%40example.com")).events).toHaveLength(
      1,
    );
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: EventsPage = await read(
        red.ada,
        `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      ids.push(...page.events.map((e) => e.id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(ids.sort()).toEqual([...(written.red ?? [])].sort());
  });

  it("refuses another team and bad queries", async () => {
    const other = await server.app.request("/v1/events?team=blue-readers", as(red.ada));
    expect(other.status).toBe(403);
    expect(((await other.json()) as ApiError).error.code).toBe("forbidden");
    expect((await server.app.request("/v1/events?nope=1", as(red.ada))).status).toBe(400);
  });

  it("lets the admin token read one team", async () => {
    const res = await server.request("/v1/events?team=red-readers");
    const ids = ((await res.json()) as EventsPage).events.map((e) => e.id);
    expect(ids.sort()).toEqual([...(written.red ?? [])].sort());
  });
});

describe("stampEvents", () => {
  const person = {
    id: "ada@example.com",
    team: "t",
    role: "member" as const,
    created_at: "2026-11-07T00:00:00.000Z",
  };

  it("passes bodies the events route rejects through unchanged", () => {
    expect(stampEvents("{", person)).toEqual({ body: "{" });
    expect(stampEvents("[]", person)).toEqual({ body: "[]" });
    expect(stampEvents('{"events":1}', person)).toEqual({ body: '{"events":1}' });
  });
});

describe("/v1/policy", () => {
  const TOML = `version = 1

[[rules]]
id = "no-force-push"
match = { tool = "Bash", command = "git\\\\s+push\\\\s+.*--force" }
action = "block"
message = "Force pushes are blocked."

[[rules]]
id = "codex-only"
agents = ["codex"]
match = { tool = "Bash" }
action = "ask"
message = "Codex asks first."

[teams.policy-team.rules.no-force-push]
mode = "enforce"
`;
  let owner: string;
  let member: string;

  beforeAll(async () => {
    const { invite } = await createTeam("Policy Team");
    ({ token: owner } = await join(invite, "ada@example.com"));
    ({ token: member } = await join(invite, "bob@example.com"));
  });

  const put = (token: string, text: string, query = "") =>
    server.app.request(`/v1/policy${query}`, as(token, json("PUT", { text })));

  it("is 404 until a policy is set", async () => {
    const res = await server.app.request("/v1/policy", as(member));
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiError).error.code).toBe("no_policy");
    const missing = await server.request("/v1/policy?team=nope");
    expect(((await missing.json()) as ApiError).error.code).toBe("not_found");
  });

  it("can be set by the admin token and the team's owner, not by members", async () => {
    expect((await put(member, TOML)).status).toBe(403);
    expect((await put(owner, TOML, "?team=events-team")).status).toBe(403);
    expect((await server.request("/v1/policy", json("PUT", { text: TOML }))).status).toBe(400);
    const byAdmin = await server.request(
      "/v1/policy?team=policy-team",
      json("PUT", { text: TOML }),
    );
    expect(byAdmin.status).toBe(200);
    const res = await put(owner, TOML);
    expect(res.status).toBe(200);
    matches(PolicyResponseSchema, await res.json());
  });

  it("refuses an invalid selfhost.toml and keeps the old one", async () => {
    const res = await put(owner, "version = 1\n\n[ledger]\nretention_days = 0\n");
    expect(res.status).toBe(400);
    const body = (await res.json()) as InvalidPolicyError;
    matches(InvalidPolicyErrorSchema, body);
    expect(body.errors).toEqual([
      { field: "ledger.retention_days", message: expect.any(String), line: 4 },
    ]);
    const current = await server.app.request("/v1/policy", as(member));
    expect(((await current.json()) as PolicyResponse).text).toBe(TOML);
  });

  it("returns the text, the parsed config and the rules for the team", async () => {
    const res = await server.app.request("/v1/policy", as(member));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PolicyResponse;
    matches(PolicyResponseSchema, body);
    expect(body).toMatchObject({ team: "policy-team", text: TOML });
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.config.rules?.map((r) => r.id)).toEqual(["no-force-push", "codex-only"]);
    expect(body.effective_rules.map((r) => [r.id, r.mode])).toEqual([
      ["no-force-push", "enforce"],
      ["codex-only", "observe"],
    ]);
    const claude = await server.app.request("/v1/policy?agent=claude_code", as(member));
    expect(((await claude.json()) as PolicyResponse).effective_rules.map((r) => r.id)).toEqual([
      "no-force-push",
    ]);
  });

  it("is per team: other teams and bad queries are refused", async () => {
    expect((await server.app.request("/v1/policy?team=events-team", as(member))).status).toBe(403);
    expect((await server.request("/v1/policy")).status).toBe(400);
    expect((await server.app.request("/v1/policy?agent=robot", as(member))).status).toBe(400);
    const admin = await server.request("/v1/policy?team=policy-team");
    expect(((await admin.json()) as PolicyResponse).team).toBe("policy-team");
  });
});

describe("no model traffic", () => {
  const attempts: string[] = [];
  const block = (name: string) => () => {
    attempts.push(name);
    throw new Error(`network access attempted: ${name}`);
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("has no proxy route for vendor APIs, with any token", async () => {
    const { invite } = await createTeam("Proxy Check");
    const { token } = await join(invite, "ada@example.com");
    const paths = [
      "/v1/messages",
      "/v1/chat/completions",
      "/v1/responses",
      "/v1/completions",
      "/v1/models",
      "/anthropic/v1/messages",
      "/openai/v1/chat/completions",
    ];
    for (const path of paths) {
      const admin = await server.request(path, json("POST", { model: "x", messages: [] }));
      expect(admin.status, path).toBe(404);
      const person = await server.app.request(path, as(token, json("POST", { model: "x" })));
      expect(person.status, path).toBe(403);
    }
  });

  it("opens no outbound connection while serving team requests", async () => {
    attempts.length = 0;
    vi.spyOn(net, "connect").mockImplementation(block("net.connect"));
    vi.spyOn(net, "createConnection").mockImplementation(block("net.createConnection"));
    vi.spyOn(tls, "connect").mockImplementation(block("tls.connect"));
    vi.spyOn(http, "request").mockImplementation(block("http.request"));
    vi.spyOn(https, "request").mockImplementation(block("https.request"));
    vi.spyOn(dns, "lookup").mockImplementation(block("dns.lookup"));
    vi.stubGlobal("fetch", vi.fn(block("fetch")));

    const { invite } = await createTeam("Offline Team");
    const { token } = await join(invite, "ada@example.com");
    await server.app.request("/v1/events", as(token, json("POST", { events: [makeEvent()] })));
    await server.app.request("/v1/policy", as(token, json("PUT", { text: "version = 1\n" })));
    await server.app.request("/v1/policy", as(token));
    await server.app.request("/v1/me", as(token));
    expect(attempts).toEqual([]);
  });
});
