import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import type { Actor, EventsPage, LedgerEvent } from "@selfhost/schema";
import { createApp } from "@selfhost/server/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamApiError, TeamClient } from "../src/team/client.js";
import { RemoteWriter } from "../src/team/remote-writer.js";
import { syncingWriter } from "../src/team/sync.js";
import { blockNetwork } from "./network.js";
import { run, tempDir } from "./run.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const SERVER = "http://team.test";
const ADMIN = "admin-token";
const PERSON = "dev@example.com";

interface TeamServer {
  ledger: Ledger;
  /** Calls the in-process server and records each call as "METHOD url". */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  calls: string[];
  /** Every event on the server but laptop heartbeats, read with the admin token. */
  events(): Promise<LedgerEvent[]>;
  admin(path: string, init?: RequestInit): Promise<Response>;
}

async function startTeamServer(): Promise<TeamServer> {
  const ledger = await openLedger({ dataDir: "memory://" });
  const app = createApp({ version: "test", ledger, token: ADMIN });
  const calls: string[] = [];
  const admin = async (path: string, init: RequestInit = {}) =>
    app.request(`${SERVER}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    });
  return {
    ledger,
    calls,
    admin,
    fetch: async (url, init) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      return app.request(url, init);
    },
    async events() {
      const all: LedgerEvent[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
        const page = (await (await admin(`/v1/events?limit=1000${query}`)).json()) as EventsPage;
        all.push(...page.events);
        cursor = page.next_cursor;
      } while (cursor);
      return all.filter((event) => event.kind !== "config.reported");
    },
  };
}

const parse = (out: string) => JSON.parse(out);

const servers: TeamServer[] = [];

beforeEach(() => {
  // The importers read the log folders from the process environment.
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(fixtures, "claude-code"));
  vi.stubEnv("CODEX_HOME", join(fixtures, "codex"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) await server.ledger.close();
});

async function teamServer() {
  const server = await startTeamServer();
  servers.push(server);
  return server;
}

function laptop() {
  const home = tempDir("team-home");
  const configPath = home.path(".selfhost", "config.json");
  return { home, configPath, dataDir: home.path(".selfhost", "data") };
}

const importArgs = (dataDir: string) => [
  "import",
  "--json",
  "--data-dir",
  dataDir,
  "--since",
  "2026-10-01",
  "--person",
  PERSON,
];

describe("solo mode", () => {
  it("makes no request to any server", async () => {
    const attempts = blockNetwork();
    const { configPath } = laptop();
    const fetch = vi.fn(async () => {
      throw new Error("no server in solo mode");
    });
    const deps = { configPath, fetch };

    const imported = await run(importArgs("memory://"), deps);
    expect(imported.code).toBe(0);
    const report = parse(imported.out);
    expect(report.accepted).toBeGreaterThan(0);
    expect(report).not.toHaveProperty("sync");

    const status = await run(["status", "--json"], deps);
    expect(parse(status.out)).toMatchObject({ schema: "selfhost.status/v1", mode: "solo" });
    const leave = await run(["team", "leave", "--json"], deps);
    expect(parse(leave.out)).toEqual({
      schema: "selfhost.team_leave/v1",
      mode: "solo",
      left: null,
      token_revoked: null,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(attempts).toEqual([]);
  });
});

describe("team init and join", () => {
  it("creates a team, prints the invite and joins with it", async () => {
    const attempts = blockNetwork();
    const server = await teamServer();
    const { configPath } = laptop();
    const deps = { configPath, fetch: server.fetch, env: { SELFHOST_TOKEN: ADMIN } };

    const init = await run(
      ["team", "init", "--server", `${SERVER}/`, "--name", "Platform", "--json"],
      deps,
    );
    expect(init.code).toBe(0);
    const created = parse(init.out);
    expect(created).toMatchObject({
      schema: "selfhost.team_init/v1",
      server: SERVER,
      team: { id: "platform", name: "Platform" },
    });
    expect(created.join_command).toBe(`selfhost join ${SERVER} ${created.invite}`);
    // team init is an admin action and does not join this machine.
    expect(existsSync(configPath)).toBe(false);

    const joined = await run(["join", SERVER, created.invite, "--person", PERSON, "--json"], deps);
    expect(joined.code).toBe(0);
    expect(parse(joined.out)).toEqual({
      schema: "selfhost.join/v1",
      server: SERVER,
      team: created.team,
      person: PERSON,
      role: "owner",
      config: configPath,
      // The team has no context layers yet.
      context: { hash: expect.any(String), layers: [] },
      // Nor a policy, so there are no managed settings to install; the heartbeat still goes.
      policy_hash: null,
      laptop: { managed: null, heartbeat: { sent: true, machine: expect.any(String) } },
    });

    // Only the membership is stored: no vendor login, API key or anything else.
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(Object.keys(config).sort()).toEqual(["person", "server", "team", "token"]);
    expect(config).toMatchObject({ server: SERVER, person: PERSON, team: "platform" });
    expect(config.token).toMatch(/^selfhost_pt_/);
    expect(joined.out).not.toContain(config.token);
    if (process.platform !== "win32") expect(statSync(configPath).mode & 0o777).toBe(0o600);

    const again = await run(["join", SERVER, created.invite, "--json"], deps);
    expect(again.code).toBe(1);
    expect(parse(again.out).error).toMatch(/Already in team platform/);
    expect(attempts).toEqual([]);
  });

  it("keeps the other settings in the config file", async () => {
    const server = await teamServer();
    const { home, configPath } = laptop();
    home.write(".selfhost/config.json", '{ "telemetry": { "agent_count": false } }\n');
    const deps = { configPath, fetch: server.fetch, env: { SELFHOST_TOKEN: ADMIN } };
    const { invite } = parse((await run(["team", "init", "--server", SERVER, "--json"], deps)).out);
    await run(["join", SERVER, invite, "--person", PERSON], deps);
    expect(Object.keys(JSON.parse(readFileSync(configPath, "utf8"))).sort()).toEqual([
      "person",
      "server",
      "team",
      "telemetry",
      "token",
    ]);
    await run(["team", "leave"], deps);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      telemetry: { agent_count: false },
    });
  });

  it("changes no files when the invite is refused or the token is missing", async () => {
    const server = await teamServer();
    const { home, configPath } = laptop();
    const deps = { configPath, fetch: server.fetch, env: {} };

    const refused = await run(
      ["join", SERVER, "selfhost_inv_nope", "--person", PERSON, "--json"],
      deps,
    );
    expect(refused.code).toBe(1);
    expect(parse(refused.out).error).toMatch(/401.*Unknown invite code/);
    expect(existsSync(home.path(".selfhost"))).toBe(false);

    const noToken = await run(["team", "init", "--server", SERVER, "--json"], deps);
    expect(noToken.code).toBe(1);
    expect(parse(noToken.out).error).toMatch(/admin token/);
    const badUrl = await run(["join", "ftp://team.test", "x"], deps);
    expect(badUrl.err).toMatch(/http or https/);
    expect(server.calls).toEqual([`POST ${SERVER}/v1/join`]);
  });
});

describe("moving from solo to team", () => {
  it("needs no migration: local history reaches the server after join", async () => {
    const attempts = blockNetwork();
    const server = await teamServer();
    const { home, configPath, dataDir } = laptop();
    const repo = tempDir("team-repo");
    mkdirSync(repo.path(".git"));
    repo.write("selfhost.toml", "version = 1\n");
    const deps = {
      configPath,
      fetch: server.fetch,
      cwd: repo.root,
      env: { SELFHOST_TOKEN: ADMIN },
    };

    // Solo: import into the local ledger. No server is involved.
    const solo = parse((await run(importArgs(dataDir), deps)).out);
    expect(solo.accepted).toBeGreaterThan(0);
    expect(solo).not.toHaveProperty("sync");
    expect(server.calls).toEqual([]);

    // The admin creates the team and sets its policy; this laptop joins.
    const { invite } = parse((await run(["team", "init", "--server", SERVER, "--json"], deps)).out);
    const policy = "version = 1\n\n[ledger]\nretention_days = 30\n";
    expect(
      (
        await server.admin("/v1/policy?team=default", {
          method: "PUT",
          body: JSON.stringify({ text: policy }),
        })
      ).status,
    ).toBe(200);
    await run(["join", SERVER, invite, "--person", PERSON], deps);

    // First sync: the whole local ledger goes up and the policy comes down.
    const first = parse((await run(importArgs(dataDir), deps)).out);
    expect(first.accepted).toBe(0);
    expect(first.sync).toMatchObject({
      server: SERVER,
      team: "default",
      person: PERSON,
      history: true,
      sent: solo.accepted,
      accepted: solo.accepted,
      duplicates: 0,
    });
    expect(first.sync.policy_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(home.path(".selfhost", "team-policy.toml"), "utf8")).toBe(policy);

    const shared = await server.events();
    expect(shared).toHaveLength(solo.accepted);
    expect(shared.every((event) => event.team === "default")).toBe(true);
    expect(
      shared.filter((e) => e.actor.kind === "person").every((e) => e.actor.id === PERSON),
    ).toBe(true);

    // Later syncs resend the import window; ids are idempotent, so nothing doubles.
    const second = parse((await run(importArgs(dataDir), deps)).out);
    expect(second.sync).toMatchObject({ history: false, accepted: 0 });
    expect(second.sync.duplicates).toBe(second.sync.sent);
    expect(await server.events()).toHaveLength(solo.accepted);

    // The local ledger and selfhost.toml kept working the whole time.
    const local = await openLedger({ dataDir });
    try {
      const page = await local.query({ limit: 1000 });
      expect(page.events.length).toBeGreaterThan(0);
    } finally {
      await local.close();
    }
    // The repository's selfhost.toml wins over the pulled team policy, and doctor says so.
    expect(parse((await run(["doctor", "--json"], deps)).out).config).toMatchObject({
      path: repo.path("selfhost.toml"),
      from: "search",
      valid: true,
      team_policy: { path: home.path(".selfhost", "team-policy.toml"), team: "default" },
    });

    const status = parse((await run(["status", "--json"], deps)).out);
    expect(status).toMatchObject({
      mode: "team",
      server: SERVER,
      team: "default",
      person: PERSON,
      history_synced: true,
      policy_hash: first.sync.policy_hash,
    });
    expect(Date.parse(status.last_sync)).not.toBeNaN();

    // The CLI only ever called the configured server, and only its API.
    expect(server.calls.length).toBeGreaterThan(0);
    for (const call of server.calls)
      expect(call).toMatch(/^(GET|POST|PUT|DELETE) http:\/\/team\.test\/v1\//);
    expect(attempts).toEqual([]);

    // Leaving revokes the token on the server and goes back to solo without touching the
    // ledger, and solo calls nobody.
    const { token } = JSON.parse(readFileSync(configPath, "utf8"));
    const left = parse((await run(["team", "leave", "--json"], deps)).out);
    expect(left).toMatchObject({
      left: { server: SERVER, team: "default", person: PERSON },
      token_revoked: true,
    });
    expect(server.calls.at(-1)).toBe(`DELETE ${SERVER}/v1/me/token`);
    const me = await server.fetch(`${SERVER}/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(401);
    expect(existsSync(home.path(".selfhost", "team-policy.toml"))).toBe(false);
    const calls = server.calls.length;
    const after = parse((await run(importArgs(dataDir), deps)).out);
    expect(after).not.toHaveProperty("sync");
    expect(after.duplicates).toBe(solo.accepted);
    expect(server.calls).toHaveLength(calls);
  });

  it("reports a failed sync, keeps the local import and retries next time", async () => {
    const server = await teamServer();
    const { configPath, dataDir } = laptop();
    let down = true;
    const fetch = async (url: string, init: RequestInit) => {
      if (down && url.endsWith("/v1/events")) return new Response("", { status: 503 });
      return server.fetch(url, init);
    };
    const sleep = vi.fn(async (_ms: number) => {});
    const deps = { configPath, fetch, env: { SELFHOST_TOKEN: ADMIN }, retry: { sleep } };
    const { invite } = parse((await run(["team", "init", "--server", SERVER, "--json"], deps)).out);
    await run(["join", SERVER, invite, "--person", PERSON], deps);

    const failed = await run(importArgs(dataDir), deps);
    expect(failed.code).toBe(1);
    const report = parse(failed.out);
    expect(report.accepted).toBeGreaterThan(0);
    expect(report.sync).toMatchObject({ history: true, sent: 0 });
    expect(report.sync.error).toMatch(/503/);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000, 2000, 4000]);
    expect(parse((await run(["status", "--json"], deps)).out).last_sync).toBeNull();

    down = false;
    const retried = parse((await run(importArgs(dataDir), deps)).out);
    expect(retried.sync).toMatchObject({ history: true, accepted: report.accepted });
    expect(await server.events()).toHaveLength(report.accepted);
  });
});

