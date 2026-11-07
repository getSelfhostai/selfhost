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
  /** Every event on the server, read with the admin token. */
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
      return all;
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
    expect(parse(refused.out).error).toMatch(/403.*Unknown or revoked invite code/);
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
    expect(parse((await run(["doctor", "--json"], deps)).out).config.valid).toBe(true);

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
      expect(call).toMatch(/^(GET|POST|PUT) http:\/\/team\.test\/v1\//);
    expect(attempts).toEqual([]);

    // Leaving goes back to solo without touching the ledger, and solo calls nobody.
    const left = parse((await run(["team", "leave", "--json"], deps)).out);
    expect(left.left).toEqual({ server: SERVER, team: "default", person: PERSON });
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
