import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importAll } from "@selfhost/importers";
import type { LedgerEvent } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectSpikes,
  forecastLimits,
  oneSourcePerSession,
  type PlanForecast,
} from "../src/index.js";
import { every, writeClaudeSession, writeCodexRollout } from "./limit-logs.js";
import { burst } from "./series.js";

const DEV = "dev@example.com";
const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");

async function importLogs(root: string, since = "2026-10-01T00:00:00Z"): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  await importAll(
    {
      append: async (batch) => {
        events.push(...batch);
        return { accepted: batch.map((event) => event.id), duplicates: [] };
      },
    },
    {
      claudeDir: join(root, "claude-code"),
      codexDir: join(root, "codex"),
      since: new Date(since),
      actorId: DEV,
    },
  );
  return events;
}

const windowOf = (forecast: PlanForecast | undefined, name: "session" | "weekly") =>
  forecast?.windows.find((window) => window.window === name);

const minutesApart = (a: string | null | undefined, b: string) =>
  Math.abs(Date.parse(a ?? "") - Date.parse(b)) / 60_000;

/**
 * Two weeks of one developer's logs where both plans hit a limit twice. The forecast runs on
 * Wednesday 2026-10-28 at noon with only the events before then, and is checked against the
 * hits that came after.
 */
describe("backtest on logs where a limit was hit", () => {
  const root = mkdtempSync(join(tmpdir(), "selfhost-limits-"));
  const now = new Date("2026-10-28T12:00:00.000Z");
  let events: LedgerEvent[];
  let forecasts: PlanForecast[];

  beforeAll(async () => {
    // Claude Code: $0.50 every 2 minutes until the 5-hour limit, on two Wednesdays.
    for (const [day, from] of [
      ["2026-10-21", "09:00"],
      ["2026-10-28", "11:00"],
    ] as const) {
      const responses = every(`${day}T${from}:00Z`, `${day}T23:00:00Z`, 2)
        .slice(0, 80)
        .map((ts) => ({ ts, usd: 0.5 }));
      const last = Date.parse(responses.at(-1)?.ts ?? "");
      writeClaudeSession(root, responses, {
        ts: new Date(last + 30_000).toISOString(),
        text: "5-hour limit reached ∙ resets 4pm",
      });
    }
    // Codex: a request every 10 minutes, 09:00 to 17:00 every day, until the weekly limit on
    // Sunday at 13:00; the week resets on Tuesday at 06:00.
    for (const week of [0, 7]) {
      for (let offset = 0; offset < 6; offset++) {
        const day = new Date(Date.parse("2026-10-20T00:00:00Z") + (week + offset) * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const sunday = offset === 5;
        const requests = every(`${day}T09:00:00Z`, `${day}T${sunday ? "13" : "17"}:00:00Z`, 10);
        const resetsAt = new Date(Date.parse(`${day}T06:00:00Z`) + 2 * 86_400_000).toISOString();
        writeCodexRollout(
          root,
          requests,
          sunday ? { ts: `${day}T13:00:45.000Z`, resetsAt } : undefined,
        );
      }
    }
    events = oneSourcePerSession(await importLogs(root));
    const before = events.filter((event) => Date.parse(event.ts) <= now.getTime());
    forecasts = forecastLimits(before, DEV, { now, tiers: { claude: "max_5x" } });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("imports each limit hit once, as an alert.raised usage_limit event", () => {
    const hits = events.filter((event) => event.kind === "alert.raised");
    expect(
      hits.map((event) => [
        event.ts,
        event.agent?.vendor,
        event.data?.window,
        event.data?.resets_at,
      ]),
    ).toEqual([
      ["2026-10-21T11:39:00.000Z", "claude_code", "session", undefined],
      ["2026-10-25T13:00:45.000Z", "codex", "weekly", "2026-10-27T06:00:00.000Z"],
      ["2026-10-28T13:39:00.000Z", "claude_code", "session", undefined],
      ["2026-11-01T13:00:45.000Z", "codex", "weekly", "2026-11-03T06:00:00.000Z"],
    ]);
    expect(hits.every((event) => event.actor.id === DEV && event.source === "local_log")).toBe(
      true,
    );
  });

  it("forecasts the Claude 5-hour limit within minutes of the hit that followed", () => {
    const claude = forecasts.find((forecast) => forecast.plan === "claude");
    const session = windowOf(claude, "session");
    expect(session).toMatchObject({ basis: "calibrated", limit_usd: 40, status: "warn" });
    expect(minutesApart(session?.run_out, "2026-10-28T13:39:00.000Z")).toBeLessThan(5);
    expect(claude?.suggestion).toMatchObject({ kind: "quiet_hours" });
    // No weekly hit for Claude: the weekly limit is the max_5x row of the table.
    expect(windowOf(claude, "weekly")).toMatchObject({ basis: "table", status: "ok" });
  });

  it("forecasts the Codex weekly limit four days ahead, within an hour", () => {
    const codex = forecasts.find((forecast) => forecast.plan === "codex");
    const weekly = windowOf(codex, "weekly");
    expect(weekly).toMatchObject({
      start: "2026-10-27T06:00:00.000Z",
      end: "2026-11-03T06:00:00.000Z",
      basis: "calibrated",
      status: "ok",
    });
    expect(minutesApart(weekly?.run_out, "2026-11-01T13:00:45.000Z")).toBeLessThan(60);
    expect(codex?.run_out_window).toBe("weekly");
    const sooner = forecastLimits(
      events.filter((event) => Date.parse(event.ts) <= Date.parse("2026-10-31T17:00:00Z")),
      DEV,
      { now: new Date("2026-10-31T17:00:00Z") },
    ).find((forecast) => forecast.plan === "codex");
    expect(sooner?.status).toBe("warn");
  });
});

describe("a normal week's spend within one hour, on the subscription-week fixture", () => {
  let events: LedgerEvent[];

  beforeAll(async () => {
    events = oneSourcePerSession(await importLogs(join(FIXTURES, "sources", "subscription-week")));
  });

  it("raises nothing on the fixture week itself, even with that lower floor", () => {
    for (const day of ["22", "23", "24"]) {
      const alarms = detectSpikes(events, {
        now: new Date(`2026-10-${day}T23:59:59Z`),
        since: new Date(`2026-10-${day}T00:00:00Z`),
        floorUsd: 0.25,
      });
      expect(alarms).toEqual([]);
    }
  });

  it("raises within the first 15 minutes of the hour, once the floor fits the account", () => {
    const week = events
      .filter((event) => event.kind === "cost.recorded" && event.agent?.vendor === "claude_code")
      .reduce((sum, event) => sum + (event.cost?.usd ?? 0), 0);
    // The whole week, spent from 14:00 on the Sunday after it.
    const spike = burst("2026-10-25T14:00:00.000Z", 60, week, DEV);
    const firstSlot = {
      now: new Date("2026-10-25T14:14:59.000Z"),
      since: new Date("2026-10-25T14:00:00.000Z"),
    };
    // The fixture's Claude Code week is under $2, so a quarter of it is under the default $5
    // floor: an account this small sets a lower one.
    expect(week).toBeLessThan(5);
    expect(detectSpikes([...events, ...spike], firstSlot)).toEqual([]);
    const alarms = detectSpikes([...events, ...spike], { ...firstSlot, floorUsd: 0.25 });
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({
      series: { person: DEV, agent: "claude_code", key: null, runtime: null },
      slot_start: "2026-10-25T14:00:00.000Z",
      reason: "above_band",
    });
    expect(alarms[0]?.usd).toBeCloseTo(week / 4, 6);
  });

  it("judges each slot against the same time of day", () => {
    // This developer does a day's Claude Code work in the 15 minutes from 08:40, so the same
    // burst from 08:30 stays inside the band there, and alarms in the slots after it.
    const week = events
      .filter((event) => event.kind === "cost.recorded" && event.agent?.vendor === "claude_code")
      .reduce((sum, event) => sum + (event.cost?.usd ?? 0), 0);
    const spike = burst("2026-10-25T08:30:00.000Z", 60, week, DEV);
    const alarms = detectSpikes([...events, ...spike], {
      now: new Date("2026-10-25T09:29:59.000Z"),
      since: new Date("2026-10-25T08:30:00.000Z"),
      floorUsd: 0.25,
    });
    expect(alarms.map((alarm) => alarm.slot_start.slice(11, 16))).toEqual(["09:15"]);
  });
});
