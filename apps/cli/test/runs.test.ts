import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "@selfhost/ledger";
import { BACKGROUND_RUN_SCHEMA, type BackgroundRun, type LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { drainSpool } from "../src/hooks/drain.js";
import { appendToSpool, spoolDir } from "../src/hooks/receive.js";
import { run, tempDir } from "./run.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const payload = (agent: "claude-code" | "codex", name: string) =>
  readFileSync(join(fixtures, "hooks", agent, `${name}.json`), "utf8");

const SERVER = "https://selfhost.example.com";

function joined() {
  const config = tempDir("runs-config");
  const path = config.path("config.json");
  writeFileSync(
    path,
    JSON.stringify({
      server: SERVER,
      token: "person-token",
      person: "lead@example.com",
      team: "web",
    }),
  );
  return path;
}

const record = (extra: Partial<BackgroundRun> = {}): BackgroundRun => ({
  schema: BACKGROUND_RUN_SCHEMA,
  id: "019a6b2c-0000-7000-8000-00000000abcd",
  team: "web",
  repo: "acme/web",
  task: "Fix the login bug",
  agent: "claude",
  runtime: "e2b",
  state: "queued",
  reason: null,
  person: "lead@example.com",
  trigger: { source: "cli", sender: "lead@example.com", person: "lead@example.com" },
  credential: null,
  base: null,
  branch: "claude/selfhost-fix-the-login-bug-0000abcd",
  sandbox_id: null,
  attempt: 1,
  max_attempts: 2,
  timeout_minutes: 60,
  pr_url: null,
  created_at: "2026-11-09T10:00:00.000Z",
  started_at: null,
  ended_at: null,
  updated_at: "2026-11-09T10:00:00.000Z",
  cancel: null,
  cost: { runtime_usd: 0, model_usd: 0, usd: 0, source: "list_price" },
  health: null,
  gate: null,
  ...extra,
});

function server(states: Partial<BackgroundRun>[]) {
  const requests: { method: string; url: string; body?: unknown }[] = [];
  let polls = 0;
  const fetch = async (url: string, init: RequestInit) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method: init.method ?? "GET", url, ...(body ? { body } : {}) });
    const path = new URL(url).pathname;
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (init.method === "POST" && path === "/v1/background-runs") return json(202, record());
    if (init.method === "GET" && path.startsWith("/v1/background-runs/")) {
      return json(200, record(states[Math.min(polls++, states.length - 1)]));
    }
    if (init.method === "GET" && path === "/v1/background-runs") {
      return json(200, {
        runs: [
          record({
            state: "running",
            health: {
              status: "quiet",
              line: "quiet for 3m",
              heartbeat_at: null,
              last_output_at: null,
            },
          }),
        ],
        kills: [
          { scope: "org", target: "acme", by: "owner@example.com", at: "2026-11-09T09:00:00.000Z" },
        ],
      });
    }
    if (path.endsWith("/cancel"))
      return json(
        200,
        record({
          state: "cancelled",
          cancel: { by: "lead@example.com", at: "2026-11-09T10:01:00.000Z", scope: "run" },
        }),
      );
    if (path === "/v1/background-runs/kill") {
      return json(200, {
        scope: "team",
        target: "web",
        active: init.method === "POST",
        stopped: init.method === "POST" ? ["r1", "r2"] : [],
      });
    }
    return json(404, { error: { code: "not_found", message: "no" } });
  };
  return { fetch, requests };
}

