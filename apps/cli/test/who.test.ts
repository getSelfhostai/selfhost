import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "@selfhost/ledger";
import {
  EVENT_SCHEMA,
  type LedgerEvent,
  PRESENCE_SCHEMA,
  type PresenceResponse,
} from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { gitBranchAt } from "../src/hooks/branch.js";
import { drainSpool } from "../src/hooks/drain.js";
import { runHook, spoolDir } from "../src/hooks/receive.js";
import { run, tempDir } from "./run.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const payload = (name: string) =>
  JSON.parse(readFileSync(join(fixtures, "hooks", "claude-code", `${name}.json`), "utf8"));

/** A checkout on `branch`: a .git folder, or a worktree's .git file pointing at one. */
function checkout(branch: string, worktree = false) {
  const dir = tempDir("who-repo");
  if (worktree) {
    dir.write("gitdir/worktrees/w/HEAD", `ref: refs/heads/${branch}\n`);
    dir.write("work/.git", `gitdir: ${dir.path("gitdir", "worktrees", "w")}\n`);
    dir.write("work/src/app.ts", "");
    return dir.path("work");
  }
  dir.write(".git/HEAD", `ref: refs/heads/${branch}\n`);
  dir.write("src/app.ts", "");
  return dir.root;
}

describe("the branch a hook sees", () => {
  it("reads .git/HEAD from the folder or a parent, and a worktree's git dir", () => {
    expect(gitBranchAt(join(checkout("main"), "src"))).toBe("main");
    expect(gitBranchAt(checkout("feature/who", true))).toBe("feature/who");
    const detached = tempDir("who-detached");
    detached.write(".git/HEAD", "4f2c1a9e8b7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b\n");
    expect(gitBranchAt(detached.root)).toBeUndefined();
    expect(gitBranchAt(tempDir("who-none").root)).toBeUndefined();
  });
});

describe("hook events of a named agent", () => {
  it("records the agent as the actor and the branch on each event", async () => {
    const home = tempDir("who-home");
    const cwd = checkout("janitor/cleanup");
    const errors: string[] = [];
    const stop = { ...payload("SessionStart"), cwd };
    await runHook(["claude"], {
      env: { HOME: home.root, SELFHOST_AGENT_NAME: "janitor" },
      readStdin: async () => JSON.stringify(stop),
      writeError: (line) => errors.push(line),
      now: new Date("2026-11-12T10:00:00Z"),
    });
    expect(errors).toEqual([]);
    const dir = spoolDir({ HOME: home.root }) ?? "";
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      await drainSpool(ledger, dir, {
        person: "ops@example.com",
        now: new Date("2026-11-12T10:01:00Z"),
      });
      const events = (await ledger.query({})).events;
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.actor).toEqual({ kind: "agent", id: "agent:janitor", name: "janitor" });
        expect(event.data?.branch).toBe("janitor/cleanup");
      }
    } finally {
      await ledger.close();
    }
  });

  it("blocks a tool outside the agent's list in enforce mode", async () => {
    const home = tempDir("who-guard-home");
    const cwd = checkout("main");
    writeFileSync(
      join(cwd, "selfhost.toml"),
      'version = 1\n[agents.janitor]\nowner = "bo@example.com"\ntools = ["Read", "Edit"]\nmode = "enforce"\n',
    );
    const call = { ...payload("PreToolUse"), cwd };
    const answer = async (env: NodeJS.ProcessEnv) => {
      let output = "";
      await runHook(["claude"], {
        env: { HOME: home.root, ...env },
        readStdin: async () => JSON.stringify(call),
        writeOutput: (text) => {
          output += text;
        },
        writeError: () => {},
        now: new Date("2026-11-12T10:00:00Z"),
      });
      return output;
    };
    expect(await answer({ SELFHOST_AGENT_NAME: "janitor" })).toContain("agents.janitor.tools");
    expect(await answer({})).not.toContain("agents.janitor.tools");
  });
});

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  ts: "2026-11-12T10:20:00.000Z",
  source: "hook",
  actor: { kind: "person", id: "ada@example.com" },
  agent: { vendor: "claude_code" },
  repo: "acme/web",
  ...fields,
});

const NOW = new Date("2026-11-12T10:30:00.000Z");

describe("selfhost who", () => {
  it("lists who works where on this laptop's ledger, with the overlap", async () => {
    const data = tempDir("who-data");
    const work = tempDir("who-work");
    work.write("selfhost.toml", 'version = 1\n[agents.janitor]\nowner = "bo@example.com"\n');
    const ledger = await openLedger({ dataDir: data.root });
    const edit = (session: string, extra: Partial<LedgerEvent>) =>
      event({
        kind: "tool.called",
        session_id: session,
        tool: { name: "Edit" },
        target: { type: "file", value: "src/app.ts" },
        ...extra,
      });
    await ledger.append([
      edit("s-ada", { data: { branch: "main" } }),
      edit("s-janitor", {
        ts: "2026-11-12T10:25:00.000Z",
        actor: { kind: "agent", id: "agent:janitor", name: "janitor" },
        agent: { vendor: "codex" },
        data: { branch: "janitor/cleanup" },
      }),
    ]);
    await ledger.close();

    const text = await run(["who", "--data-dir", data.root], { cwd: work.root, now: NOW });
    expect(text.code).toBe(0);
    expect(text.out.split("\n")).toEqual([
      "2 active runs (active in the last 30 minutes)",
      "",
      "acme/web",
      "  janitor/cleanup",
      "    agent janitor with Codex, session s-janitor: started 5m ago, last 5m ago; owner bo@example.com (owns the agent)",
      "      editing src/app.ts",
      "  main",
      "    ada@example.com with Claude Code, session s-ada: started 10m ago, last 10m ago; owner ada@example.com",
      "      editing src/app.ts",
      "",
      "Overlaps: two runs editing the same file",
      "  acme/web src/app.ts: runs s-ada, s-janitor (ada@example.com, bo@example.com), since 5m ago",
    ]);

    const json = await run(["who", "--data-dir", data.root, "--json", "--idle", "7"], {
      cwd: work.root,
      now: NOW,
    });
    const presence = JSON.parse(json.out) as PresenceResponse;
    expect(presence.idle_minutes).toBe(7);
    expect(presence.runs.map((r) => r.id)).toEqual(["s-janitor"]);
    expect(presence.overlaps).toEqual([]);

    const bad = await run(["who", "--data-dir", data.root, "--idle", "0"], { cwd: work.root });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--idle");
  });

  it("asks the team server in a team", async () => {
    const config = tempDir("who-config");
    const configPath = config.path("config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        server: "https://selfhost.example.com",
        token: "person-token",
        person: "lead@example.com",
        team: "web",
      }),
    );
    const asked: string[] = [];
    const answer: PresenceResponse = {
      schema: PRESENCE_SCHEMA,
      at: NOW.toISOString(),
      idle_minutes: 30,
      runs: [],
      overlaps: [],
    };
    const result = await run(["who", "--team", "web", "--repo", "acme/web"], {
      configPath,
      now: NOW,
      fetch: async (url, init) => {
        asked.push(`${init.method} ${url} ${new Headers(init.headers).get("authorization")}`);
        return new Response(JSON.stringify(answer), { status: 200 });
      },
    });
    expect(asked).toEqual([
      "GET https://selfhost.example.com/v1/presence?team=web&repo=acme%2Fweb Bearer person-token",
    ]);
    expect(result.out).toBe("Nobody is working right now (no run active in the last 30 minutes).");
  });
});