describe("admin commands", () => {
  async function adminSetup() {
    const server = await teamServer();
    const admin = laptop();
    const deps = {
      configPath: admin.configPath,
      fetch: server.fetch,
      env: { SELFHOST_TOKEN: ADMIN },
    };
    const init = parse(
      (
        await run(
          [
            "team",
            "init",
            "--server",
            SERVER,
            "--name",
            "Platform",
            "--invite-ttl",
            "2h",
            "--json",
          ],
          deps,
        )
      ).out,
    );
    return { server, deps, init };
  }

  it("team init sets how long the first invite works", async () => {
    const before = Date.now();
    const { init, deps, server } = await adminSetup();
    const ms = Date.parse(init.invite_expires_at) - before;
    expect(ms).toBeGreaterThan(2 * 3_600_000 - 60_000);
    expect(ms).toBeLessThanOrEqual(2 * 3_600_000 + 60_000);

    const calls = server.calls.length;
    for (const ttl of ["0d", "30s", "400d", "soon"]) {
      const bad = await run(
        ["team", "init", "--server", SERVER, "--invite-ttl", ttl, "--json"],
        deps,
      );
      expect(bad.code, ttl).toBe(1);
      expect(parse(bad.out).error).toMatch(/--invite-ttl: expected a duration/);
    }
    expect(server.calls).toHaveLength(calls);
    const text = await run(["team", "init", "--server", SERVER, "--name", "Text"], deps);
    expect(text.out).toMatch(/until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, when the invite expires/);
  });

  it("team invite --email makes an invite only that person can use", async () => {
    const { server, deps } = await adminSetup();
    const invited = await run(
      [
        "team",
        "invite",
        "--server",
        SERVER,
        "--team",
        "platform",
        "--email",
        "bob@example.com",
        "--ttl",
        "1d",
        "--json",
      ],
      deps,
    );
    expect(invited.code).toBe(0);
    const report = parse(invited.out);
    expect(report).toMatchObject({
      schema: "selfhost.team_invite/v1",
      server: SERVER,
      team: "platform",
      email: "bob@example.com",
    });
    expect(report.id).toMatch(/^[0-9a-f]{64}$/);
    expect(report.join_command).toBe(
      `selfhost join ${SERVER} ${report.invite} --person bob@example.com`,
    );
    const hours = (Date.parse(report.expires_at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    const mallory = laptop();
    const refused = await run(
      ["join", SERVER, report.invite, "--person", "mallory@example.com", "--json"],
      { configPath: mallory.configPath, fetch: server.fetch },
    );
    expect(refused.code).toBe(1);
    expect(parse(refused.out).error).toMatch(/401.*for someone else/);
    expect(existsSync(mallory.configPath)).toBe(false);

    const bob = laptop();
    const joined = await run(
      ["join", SERVER, report.invite, "--person", "Bob@Example.com", "--json"],
      {
        configPath: bob.configPath,
        fetch: server.fetch,
      },
    );
    expect(parse(joined.out)).toMatchObject({
      person: "bob@example.com",
      team: { id: "platform" },
    });
  });

  it("a team-wide invite adds new people only; an invite for the person adds a machine", async () => {
    const { server, deps, init } = await adminSetup();
    const join = (invite: string, person: string) =>
      run(["join", SERVER, invite, "--person", person, "--json"], {
        configPath: laptop().configPath,
        fetch: server.fetch,
      });
    const owner = parse((await join(init.invite, "owner@example.com")).out);
    expect(owner.role).toBe("owner");
    expect(parse((await join(init.invite, PERSON)).out).role).toBe("member");

    for (const person of ["owner@example.com", PERSON]) {
      const taken = await join(init.invite, person);
      expect(taken.code, person).toBe(1);
      expect(parse(taken.out).error).toMatch(
        /401.*already in the team.*selfhost team invite --email/,
      );
    }

    const forOwner = parse(
      (
        await run(
          [
            "team",
            "invite",
            "--server",
            SERVER,
            "--team",
            "platform",
            "--email",
            "owner@example.com",
            "--json",
          ],
          deps,
        )
      ).out,
    );
    const second = parse((await join(forOwner.invite, "owner@example.com")).out);
    expect(second).toMatchObject({ person: "owner@example.com", role: "owner" });
  });

  it("team invite and revoke default to this machine's team, with the admin token or an owner's", async () => {
    const { server, deps, init } = await adminSetup();
    const noTeam = await run(["team", "invite", "--server", SERVER, "--json"], deps);
    expect(parse(noTeam.out).error).toMatch(/--team/);
    const noServer = await run(["team", "invite", "--team", "platform", "--json"], deps);
    expect(parse(noServer.out).error).toMatch(/--server/);
    const nothing = await run(["team", "invite", "--server", SERVER, "--json"], {
      ...deps,
      env: {},
    });
    expect(parse(nothing.out).error).toMatch(/admin token.*owner or admin/);

    // The first to join owns the team; the next one is a member.
    const owner = laptop();
    const ownerDeps = { configPath: owner.configPath, fetch: server.fetch, env: {} };
    await run(["join", SERVER, init.invite, "--person", "owner@example.com"], ownerDeps);
    const member = laptop();
    const memberDeps = { configPath: member.configPath, fetch: server.fetch, env: {} };
    await run(["join", SERVER, init.invite, "--person", PERSON], memberDeps);

    const byOwner = await run(["team", "invite", "--json"], ownerDeps);
    expect(parse(byOwner.out)).toMatchObject({ server: SERVER, team: "platform", email: null });
    const byMember = await run(["team", "invite", "--json"], memberDeps);
    expect(byMember.code).toBe(1);
    expect(parse(byMember.out).error).toBe(
      `Permission denied: Creating and revoking invites needs the owner or admin role in team platform; you are a member there. (${SERVER} answered 403)`,
    );
    const invited = await run(["team", "invite", "--json"], {
      ...memberDeps,
      env: { SELFHOST_TOKEN: ADMIN },
    });
    expect(parse(invited.out)).toMatchObject({ server: SERVER, team: "platform", email: null });
    // A person token passed as --token is checked by its role too.
    const { token } = JSON.parse(readFileSync(member.configPath, "utf8"));
    const asPerson = await run(
      ["team", "invite", "--server", SERVER, "--team", "platform", "--token", token, "--json"],
      deps,
    );
    expect(parse(asPerson.out).error).toMatch(/Permission denied.*403/);
  });

  it("team role, add, people and repo manage the team with the role checks of the server", async () => {
    const { server, deps, init } = await adminSetup();
    const machine = async (person: string) => {
      const { configPath } = laptop();
      const machineDeps = { configPath, fetch: server.fetch, env: {} };
      expect((await run(["join", SERVER, init.invite, "--person", person], machineDeps)).code).toBe(
        0,
      );
      return machineDeps;
    };
    const owner = await machine("owner@example.com");
    const member = await machine(PERSON);

    const promoted = await run(["team", "role", PERSON, "admin", "--json"], owner);
    expect(parse(promoted.out)).toEqual({
      schema: "selfhost.team_role/v1",
      server: SERVER,
      team: "platform",
      person: PERSON,
      role: "admin",
    });
    const text = await run(["team", "role", PERSON, "member"], owner);
    expect(text.out).toBe(`${PERSON} is now a member of team platform on ${SERVER}.`);
    const byMember = await run(["team", "role", "owner@example.com", "member", "--json"], member);
    expect(parse(byMember.out).error).toMatch(
      /^Permission denied: Changing roles needs the owner role in team platform; you are a member there\./,
    );
    const last = await run(["team", "role", "owner@example.com", "admin", "--json"], owner);
    expect(parse(last.out).error).toMatch(/409.*last owner of team platform/);
    const bad = await run(["team", "role", PERSON, "boss", "--json"], owner);
    expect(parse(bad.out).error).toMatch(/expected one of owner, admin, member/);

    const people = parse((await run(["team", "people", "--json"], member)).out);
    expect(people).toMatchObject({ schema: "selfhost.team_people/v1", team: "platform" });
    expect(people.people.map((p: { id: string; role: string }) => [p.id, p.role])).toEqual([
      ["owner@example.com", "owner"],
      [PERSON, "member"],
    ]);

    const added = await run(
      ["team", "repo", "add", "git@github.com:acme/api.git", "--json"],
      owner,
    );
    expect(parse(added.out)).toMatchObject({
      schema: "selfhost.team_repos/v1",
      repos: [{ repo: "acme/api", remote: "github.com/acme/api", team: "platform" }],
    });
    const notMine = await run(["team", "repo", "add", "acme/web", "--json"], member);
    expect(parse(notMine.out).error).toMatch(/^Permission denied: Changing team settings/);
    const listed = await run(["team", "repo", "list"], member);
    expect(listed.out).toBe(`Team platform on ${SERVER} owns acme/api.`);
    const removed = parse((await run(["team", "repo", "remove", "acme/api", "--json"], owner)).out);
    expect(removed.repos).toEqual([]);

    // Someone from another team of the org is added, not invited again.
    await run(["team", "init", "--server", SERVER, "--name", "Data", "--json"], deps);
    const stranger = await run(["team", "add", "nobody@example.com", "--json"], owner);
    expect(parse(stranger.out).error).toMatch(/404.*in no other team of this org/);
  });

  it("team revoke stops an invite from working", async () => {
    const { server, deps, init } = await adminSetup();
    const text = await run(["team", "revoke", init.invite, "--server", SERVER], deps);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/Revoked the invite to team platform/);
    expect(text.out).not.toContain(init.invite);
    // The invite code goes to the server as its sha256, never in the URL.
    for (const call of server.calls) expect(call).not.toContain(init.invite);

    const again = parse(
      (await run(["team", "revoke", init.invite, "--server", SERVER, "--json"], deps)).out,
    );
    expect(again).toMatchObject({
      schema: "selfhost.team_revoke/v1",
      team: "platform",
      person: null,
    });
    expect(again.invite).toMatch(/^[0-9a-f]{64}$/);

    const late = laptop();
    const refused = await run(["join", SERVER, init.invite, "--person", PERSON, "--json"], {
      configPath: late.configPath,
      fetch: server.fetch,
    });
    expect(parse(refused.out).error).toMatch(/401.*revoked/);
  });

  it("team revoke <person> cuts off every machine of that person", async () => {
    const { server, deps, init } = await adminSetup();
    const machines = [laptop(), laptop()];
    // The second machine joins with an invite for the person, as a team-wide one is refused.
    const forPerson = parse(
      (
        await run(
          ["team", "invite", "--server", SERVER, "--team", "platform", "--email", PERSON, "--json"],
          deps,
        )
      ).out,
    );
    for (const [machine, invite] of [
      [machines[0], init.invite],
      [machines[1], forPerson.invite],
    ] as const) {
      const joined = await run(["join", SERVER, invite, "--person", PERSON], {
        configPath: machine?.configPath,
        fetch: server.fetch,
      });
      expect(joined.code).toBe(0);
    }
    const revoked = await run(
      ["team", "revoke", PERSON, "--server", SERVER, "--team", "platform", "--json"],
      deps,
    );
    expect(parse(revoked.out)).toEqual({
      schema: "selfhost.team_revoke/v1",
      server: SERVER,
      team: "platform",
      invite: null,
      person: PERSON,
      revoked: 3,
    });
    for (const machine of machines) {
      const sync = parse(
        (
          await run(importArgs(machine.dataDir), {
            configPath: machine.configPath,
            fetch: server.fetch,
          })
        ).out,
      );
      expect(sync.sync.error).toMatch(/401/);
    }
    const unknown = await run(
      ["team", "revoke", "nobody@example.com", "--server", SERVER, "--team", "platform", "--json"],
      deps,
    );
    expect(parse(unknown.out).error).toMatch(/404/);
  });
});

describe("team leave", () => {
  it("leaves this machine when the server is unreachable, and says the token still works", async () => {
    const server = await teamServer();
    const { configPath, home } = laptop();
    const admin = {
      configPath: laptop().configPath,
      fetch: server.fetch,
      env: { SELFHOST_TOKEN: ADMIN },
    };
    const { invite } = parse(
      (await run(["team", "init", "--server", SERVER, "--json"], admin)).out,
    );
    await run(["join", SERVER, invite, "--person", PERSON], { configPath, fetch: server.fetch });
    const { token } = JSON.parse(readFileSync(configPath, "utf8"));
    home.write(".selfhost/team-policy.toml", "version = 1\n");

    const offline = async () => {
      throw new TypeError("fetch failed");
    };
    const json = parse(
      (await run(["team", "leave", "--json"], { configPath, fetch: offline })).out,
    );
    expect(json).toMatchObject({
      mode: "solo",
      left: { server: SERVER, team: "default", person: PERSON },
      token_revoked: false,
      error: expect.stringMatching(/Could not reach http:\/\/team\.test: fetch failed/),
    });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({});
    expect(existsSync(home.path(".selfhost", "team-policy.toml"))).toBe(false);
    const me = await server.fetch(`${SERVER}/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);

    // The same in text, for a second machine.
    const other = laptop();
    const forPerson = parse(
      (
        await run(
          ["team", "invite", "--server", SERVER, "--team", "default", "--email", PERSON, "--json"],
          admin,
        )
      ).out,
    );
    await run(["join", SERVER, forPerson.invite, "--person", PERSON], {
      configPath: other.configPath,
      fetch: server.fetch,
    });
    const text = await run(["team", "leave"], { configPath: other.configPath, fetch: offline });
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/Left team default on this machine only/);
    expect(text.out).toMatch(/selfhost team revoke dev@example.com/);
  });

  it("counts a token the server already revoked as revoked", async () => {
    const server = await teamServer();
    const { configPath } = laptop();
    const admin = {
      configPath: laptop().configPath,
      fetch: server.fetch,
      env: { SELFHOST_TOKEN: ADMIN },
    };
    const { invite } = parse(
      (await run(["team", "init", "--server", SERVER, "--json"], admin)).out,
    );
    await run(["join", SERVER, invite, "--person", PERSON], { configPath, fetch: server.fetch });
    await run(["team", "revoke", PERSON, "--server", SERVER, "--team", "default"], admin);
    const left = parse(
      (await run(["team", "leave", "--json"], { configPath, fetch: server.fetch })).out,
    );
    expect(left).toMatchObject({ token_revoked: true });
    expect(left).not.toHaveProperty("error");
  });
});

describe("team policy in rule evaluation", () => {
  const TEAM_POLICY = `version = 1

[[rules]]
id = "team-no-force-push"
match = { tool = "Bash", command = "git\\\\s+push\\\\s+.*--force" }
action = "block"
mode = "enforce"
message = "Force pushes are blocked by the team."
`;
  const REPO_POLICY = `version = 1

[[rules]]
id = "repo-no-rm"
match = { tool = "Bash", command = "rm\\\\s+-rf" }
action = "block"
message = "No rm -rf in this repository."
`;

  /** A machine that joined a team and pulled its policy, in a repository with no selfhost.toml. */
  function joinedMachine() {
    const { home, configPath } = laptop();
    home.write(
      ".selfhost/config.json",
      JSON.stringify({ server: SERVER, token: "selfhost_pt_x", person: PERSON, team: "platform" }),
    );
    home.write(".selfhost/team-policy.toml", TEAM_POLICY);
    const repo = tempDir("team-policy-repo");
    mkdirSync(repo.path(".git"));
    return { home, configPath, repo, deps: { configPath, cwd: repo.root } };
  }

  const forcePush = [
    "policy",
    "test",
    "--tool",
    "Bash",
    "--command",
    "git push origin main --force",
    "--json",
  ];

  it("is used when the repository has no selfhost.toml", async () => {
    const { home, deps } = joinedMachine();
    const teamFile = home.path(".selfhost", "team-policy.toml");
    const teamPolicy = { path: teamFile, team: "platform", server: SERVER };

    const doctor = await run(["doctor", "--json"], deps);
    expect(doctor.code).toBe(0);
    expect(parse(doctor.out).config).toMatchObject({
      path: teamFile,
      from: "team",
      valid: true,
      rules: 1,
      team_policy: teamPolicy,
    });
    expect((await run(["doctor"], deps)).out).toMatch(
      /team platform from http:\/\/team\.test, no selfhost\.toml here/,
    );

    const check = await run(["policy", "check", "--json"], deps);
    expect(parse(check.out)).toMatchObject({
      path: teamFile,
      from: "team",
      team_policy: teamPolicy,
      valid: true,
    });
    expect((await run(["policy", "check"], deps)).out).toMatch(
      /^Using the policy of team platform pulled from http:\/\/team\.test: there is no selfhost\.toml in this repository\./,
    );

    const hits = parse((await run(forcePush, deps)).out);
    expect(hits).toMatchObject({
      config: teamFile,
      hits: [
        { rule_id: "team-no-force-push", mode: "enforce", verdict: "block" },
        { rule_id: "guard.force_push", mode: "enforce", verdict: "block" },
      ],
    });
  });

  it("is read by policy report, and policy promote refuses to edit it", async () => {
    const { home, deps } = joinedMachine();
    const teamFile = home.path(".selfhost", "team-policy.toml");

    const report = await run(["policy", "report", "--json", "--data-dir", "memory://"], deps);
    expect(report.code).toBe(0);
    expect(parse(report.out).brief).toContain(
      `Likely false positives are checked against the rules in \`${teamFile}\`.`,
    );

    const promote = await run(
      ["policy", "promote", "team-no-force-push", "--to", "off", "--json"],
      deps,
    );
    expect(promote.code).toBe(1);
    expect(parse(promote.out).error).toMatch(
      /is the policy of team platform, pulled from http:\/\/team\.test, and the next sync replaces it\. Change the team policy where it is kept: in the team's repository, or on the server/,
    );
    expect(readFileSync(teamFile, "utf8")).toBe(TEAM_POLICY);
  });

  it("is the floor the repository's selfhost.toml adds to, and doctor and policy check say so", async () => {
    const { home, repo, deps } = joinedMachine();
    // A starter-like file restating the team's rule in observe mode cannot switch it off.
    repo.write(
      "selfhost.toml",
      `${REPO_POLICY}
[[rules]]
id = "team-no-force-push"
match = { tool = "Bash", command = "git\\\\s+push\\\\s+.*--force" }
action = "block"
mode = "observe"
message = "Only watching force pushes here."
`,
    );
    const repoFile = repo.path("selfhost.toml");
    const teamFile = home.path(".selfhost", "team-policy.toml");

    const doctor = await run(["doctor", "--json"], deps);
    expect(parse(doctor.out).config).toMatchObject({
      path: repoFile,
      from: "search",
      rules: 2,
      team_policy: { path: teamFile },
    });
    expect((await run(["doctor"], deps)).out).toMatch(
      /team\s+adds to \S+team-policy\.toml from http:\/\/team\.test; the team's rules are the floor/,
    );

    const check = await run(["policy", "check"], deps);
    expect(check.out).toMatch(
      /^Using selfhost\.toml on top of the policy of team platform pulled from http:\/\/team\.test \(\S+team-policy\.toml\): the team's rules are the floor, and selfhost\.toml adds to them\./,
    );
    // The team's rule still blocks, in enforce mode, and the repository's own rule is there too.
    expect(parse((await run(forcePush, deps)).out)).toMatchObject({
      config: repoFile,
      hits: [
        { rule_id: "team-no-force-push", mode: "enforce", verdict: "block" },
        { rule_id: "guard.force_push" },
      ],
    });
    const rm = ["policy", "test", "--tool", "Bash", "--command", "rm -rf build", "--json"];
    expect(parse((await run(rm, deps)).out).hits).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule_id: "repo-no-rm" })]),
    );
    const promote = await run(["policy", "promote", "repo-no-rm", "--json"], deps);
    expect(parse(promote.out)).toMatchObject({ config: repoFile, changed: true, to: "enforce" });
    expect(readFileSync(teamFile, "utf8")).toBe(TEAM_POLICY);
  });

  it("is not used outside a team", async () => {
    const { home, deps } = joinedMachine();
    home.write(".selfhost/config.json", "{}");
    const doctor = parse((await run(["doctor", "--json"], deps)).out);
    expect(doctor.config).toBeNull();
    expect(parse((await run(forcePush, deps)).out).error).toMatch(/No selfhost.toml found/);
  });
});

