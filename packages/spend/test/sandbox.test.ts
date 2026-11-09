import {
  EVENT_SCHEMA,
  type LedgerEvent,
  SANDBOX_RECORD_SCHEMA,
  type SandboxRecord,
  validateEvent,
} from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { leftovers, sandboxSpans, sandboxSpendIn, sandboxWaste } from "../src/index.js";

const NOW = new Date("2026-11-09T12:00:00Z");
const MIN = 60_000;
let next = 0;

const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN).toISOString();

function event(fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind" | "ts">): LedgerEvent {
  next += 1;
  return {
    id: `01930000-0000-7000-8000-${String(next).padStart(12, "0")}`,
    schema: EVENT_SCHEMA,
    source: "server",
    actor: { kind: "system", id: "selfhost-runtime" },
    ...fields,
  };
}

function sandbox(
  kind: "sandbox.started" | "sandbox.stopped",
  minutesAgo: number,
  record: Omit<SandboxRecord, "schema">,
  extra: Partial<LedgerEvent> = {},
  usd?: number,
): LedgerEvent {
  return event({
    kind,
    ts: ago(minutesAgo),
    data: { sandbox: { schema: SANDBOX_RECORD_SCHEMA, ...record }, owner: "ana@example.com" },
    ...(usd !== undefined
      ? {
          cost: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            usd,
            estimated: true,
          },
        }
      : {}),
    ...extra,
  });
}

/** A recorded day of runs: an E2B run mostly waiting on the model, a busy Daytona one, a box left on. */
function recorded(): LedgerEvent[] {
  const e2b = { runtime: "e2b" as const, billing: "reserved" as const, usd_per_hour: 0.1656 };
  const daytona = {
    runtime: "daytona" as const,
    billing: "reserved" as const,
    usd_per_hour: 0.0666,
  };
  return [
    // Run 1 on E2B: 60 minutes billed, 6 of them running commands.
    sandbox("sandbox.started", 180, { ...e2b, sandbox_id: "e1" }, { run_id: "run-1" }),
    sandbox(
      "sandbox.stopped",
      120,
      {
        ...e2b,
        sandbox_id: "e1",
        reason: "run_ended",
        billed_seconds: 3600,
        busy_seconds: 360,
        idle_seconds: 3240,
      },
      { run_id: "run-1" },
      0.1656,
    ),
    event({
      kind: "cost.recorded",
      ts: ago(150),
      run_id: "run-1",
      cost: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        usd: 2.5,
        estimated: false,
      },
    }),
    // Run 2 on Daytona: 30 minutes, 27 busy.
    sandbox("sandbox.started", 100, { ...daytona, sandbox_id: "d1" }, { run_id: "run-2" }),
    sandbox(
      "sandbox.stopped",
      70,
      {
        ...daytona,
        sandbox_id: "d1",
        reason: "run_ended",
        billed_seconds: 1800,
        busy_seconds: 1620,
        idle_seconds: 180,
      },
      { run_id: "run-2" },
      0.0333,
    ),
    // Run 3 on E2B ended 50 minutes ago; its sandbox still runs.
    sandbox("sandbox.started", 90, { ...e2b, sandbox_id: "e2" }, { run_id: "run-3" }),
    event({
      kind: "session.ended",
      ts: ago(50),
      run_id: "run-3",
      actor: { kind: "agent", id: "run-3" },
    }),
  ];
}

