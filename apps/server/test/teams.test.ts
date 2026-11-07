import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import {
  type ApiError,
  CreateTeamResponseSchema,
  createValidator,
  type EventsPage,
  type InvalidPolicyError,
  InvalidPolicyErrorSchema,
  type JoinResponse,
  JoinResponseSchema,
  type LedgerEvent,
  MeResponseSchema,
  type PolicyResponse,
  PolicyResponseSchema,
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

async function createTeam(name: string) {
  const res = await server.request("/v1/teams", json("POST", { name }));
  expect(res.status).toBe(201);
  const body = await res.json();
  matches(CreateTeamResponseSchema, body);
  return body as { team: { id: string }; invite: string };
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
    const bad = await server.app.request(
      "/v1/join",
      json("POST", { invite: "selfhost_inv_nope", person: "x@example.com" }),
    );
    expect(bad.status).toBe(403);
    expect(((await bad.json()) as ApiError).error.code).toBe("invalid_invite");
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
    expect(await admin.json()).toEqual({ kind: "admin" });

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

  it("cannot read the ledger", async () => {
    const res = await server.app.request("/v1/events", as(token));
    expect(res.status).toBe(403);
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