describe("RemoteWriter", () => {
  const event = (n: number, actor: Actor = { kind: "person", id: "laptop-user" }): LedgerEvent => ({
    id: `01930c4e-2f1a-7b2c-8d3e-${n.toString(16).padStart(12, "0")}`,
    schema: "selfhost.event/v1",
    ts: "2026-11-07T09:30:00.000Z",
    source: "local_log",
    kind: "session.started",
    actor,
  });

  function scripted(answers: (Response | Error)[]) {
    const bodies: { events: LedgerEvent[] }[] = [];
    const fetch = async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const next = answers.shift() ?? Response.json({ accepted: 1, duplicates: 0 });
      if (next instanceof Error) throw next;
      return next;
    };
    return { client: new TeamClient(SERVER, "t", fetch), bodies };
  }

  it("sends batches of up to 1000 and maps person actors to the joined person", async () => {
    const { client, bodies } = scripted([
      Response.json({ accepted: 1000, duplicates: 0 }),
      Response.json({ accepted: 990, duplicates: 10 }),
      Response.json({ accepted: 500, duplicates: 0 }),
    ]);
    const writer = new RemoteWriter(client, { person: PERSON });
    const agent = { kind: "agent" as const, id: "codex:session:a" };
    const events = Array.from({ length: 2500 }, (_, i) =>
      event(i + 1, i === 0 ? agent : undefined),
    );
    const result = await writer.append(events);
    expect(bodies.map((b) => b.events.length)).toEqual([1000, 1000, 500]);
    expect(bodies[0]?.events[0]?.actor).toEqual(agent);
    expect(bodies[0]?.events[1]?.actor).toEqual({ kind: "person", id: PERSON });
    expect(result.accepted).toHaveLength(2490);
    expect(result.duplicates).toHaveLength(10);
    expect(writer.totals).toEqual({ sent: 2500, accepted: 2490, duplicates: 10 });
    // The caller's events are not changed.
    expect(events[1]?.actor.id).toBe("laptop-user");
  });

  it("retries an unreachable, rate limited or failing server with backoff", async () => {
    const { client, bodies } = scripted([
      new TypeError("fetch failed"),
      new Response("", { status: 429, headers: { "retry-after": "3" } }),
      new Response("", { status: 502 }),
      Response.json({ accepted: 1, duplicates: 0 }),
    ]);
    const sleep = vi.fn(async (_ms: number) => {});
    const writer = new RemoteWriter(client, { person: PERSON, sleep });
    await writer.append([event(1)]);
    expect(bodies).toHaveLength(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 3000, 2000]);
  });

  it("does not retry a refused batch", async () => {
    const refused = Response.json(
      { error: { code: "invalid_events", message: "1 problem(s) found" }, errors: [] },
      { status: 400 },
    );
    const { client, bodies } = scripted([refused]);
    const sleep = vi.fn(async (_ms: number) => {});
    const error = await new RemoteWriter(client, { person: PERSON, sleep })
      .append([event(1)])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamApiError);
    expect(error).toMatchObject({ status: 400, code: "invalid_events" });
    expect(bodies).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("syncingWriter", () => {
  it("writes locally first, then sends, and throws a failed send for the watcher to retry", async () => {
    const order: string[] = [];
    const local = {
      append: async (events: LedgerEvent[]) => {
        order.push("local");
        return { accepted: events.map((e) => e.id), duplicates: [] };
      },
    };
    let fail = true;
    const remote = {
      append: async () => {
        order.push("remote");
        if (fail) throw new Error("down");
        return { accepted: [], duplicates: [] };
      },
    };
    const catchUp = vi.fn(async () => {
      order.push("catch-up");
    });
    const writer = syncingWriter(local, remote, catchUp);
    await writer.append([]);
    await expect(writer.append([])).rejects.toThrow("down");
    fail = false;
    await writer.append([]);
    expect(order).toEqual(["local", "catch-up", "local", "remote", "local", "remote"]);
    expect(catchUp).toHaveBeenCalledOnce();
  });
});

describe("selfhost team policy", () => {
  it("pushes a selfhost.toml as an owner, shows and pulls it, and refuses a member", async () => {
    const server = await teamServer();
    const owner = laptop();
    const member = laptop();
    const repo = tempDir("team-policy-repo");
    repo.write(".git/HEAD", "ref: refs/heads/main\n");
    const text = 'version = 1\n[guardrails]\nmode = "enforce"\n';
    repo.write("selfhost.toml", text);
    const admin = {
      configPath: owner.configPath,
      fetch: server.fetch,
      env: { SELFHOST_TOKEN: ADMIN },
    };
    const { invite } = parse(
      (await run(["team", "init", "--server", SERVER, "--json"], admin)).out,
    );
    const asOwner = { configPath: owner.configPath, fetch: server.fetch, cwd: repo.root };
    const asMember = { configPath: member.configPath, fetch: server.fetch, cwd: repo.root };
    await run(["join", SERVER, invite, "--person", PERSON], asOwner);
    await run(["join", SERVER, invite, "--person", "bob@example.com"], asMember);

    const status = await run(["status"], asOwner);
    expect(status.out).toContain("selfhost team policy push selfhost.toml");
    const none = await run(["team", "policy", "show"], asOwner);
    expect(none.code).toBe(1);
    expect(none.err).toContain("has no policy");

    const pushed = await run(["team", "policy", "push", "--json"], asOwner);
    expect(pushed.code).toBe(0);
    expect(parse(pushed.out)).toMatchObject({
      schema: "selfhost.team_policy/v1",
      team: "default",
      file: repo.path("selfhost.toml"),
      text,
    });
    const shown = await run(["team", "policy", "show"], asMember);
    expect(shown.out).toBe(text.trimEnd());
    const pulled = await run(["team", "policy", "pull", "team.toml"], asMember);
    expect(pulled.code).toBe(0);
    expect(readFileSync(repo.path("team.toml"), "utf8")).toBe(text);
    expect((await run(["team", "policy", "pull", "team.toml"], asMember)).err).toContain("--force");

    const refused = await run(["team", "policy", "push"], asMember);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/owner or admin role in team default; you are a member/);
    repo.write("bad.toml", 'version = 1\n[guardrails]\nmode = "loud"\n');
    const invalid = await run(["team", "policy", "push", "bad.toml"], asOwner);
    expect(invalid.err).toMatch(/bad\.toml is not valid, so nothing was sent/);
    const agent = await run(["team", "policy", "push"], { ...asOwner, env: { CLAUDECODE: "1" } });
    expect(agent.err).toContain("inside a coding agent session");
  });
});
