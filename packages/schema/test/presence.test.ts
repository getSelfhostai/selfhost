import { describe, expect, it } from "vitest";
import {
  derivePresence,
  EVENT_SCHEMA,
  editedFiles,
  type LedgerEvent,
  namedAgentActor,
  namedAgentOf,
  parseConfig,
  presenceIdleMinutes,
  runOwnership,
  validatePresenceResponse,
} from "../src/index.js";

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  ts: "2026-11-12T10:00:00.000Z",
  source: "hook",
  actor: { kind: "person", id: "ada@example.com" },
  ...fields,
});

const NOW = new Date("2026-11-12T10:30:00.000Z");

describe("[agents] and [presence] in selfhost.toml", () => {
  it("accepts a named agent with an owner, paths, a budget, tools and a model", () => {
    const parsed = parseConfig(`version = 1
[presence]
idle_minutes = 15

[agents.janitor]
owner = "bo@example.com"
paths = ["deps/**", "package.json"]
daily_usd = 5
tools = ["Read", "Edit", "Bash"]
model = "claude-sonnet-4"
mode = "enforce"
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.agents?.janitor).toMatchObject({
      owner: "bo@example.com",
      paths: ["deps/**", "package.json"],
      daily_usd: 5,
      mode: "enforce",
    });
    expect(presenceIdleMinutes(parsed.config)).toBe(15);
    expect(presenceIdleMinutes(undefined)).toBe(30);
  });

  it("rejects a named agent with no owner, and a name that is not lowercase", () => {
    const parsed = parseConfig(`version = 1
[agents.janitor]
paths = ["deps/**"]
`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual([
      { field: "agents.janitor.owner", message: "Expected required property", line: 2 },
    ]);
    const named = parseConfig(`version = 1
[agents.Janitor]
owner = "bo@example.com"
`);
    expect(named.ok ? [] : named.errors.map((e) => e.field)).toEqual(["agents.Janitor"]);
  });

  it("gives a schedule an owner", () => {
    const parsed = parseConfig(`version = 1
[[background.schedules]]
name = "nightly"
cron = "0 3 * * *"
repo = "acme/web"
task = "Update dependencies"
owner = "bo@example.com"
`);
    expect(parsed.ok && parsed.config.background?.schedules?.[0]?.owner).toBe("bo@example.com");
  });
});

describe("runOwnership", () => {
  const config = {
    agents: { janitor: { owner: "bo@example.com" } },
    background: { schedules: [{ name: "nightly", owner: "cy@example.com" }] },
    review: { fallback: ["lead@example.com"] },
  };

  it("names the agent as the actor of its events and its owner as the run owner", () => {
    expect(namedAgentOf(namedAgentActor("janitor"))).toBe("janitor");
    expect(namedAgentOf({ kind: "agent", id: "codex:session:1" })).toBeUndefined();
    expect(namedAgentOf({ kind: "person", id: "agent:janitor" })).toBeUndefined();
    const run = [event({ kind: "tool.called", actor: namedAgentActor("janitor") })];
    expect(runOwnership(run, config)).toEqual({
      owner: "bo@example.com",
      via: "named_agent",
      named_agent: "janitor",
    });
  });

  it("goes handoff, person, trigger, schedule, then [review] fallback", () => {
    const handoff = event({
      kind: "run.handed_off",
      ts: "2026-11-12T10:05:00.000Z",
      data: {
        v: 1,
        handoff: "01930c4e-2f1a-7b2c-9d3e-0000000000aa",
        owner: "di@example.com",
        previous_owner: "ada@example.com",
      },
    });
    const work = event({ kind: "tool.called" });
    expect(runOwnership([work, handoff], config)).toMatchObject({
      owner: "di@example.com",
      via: "handoff",
    });
    expect(runOwnership([work], config)).toMatchObject({ owner: "ada@example.com", via: "person" });

    const system = { kind: "system" as const, id: "selfhost-runner" };
    const triggered = (trigger: Record<string, unknown>) =>
      event({ kind: "run.triggered", actor: system, run_id: "run-1", data: { trigger } });
    expect(
      runOwnership(
        [triggered({ source: "github", sender: "eve", person: "eve@example.com" })],
        config,
      ),
    ).toMatchObject({ owner: "eve@example.com", via: "trigger" });
    expect(
      runOwnership([triggered({ source: "schedule", sender: "nightly", person: null })], config),
    ).toMatchObject({ owner: "cy@example.com", via: "schedule" });
    expect(
      runOwnership([event({ kind: "run.updated", actor: system, run_id: "run-2" })], config),
    ).toMatchObject({ owner: "lead@example.com", via: "fallback" });
    expect(runOwnership([event({ kind: "run.updated", actor: system })])).toEqual({
      owner: null,
      via: null,
      named_agent: null,
    });
  });
});

describe("derivePresence", () => {
  it("reads the files of a Codex patch, and ignores reads and rule decisions", () => {
    expect(
      editedFiles(
        event({
          kind: "tool.called",
          tool: { name: "apply_patch", input_summary: "M src/a.ts, A src/b.ts" },
        }),
      ),
    ).toEqual(["src/a.ts", "src/b.ts"]);
    expect(
      editedFiles(
        event({
          kind: "tool.called",
          tool: { name: "Read" },
          target: { type: "file", value: "src/a.ts" },
        }),
      ),
    ).toEqual([]);
    expect(
      editedFiles(
        event({
          kind: "policy.evaluated",
          tool: { name: "Edit" },
          target: { type: "file", value: "src/a.ts" },
          decision: { verdict: "allow" },
        }),
      ),
    ).toEqual([]);
  });

  it("leaves out finished background runs and keeps running ones", () => {
    const system = { kind: "system" as const, id: "selfhost-runner" };
    const update = (run: string, state: string, ts: string) =>
      event({
        kind: "run.updated",
        actor: system,
        run_id: run,
        ts,
        repo: "acme/web",
        data: { background_run: { state, branch: `selfhost/${run}` } },
      });
    const presence = derivePresence(
      [
        {
          id: "run-a",
          kind: "background",
          events: [update("run-a", "running", "2026-11-12T10:20:00.000Z")],
          history: [
            event({
              kind: "run.triggered",
              actor: system,
              run_id: "run-a",
              ts: "2026-11-12T09:00:00.000Z",
              data: { trigger: { source: "api", sender: "x", person: "ada@example.com" } },
            }),
          ],
          team: "web",
        },
        {
          id: "run-b",
          kind: "background",
          events: [
            update("run-b", "running", "2026-11-12T10:10:00.000Z"),
            update("run-b", "succeeded", "2026-11-12T10:20:00.000Z"),
          ],
          team: "web",
        },
      ],
      { now: NOW, idleMinutes: 30 },
    );
    expect(presence.runs).toEqual([
      expect.objectContaining({
        id: "run-a",
        branch: "selfhost/run-a",
        owner: "ada@example.com",
        owner_via: "trigger",
        team: "web",
      }),
    ]);
    expect(validatePresenceResponse(presence)).toEqual({ ok: true, value: presence });
  });
});
