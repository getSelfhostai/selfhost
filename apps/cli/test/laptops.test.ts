import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import type { EventsPage, TeamLaptopsResponse } from "@selfhost/schema";
import { createApp } from "@selfhost/server/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMembership } from "../src/team/config.js";
import { type PullReport, startTeamPull, teamSync } from "../src/team/sync.js";
import { blockNetwork } from "./network.js";
import { run, tempDir } from "./run.js";

// Laptop rollout without device management: join and sync install the team policy's managed
// settings under a temporary system root, and report heartbeats the coverage report reads.

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const POLICY = readFileSync(join(fixtures, "compile", "selfhost.toml"), "utf8");
const SERVER = "http://team.test";
const ADMIN = "admin-token";
const DAY = 86_400_000;

const ledgers: Ledger[] = [];

beforeEach(() => {
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(fixtures, "claude-code"));
  vi.stubEnv("CODEX_HOME", join(fixtures, "codex"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const ledger of ledgers.splice(0)) await ledger.close();
});

async function teamServer() {
  const ledger = await openLedger({ dataDir: "memory://" });
  ledgers.push(ledger);
  let clock = Date.now();
  const app = createApp({ version: "test", ledger, token: ADMIN, now: () => new Date(clock) });
  const fetch = async (url: string, init: RequestInit) => app.request(url, init);
  const admin = async (path: string, init: RequestInit = {}) =>
    app.request(`${SERVER}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    });
  return {
    fetch,
    admin,
    later: (days: number) => {
      clock += days * DAY;
    },
    async setPolicy(text: string) {
      const res = await admin("/v1/policy?team=platform", {
        method: "PUT",
        body: JSON.stringify({ text }),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { hash: string }).hash;
    },
    async heartbeats() {
      const res = await admin("/v1/events?kind=config.reported&limit=1000");
      return ((await res.json()) as EventsPage).events;
    },
  };
}

type Server = Awaited<ReturnType<typeof teamServer>>;

/** A laptop with Claude Code and Codex set up in its home folder, and neither Cursor nor Copilot. */
function laptop(server: Server, name: string) {
  const home = tempDir(`laptop-${name}`);
  const root = tempDir(`system-${name}`);
  mkdirSync(home.path(".claude"), { recursive: true });
  mkdirSync(home.path(".codex"), { recursive: true });
  return {
    home,
    root,
    deps: {
      home: home.root,
      configPath: home.path(".selfhost", "config.json"),
      fetch: server.fetch,
      systemRoot: root.root,
      hostname: name,
      platform: "linux" as const,
    },
  };
}

const parse = (out: string) => JSON.parse(out);

async function invite(server: Server, email?: string): Promise<string> {
  const res = await server.admin("/v1/teams/platform/invites", {
    method: "POST",
    body: JSON.stringify(email ? { email } : {}),
  });
  return ((await res.json()) as { invite: string }).invite;
}

async function laptops(deps: object, ...flags: string[]): Promise<TeamLaptopsResponse> {
  const result = await run(["team", "laptops", "--json", ...flags], deps);
  expect(result.code).toBe(0);
  return parse(result.out);
}

describe("laptop rollout through selfhost join", () => {
  it("installs the team's managed settings on join and sync, and reports coverage", async () => {
    const attempts = blockNetwork();
    const server = await teamServer();
    const created = parse(
      (
        await run(["team", "init", "--server", SERVER, "--name", "Platform", "--json"], {
          env: { SELFHOST_TOKEN: ADMIN },
          fetch: server.fetch,
        })
      ).out,
    );
    const hash = await server.setPolicy(POLICY);

    // Ada's laptop joins and gets every Linux file at its system path.
    const ada = laptop(server, "ada-laptop");
    const joined = await run(
      ["join", SERVER, created.invite, "--person", "ada@example.com", "--json"],
      ada.deps,
    );
    expect(joined.code).toBe(0);
    const report = parse(joined.out);
    expect(report.policy_hash).toBe(hash);
    expect(report.laptop.managed.state).toBe("current");
    expect(report.laptop.heartbeat.sent).toBe(true);
    const settings = ada.root.path("etc", "claude-code", "managed-settings.d", "selfhost.json");
    expect(JSON.parse(readFileSync(settings, "utf8")).permissions.deny).toContain(
      "Bash(git push --force *)",
    );
    expect(existsSync(ada.root.path("etc", "codex", "requirements.toml"))).toBe(true);
    // Cursor and Copilot are not on this laptop, so their files are left out.
    expect(report.laptop.managed.not_here).toEqual(["cursor", "copilot"]);
    expect(existsSync(ada.root.path("etc", "cursor"))).toBe(false);

    let coverage = await laptops(ada.deps);
    expect(coverage).toMatchObject({
      team: "platform",
      policy_hash: hash,
      silent_days: 7,
      people_without_heartbeat: [],
    });
    expect(coverage.laptops).toEqual([
      {
        machine: report.laptop.heartbeat.machine,
        person: "ada@example.com",
        hostname: "ada-laptop",
        platform: "linux",
        selfhost_version: expect.any(String),
        policy_hash: hash,
        managed: { state: "current", files: 3, pending: 0 },
        last_heartbeat: expect.any(String),
        flags: [],
        status: "current",
      },
    ]);

    // Bob joins with --no-managed: nothing is written, and the report says so.
    const bob = laptop(server, "bob-laptop");
    const bobJoined = await run(
      ["join", SERVER, await invite(server), "--person", "bob@example.com", "--no-managed"],
      bob.deps,
    );
    expect(bobJoined.code).toBe(0);
    expect(bobJoined.out).toContain("Managed settings install is off here: 3 of 3 files differ");
    expect(existsSync(bob.root.path("etc"))).toBe(false);

    // Cy joins from somewhere without the CLI, so no laptop of hers ever reports.
    const cy = await server.fetch(`${SERVER}/v1/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: await invite(server), person: "cy@example.com" }),
    });
    expect(cy.status).toBe(200);

    // The team policy changes: Ada's laptop is behind until it syncs.
    const changed = POLICY.replace(
      'id = "no-rm-rf"\nmode = "enforce"',
      'id = "no-rm-rf"\nmode = "off"',
    );
    expect(changed).not.toBe(POLICY);
    const newHash = await server.setPolicy(changed);
    coverage = await laptops(ada.deps);
    expect(coverage.policy_hash).toBe(newHash);
    expect(coverage.laptops.map((row) => [row.hostname, row.status, row.flags])).toEqual([
      ["ada-laptop", "behind", ["behind"]],
      ["bob-laptop", "behind", ["behind", "not_installed"]],
    ]);
    expect(coverage.people_without_heartbeat).toEqual(["cy@example.com"]);

    const sync = parse(
      (
        await run(
          ["import", "--json", "--data-dir", "memory://", "--person", "ada@example.com"],
          ada.deps,
        )
      ).out,
    );
    expect(sync.sync.policy_hash).toBe(newHash);
    expect(sync.sync.laptop.heartbeat.sent).toBe(true);
    const claude = sync.sync.laptop.managed.files.find(
      (file: { vendor: string }) => file.vendor === "claude_code",
    );
    expect(claude.status).toBe("written");
    expect(readFileSync(settings, "utf8")).not.toContain("rm -rf");
    coverage = await laptops(ada.deps);
    expect(coverage.laptops.find((row) => row.hostname === "ada-laptop")?.status).toBe("current");

    // A sync that changes nothing sends no new heartbeat within the hour.
    const before = (await server.heartbeats()).length;
    const quiet = parse(
      (
        await run(
          ["import", "--json", "--data-dir", "memory://", "--person", "ada@example.com"],
          ada.deps,
        )
      ).out,
    );
    expect(quiet.sync.laptop.heartbeat.sent).toBe(false);
    expect(await server.heartbeats()).toHaveLength(before);

    // Ten days on, both laptops are silent; a shorter window can be asked for too.
    server.later(10);
    coverage = await laptops(ada.deps);
    expect(coverage.laptops.map((row) => row.status)).toEqual(["silent", "silent"]);
    const wider = await laptops(ada.deps, "--silent-days", "30");
    expect(wider.laptops.map((row) => [row.hostname, row.status])).toEqual([
      ["bob-laptop", "behind"],
      ["ada-laptop", "current"],
    ]);

    const text = await run(["team", "laptops"], ada.deps);
    expect(text.out).toMatch(/^Team platform on http:\/\/team\.test: 2 laptops, 2 flagged\./);
    expect(text.out).toMatch(
      /silent\s+ada@example\.com\s+ada-laptop\s+linux\s+[0-9a-f]{12}\s+installed/,
    );
    expect(text.out).toContain("No heartbeat from: cy@example.com.");
    expect(attempts).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "prints the exact sudo command when join may not write a system path, and runs none",
    async () => {
      const server = await teamServer();
      const { invite: code } = parse(
        (
          await run(["team", "init", "--server", SERVER, "--name", "Platform", "--json"], {
            env: { SELFHOST_TOKEN: ADMIN },
            fetch: server.fetch,
          })
        ).out,
      );
      await server.setPolicy(POLICY);
      const ada = laptop(server, "locked");
      mkdirSync(ada.root.path("etc"), { recursive: true });
      chmodSync(ada.root.path("etc"), 0o555);
      try {
        const joined = await run(["join", SERVER, code, "--person", "ada@example.com"], ada.deps);
        expect(joined.code).toBe(0);
        const staged = ada.home.path(".selfhost", "managed", "codex", "requirements.toml");
        // Only for the agents on this laptop: no sudo line for Cursor's or Copilot's files.
        expect(joined.out).toContain(
          "3 files need an admin. Run (selfhost never runs sudo itself):",
        );
        expect(joined.out).toContain(
          "Left out the managed settings of Cursor, Copilot: not on this laptop. A later sync installs them once one is.",
        );
        expect(joined.out).not.toMatch(/sudo .*(cursor|github-copilot)/);
        expect(joined.out).toContain(
          `  sudo mkdir -p '${ada.root.path("etc", "codex")}' && sudo install -o root -m 0644 '${staged}' '${ada.root.path("etc", "codex", "requirements.toml")}'`,
        );
        expect(readFileSync(staged, "utf8")).toContain("prefix_rules");
        expect(existsSync(ada.root.path("etc", "codex"))).toBe(false);

        const coverage = await laptops(ada.deps);
        expect(coverage.laptops[0]).toMatchObject({
          status: "not_installed",
          managed: { state: "pending", files: 3, pending: 3 },
        });
      } finally {
        chmodSync(ada.root.path("etc"), 0o755);
      }
    },
  );

  it("keeps a watching laptop on the team's policy: pulls it, installs it, sends a heartbeat", async () => {
    const attempts = blockNetwork();
    const server = await teamServer();
    const { invite: code } = parse(
      (
        await run(["team", "init", "--server", SERVER, "--name", "Platform", "--json"], {
          env: { SELFHOST_TOKEN: ADMIN },
          fetch: server.fetch,
        })
      ).out,
    );
    await server.setPolicy(POLICY);
    const bob = laptop(server, "bob-laptop");
    expect((await run(["join", SERVER, code, "--person", "bob@example.com"], bob.deps)).code).toBe(
      0,
    );
    const membership = readMembership(bob.deps.configPath);
    if (!membership) throw new Error("bob did not join");
    const sync = teamSync(
      membership,
      bob.deps.configPath,
      server.fetch,
      {},
      { platform: "linux", systemRoot: bob.root.root, hostname: "bob-laptop", version: "test" },
    );
    const reports: PullReport[] = [];
    const errors: string[] = [];
    const puller = startTeamPull(sync, {
      intervalMs: 10,
      onReport: (report) => reports.push(report),
      onError: (message) => errors.push(message),
    });
    try {
      // Alice pushes a new policy while Bob's watcher runs: no batch of events has to land.
      const changed = POLICY.replace(
        'id = "no-rm-rf"\nmode = "enforce"',
        'id = "no-rm-rf"\nmode = "off"',
      );
      const newHash = await server.setPolicy(changed);
      await vi.waitFor(() => expect(reports.some((r) => r.policy_hash === newHash)).toBe(true));
      const pulled = reports.find((r) => r.policy_hash === newHash);
      expect(pulled?.policy_changed).toBe(true);
      expect(pulled?.laptop?.heartbeat.sent).toBe(true);
      const claude = pulled?.laptop?.managed?.files.find((file) => file.vendor === "claude_code");
      expect(claude?.status).toBe("written");
      const settings = bob.root.path("etc", "claude-code", "managed-settings.d", "selfhost.json");
      expect(readFileSync(settings, "utf8")).not.toContain("rm -rf");
      const coverage = await laptops(bob.deps);
      expect(coverage.laptops.map((row) => [row.hostname, row.status])).toEqual([
        ["bob-laptop", "current"],
      ]);

      // Later pulls with nothing new send no heartbeat within the hour and change no file.
      const count = reports.length;
      const beats = (await server.heartbeats()).length;
      await vi.waitFor(() => expect(reports.length).toBeGreaterThan(count + 1));
      expect(reports.slice(count).every((r) => !r.policy_changed)).toBe(true);
      expect(reports.slice(count).every((r) => r.laptop?.heartbeat.sent === false)).toBe(true);
      expect(await server.heartbeats()).toHaveLength(beats);
      expect(errors).toEqual([]);
    } finally {
      await puller.close();
    }
    expect(attempts).toEqual([]);
  });
});
