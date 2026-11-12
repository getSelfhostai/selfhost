import { EVENT_SCHEMA, type LedgerEvent, namedAgentActor } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseOf, type Ledger, openLedger, readPresence } from "../src/index.js";

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  ts: "2026-11-12T10:00:00.000Z",
  source: "hook",
  actor: { kind: "person", id: "ada@example.com" },
  agent: { vendor: "claude_code" },
  repo: "acme/web",
  ...fields,
});

const edit = (session: string, file: string, ts: string, fields: Partial<LedgerEvent> = {}) =>
  event({
    kind: "tool.called",
    session_id: session,
    ts,
    tool: { name: "Edit", input_summary: file },
    target: { type: "file", value: file },
    ...fields,
  });

const NOW = new Date("2026-11-12T10:30:00.000Z");

describe("readPresence", () => {
  let ledger: Ledger;
  const read = (options: Partial<Parameters<typeof readPresence>[1]> = {}) =>
    readPresence(databaseOf(ledger), { now: NOW, idleMinutes: 30, teams: null, ...options });

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    await ledger.append([
      // Ada started an hour ago on main and is still editing.
      event({
        kind: "session.started",
        session_id: "s-ada",
        ts: "2026-11-12T09:30:00.000Z",
        data: { branch: "main" },
      }),
      edit("s-ada", "src/app.ts", "2026-11-12T10:10:00.000Z", { data: { branch: "main" } }),
      edit("s-ada", "src/util.ts", "2026-11-12T10:20:00.000Z", { data: { branch: "main" } }),
      // The janitor agent, owned by Bo in selfhost.toml, edits the same file on another branch.
      edit("s-janitor", "src/app.ts", "2026-11-12T10:25:00.000Z", {
        actor: namedAgentActor("janitor"),
        agent: { vendor: "codex" },
        data: { branch: "janitor/cleanup" },
      }),
      // Cy's session ended: not active.
      edit("s-cy", "src/app.ts", "2026-11-12T10:05:00.000Z", {
        actor: { kind: "person", id: "cy@example.com" },
      }),
      event({
        kind: "session.ended",
        session_id: "s-cy",
        ts: "2026-11-12T10:06:00.000Z",
        actor: { kind: "person", id: "cy@example.com" },
      }),
      // Di went quiet 40 minutes ago: idle.
      edit("s-di", "src/app.ts", "2026-11-12T09:50:00.000Z", {
        actor: { kind: "person", id: "di@example.com" },
      }),
      // Another repo.
      edit("s-ed", "README.md", "2026-11-12T10:28:00.000Z", {
        actor: { kind: "person", id: "ed@example.com" },
        repo: "acme/api",
      }),
    ]);
  });

  afterAll(async () => {
    await ledger.close();
  });

  it("lists the active runs by repo and branch, with owners, files and the overlap", async () => {
    const presence = await read({
      configFor: async () => ({ agents: { janitor: { owner: "bo@example.com" } } }),
    });
    expect(presence.runs.map((run) => [run.id, run.repo, run.branch])).toEqual([
      ["s-ed", "acme/api", null],
      ["s-janitor", "acme/web", "janitor/cleanup"],
      ["s-ada", "acme/web", "main"],
    ]);
    const ada = presence.runs.find((run) => run.id === "s-ada");
    expect(ada).toMatchObject({
      person: "ada@example.com",
      owner: "ada@example.com",
      owner_via: "person",
      files: ["src/util.ts", "src/app.ts"],
      edits: 2,
      // Its first event is before the window.
      started_at: "2026-11-12T09:30:00.000Z",
      last_event_at: "2026-11-12T10:20:00.000Z",
    });
    expect(presence.runs.find((run) => run.id === "s-janitor")).toMatchObject({
      actor: { kind: "agent", id: "agent:janitor", name: "janitor" },
      person: null,
      named_agent: "janitor",
      owner: "bo@example.com",
      owner_via: "named_agent",
      agent: { vendor: "codex" },
    });
    expect(presence.overlaps).toEqual([
      {
        repo: "acme/web",
        file: "src/app.ts",
        runs: ["s-ada", "s-janitor"],
        owners: ["ada@example.com", "bo@example.com"],
        since: "2026-11-12T10:25:00.000Z",
      },
    ]);
  });

  it("limits to a repo, and widens with a longer idle window", async () => {
    const api = await read({ repo: "ACME/api" });
    expect(api.runs.map((run) => run.id)).toEqual(["s-ed"]);
    const wide = await read({ idleMinutes: 60 });
    expect(wide.runs.map((run) => run.id)).toContain("s-di");
    expect(wide.runs.map((run) => run.id)).not.toContain("s-cy");
  });

  it("reads only the teams it is given", async () => {
    await ledger.append(
      [
        edit("s-team", "src/app.ts", "2026-11-12T10:29:00.000Z", {
          actor: { kind: "person", id: "fay@example.com" },
        }),
      ],
      { team: "platform" },
    );
    expect((await read({ teams: ["platform"] })).runs.map((run) => run.id)).toEqual(["s-team"]);
    expect((await read({ teams: ["other"] })).runs).toEqual([]);
    expect((await read()).runs.map((run) => run.id)).toContain("s-team");
  });
});