describe("selfhost run", () => {
  it("needs --repo outside a checkout with a GitHub origin", async () => {
    const api = server([]);
    const result = await run(["run", "Fix", "the", "login", "bug"], {
      configPath: joined(),
      fetch: api.fetch,
      cwd: tempDir("not-a-repo").root,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("--repo: not in a git repository with a GitHub origin");
    expect(api.requests).toEqual([]);
  });

  it("starts a run with --repo and prints how to follow it", async () => {
    const api = server([{ state: "succeeded", pr_url: "https://github.com/acme/web/pull/7" }]);
    const result = await run(
      [
        "run",
        "Fix the login bug",
        "--repo",
        "acme/web",
        "--agent",
        "codex",
        "--timeout",
        "30",
        "--wait",
      ],
      { configPath: joined(), fetch: api.fetch, sleep: async () => {} },
    );
    expect(result.code).toBe(0);
    expect(api.requests[0]).toEqual({
      method: "POST",
      url: `${SERVER}/v1/background-runs`,
      body: {
        task: "Fix the login bug",
        repo: "acme/web",
        source: "cli",
        agent: "codex",
        timeout_minutes: 30,
      },
    });
    expect(result.out).toContain("selfhost tail --run 019a6b2c-0000-7000-8000-00000000abcd");
    expect(result.out).toContain("pull request: https://github.com/acme/web/pull/7");
  });

  it("exits 1 when the run does not succeed, and checks its flags", async () => {
    const api = server([{ state: "failed", reason: "claude exited 2" }]);
    const failed = await run(["run", "x", "--repo", "acme/web", "--wait"], {
      configPath: joined(),
      fetch: api.fetch,
      sleep: async () => {},
    });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain(
      "Run 019a6b2c-0000-7000-8000-00000000abcd: failed (claude exited 2)",
    );
    const badAgent = await run(["run", "x", "--repo", "acme/web", "--agent", "cursor"], {
      configPath: joined(),
      fetch: api.fetch,
    });
    expect(badAgent.err).toContain("--agent: expected one of claude, codex, opencode, goose");
    const solo = await run(["run", "x", "--repo", "acme/web"], { fetch: api.fetch });
    expect(solo.err).toContain("Join a team first: selfhost join <server> <invite>");
    expect(solo.err).not.toContain("team join");
  });
});

describe("selfhost runs", () => {
  it("lists runs with their health and the kill switches in force", async () => {
    const api = server([]);
    const result = await run(["runs"], { configPath: joined(), fetch: api.fetch });
    expect(result.out).toContain("Kill switch on for org acme, by owner@example.com");
    expect(result.out).toMatch(
      /019a6b2c-0000-7000-8000-00000000abcd\s+running\s+claude\s+acme\/web/,
    );
    expect(result.out).toContain("quiet for 3m");
  });

  it("shows, cancels and kills", async () => {
    const api = server([
      {
        state: "running",
        health: { status: "quiet", line: "quiet for 3m", heartbeat_at: null, last_output_at: null },
      },
    ]);
    const shown = await run(["runs", "show", "r1"], { configPath: joined(), fetch: api.fetch });
    expect(shown.out).toContain("health: quiet, quiet for 3m");
    const cancelled = await run(["runs", "cancel", "r1"], {
      configPath: joined(),
      fetch: api.fetch,
    });
    expect(cancelled.out).toBe(
      "Run 019a6b2c-0000-7000-8000-00000000abcd: cancelled, stopped by lead@example.com.",
    );
    const killed = await run(["runs", "kill", "--reason", "incident"], {
      configPath: joined(),
      fetch: api.fetch,
    });
    expect(killed.out).toContain("Kill switch on for team web: 2 runs stopped");
    expect(api.requests.at(-1)?.body).toEqual({ scope: "team", target: "web", reason: "incident" });
    const cleared = await run(["runs", "kill", "--org", "acme", "--clear"], {
      configPath: joined(),
      fetch: api.fetch,
    });
    expect(cleared.out).toBe("Kill switch off for org acme: runs may start again.");
    expect(api.requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: `${SERVER}/v1/background-runs/kill?scope=org&target=acme`,
    });
  });
});

describe("selfhost import --hook-events", () => {
  it("prints the same events a laptop's import writes, and keeps the spool", async () => {
    const home = tempDir("hook-events");
    const dir = spoolDir({ HOME: home.root }) ?? "";
    const now = new Date("2026-11-09T10:00:00Z");
    appendToSpool(dir, "claude", payload("claude-code", "PreToolUse"), now, {
      answer: "deny",
      hit: {
        rule_id: "guard.force_push",
        mode: "enforce",
        verdict: "block",
        message: "Force pushes are blocked.",
        irreversible: true,
      },
      hits: [{ rule_id: "guard.force_push", mode: "enforce", verdict: "block" }],
      ms: 3,
    });
    appendToSpool(dir, "codex", payload("codex", "PostModelRequest"), now);

    const printed = await run(["import", "--hook-events"], {
      env: { HOME: home.root, SELFHOST_PERSON: "lead@example.com" },
      now,
    });
    expect(printed.err).toBe("");
    const fromSandbox = printed.out.split("\n").map((line) => JSON.parse(line) as LedgerEvent);
    expect(fromSandbox.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["tool.called", "policy.evaluated", "cost.recorded"]),
    );

    // The laptop path: the same spool drained into a ledger.
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      await drainSpool(ledger, dir, { person: "lead@example.com", now, keep: true });
      const stored = (await ledger.query({ limit: 100 })).events;
      const key = (event: LedgerEvent) =>
        `${event.id} ${event.kind} ${event.decision?.verdict ?? ""}`;
      expect(fromSandbox.map(key).sort()).toEqual(stored.map(key).sort());
    } finally {
      await ledger.close();
    }
  });
});

describe("selfhost tail on a background run", () => {
  it("prints each run event as one line and filters by run", async () => {
    const { formatLine, lineOf, matches } = await import("../src/tail/line.js");
    const base = {
      schema: "selfhost.event/v1" as const,
      ts: "2026-11-09T10:00:00.000Z",
      source: "server" as const,
      actor: { kind: "person" as const, id: "lead@example.com" },
      agent: { vendor: "claude_code" as const },
      run_id: "r1",
    };
    const events: LedgerEvent[] = [
      {
        ...base,
        id: "01930c4e-2f1a-7b2c-8d3e-000000000001",
        kind: "run.updated",
        data: { background_run: { state: "running" } },
      },
      {
        ...base,
        id: "01930c4e-2f1a-7b2c-8d3e-000000000002",
        kind: "run.output",
        data: { output: { lines: ["editing src/login.ts", "running tests"] } },
      },
      {
        ...base,
        id: "01930c4e-2f1a-7b2c-8d3e-000000000003",
        kind: "run.health",
        data: { health: { line: "quiet for 3m" } },
      },
      {
        ...base,
        id: "01930c4e-2f1a-7b2c-8d3e-000000000004",
        kind: "run.updated",
        data: {
          background_run: { state: "stuck", reason: "Run health stopped it: no output for 10m" },
        },
      },
    ];
    const lines = events.map((event) => formatLine(lineOf(event, { console: SERVER })));
    expect(lines).toEqual([
      "10:00:00  lead@example.com  claude_code  updated running",
      "10:00:00  lead@example.com  claude_code  output editing src/login.ts | running tests",
      "10:00:00  lead@example.com  claude_code  health quiet for 3m",
      "10:00:00  lead@example.com  claude_code  updated stuck: Run health stopped it: no output for 10m",
    ]);
    const first = lineOf(events[0] as LedgerEvent, { console: SERVER });
    expect(matches(first, { run: "r1" })).toBe(true);
    expect(matches(first, { run: "r2" })).toBe(false);
  });
});