describe("sandbox spans", () => {
  it("joins starts and stops, and takes the run's end from its own events", () => {
    const events = recorded();
    for (const item of events) expect(validateEvent(item).ok).toBe(true);
    const spans = sandboxSpans(events);
    expect(spans.get("e1")).toMatchObject({
      run_id: "run-1",
      cost_usd: 0.1656,
      idle_seconds: 3240,
      owner: "ana@example.com",
    });
    expect(spans.get("e2")).toMatchObject({ run_id: "run-3", run_ended: Date.parse(ago(50)) });
    expect(spans.get("e2")?.stopped).toBeUndefined();
  });

  it("splits a sandbox's cost across days for the daily cap", () => {
    const spans = sandboxSpans([
      sandbox(
        "sandbox.started",
        0,
        { runtime: "e2b", sandbox_id: "x", usd_per_hour: 1 },
        { ts: "2026-11-08T23:00:00Z" },
      ),
      sandbox(
        "sandbox.stopped",
        0,
        { runtime: "e2b", sandbox_id: "x" },
        { ts: "2026-11-09T01:00:00Z" },
        2,
      ),
    ]);
    const day = { from: new Date("2026-11-09T00:00:00Z"), to: new Date("2026-11-10T00:00:00Z") };
    expect(sandboxSpendIn(spans.values(), day.from, day.to, NOW)).toBe(1);
    expect(sandboxSpendIn(spans.values(), day.from, day.to, NOW, new Set(["x"]))).toBe(0);
  });
});

describe("sandboxWaste", () => {
  it("records billed, busy and idle seconds per run next to its model cost", () => {
    const report = sandboxWaste(recorded(), { now: NOW, team: "core" });
    expect(report.runs.find((run) => run.run_id === "run-1")).toEqual({
      run_id: "run-1",
      runtime: "e2b",
      billed_seconds: 3600,
      busy_seconds: 360,
      idle_seconds: 3240,
      sandbox_usd: 0.1656,
      model_usd: 2.5,
    });
    // Still running: 90 minutes billed so far, the 50 since its run ended idle.
    expect(report.runs.find((run) => run.run_id === "run-3")).toMatchObject({
      billed_seconds: 5400,
      idle_seconds: 3000,
      sandbox_usd: 0.2484,
    });
  });

  it("shows the idle share per runtime and names a cheaper billing model above half idle", () => {
    const report = sandboxWaste(recorded(), { now: NOW });
    const week = report.windows.find((window) => window.days === 7);
    const e2b = week?.by_runtime.find((row) => row.runtime === "e2b");
    const daytona = week?.by_runtime.find((row) => row.runtime === "daytona");
    // E2B: e1 0.1656 at 90% idle, e2 0.2484 at 50/90 idle.
    expect(e2b?.billed_usd).toBeCloseTo(0.414, 6);
    expect(e2b?.idle_usd).toBeCloseTo(0.1656 * 0.9 + 0.2484 * (50 / 90), 6);
    expect(e2b?.idle_share).toBeGreaterThan(0.5);
    expect(e2b?.suggestion?.text).toContain("active CPU only");
    expect(e2b?.suggestion?.monthly_saving_usd).toBeCloseTo(((e2b?.idle_usd ?? 0) * 30) / 7, 5);
    expect(daytona?.idle_share).toBeCloseTo(0.1, 6);
    expect(daytona?.suggestion).toBeNull();
    expect(report.windows.map((window) => window.days)).toEqual([7, 30]);
  });

  it("lists a sandbox still running 15 minutes after its run, with its cost so far", () => {
    const report = sandboxWaste(recorded(), { now: NOW });
    expect(report.leftovers).toEqual([
      {
        sandbox_id: "e2",
        runtime: "e2b",
        run_id: "run-3",
        owner: "ana@example.com",
        started_at: ago(90),
        run_ended_at: ago(50),
        stopped_at: null,
        minutes_after_run: 50,
        cost_usd: 0.2484,
        after_run_usd: 0.138,
      },
    ]);
    expect(leftovers(sandboxSpans(recorded()).values(), NOW, 60)).toEqual([]);
  });

  it("treats a run that failed or got stuck as ended", () => {
    const events = [
      sandbox(
        "sandbox.started",
        40,
        { runtime: "modal", sandbox_id: "m1", usd_per_hour: 0.24 },
        { run_id: "run-9" },
      ),
      event({ kind: "alert.raised", ts: ago(30), run_id: "run-9", data: { alert: "run_stuck" } }),
    ];
    expect(
      sandboxWaste(events, { now: NOW }).leftovers.map((row) => row.minutes_after_run),
    ).toEqual([30]);
  });
});
