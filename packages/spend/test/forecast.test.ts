import type { LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_LIMITS,
  forecastLimits,
  forecastPeople,
  type LimitSource,
  limitHits,
  type PlanForecast,
} from "../src/index.js";
import { cost } from "./helpers.js";

const DEV = "dev@example.com";

/** One request every `everyMin` minutes from `from` (inclusive) to `to` (exclusive). */
function steady(
  from: string,
  to: string,
  everyMin: number,
  usd: number,
  vendor: "claude_code" | "codex" = "claude_code",
  person = DEV,
): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (let ms = Date.parse(from); ms < Date.parse(to); ms += everyMin * 60_000) {
    events.push(cost({ ts: new Date(ms + 30_000).toISOString(), usd, vendor, person }));
  }
  return events;
}

function hit(
  ts: string,
  vendor: "claude_code" | "codex",
  data: Record<string, unknown>,
  person = DEV,
): LedgerEvent {
  return {
    ...cost({ ts, usd: 0, vendor, person }),
    kind: "alert.raised",
    cost: undefined,
    data: { alert: "usage_limit", ...data },
  };
}

const plan = (forecasts: PlanForecast[], name: "claude" | "codex") => {
  const found = forecasts.find((forecast) => forecast.plan === name);
  if (!found) throw new Error(`no ${name} forecast`);
  return found;
};

const windowOf = (forecast: PlanForecast, name: "session" | "weekly") =>
  forecast.windows.find((window) => window.window === name);

describe("the 5-hour session window", () => {
  // $0.50 every 2 minutes from 11:00: $15 an hour.
  const session = steady("2026-10-28T11:00:00Z", "2026-10-28T12:00:00Z", 2, 0.5);
  const now = new Date("2026-10-28T12:00:00Z");

  it("projects the last hour's burn to the run-out time", () => {
    const claude = plan(forecastLimits(session, DEV, { now, tiers: { claude: "pro" } }), "claude");
    expect(windowOf(claude, "session")).toEqual({
      window: "session",
      start: "2026-10-28T11:00:00.000Z",
      end: "2026-10-28T16:00:00.000Z",
      usage_usd: 15,
      limit_usd: 10,
      basis: "table",
      basis_label: "pro, built-in table as of 2026-11-01",
      rate_usd_per_hour: 15,
      projected_usd: 75,
      run_out: "2026-10-28T11:38:30.000Z",
      status: "reached",
    });
    const max = plan(forecastLimits(session, DEV, { now, tiers: { claude: "max_5x" } }), "claude");
    // $35 left at $15 an hour: 2h20m, before the window resets at 16:00.
    expect(windowOf(max, "session")).toMatchObject({
      limit_usd: 50,
      run_out: "2026-10-28T14:20:00.000Z",
      status: "warn",
    });
    expect(max).toMatchObject({
      status: "warn",
      run_out: "2026-10-28T14:20:00.000Z",
      run_out_window: "session",
    });
  });

  it("does not warn when the window resets before the limit runs out", () => {
    const big = plan(forecastLimits(session, DEV, { now, tiers: { claude: "max_20x" } }), "claude");
    expect(windowOf(big, "session")).toMatchObject({ run_out: null, status: "ok" });
  });

  it("damps a burst in the first minutes of a window", () => {
    const early = steady("2026-10-28T11:00:00Z", "2026-10-28T11:10:00Z", 2, 2);
    const at = new Date("2026-10-28T11:10:00Z");
    const claude = plan(
      forecastLimits(early, DEV, { now: at, tiers: { claude: "max_5x" } }),
      "claude",
    );
    // $10 over at least 30 minutes is $20 an hour, not $60.
    expect(windowOf(claude, "session")?.rate_usd_per_hour).toBe(20);
  });

  it("is idle with no window running", () => {
    const later = new Date("2026-10-28T17:00:00Z");
    const claude = plan(
      forecastLimits(session, DEV, { now: later, tiers: { claude: "pro" } }),
      "claude",
    );
    expect(windowOf(claude, "session")).toMatchObject({ start: null, status: "idle" });
  });
});

describe("the weekly window", () => {
  // Codex: $20 an hour, 10:00 to 18:00 on weekdays, two weeks from Monday 2026-10-19.
  const weekdays = ["19", "20", "21", "22", "23", "26", "27", "28"].flatMap((day) =>
    steady(`2026-10-${day}T10:00:00Z`, `2026-10-${day}T18:00:00Z`, 3, 1, "codex"),
  );
  const now = new Date("2026-10-28T18:00:00Z");
  const limits: LimitSource[] = [
    { label: "test table", limits: { codex: { team: { weekly_usd: 700 } } } },
  ];

  it("replays the same hours of last week over the rest of this one", () => {
    const codex = plan(
      forecastLimits(weekdays, DEV, { now, tiers: { codex: "team" }, limits }),
      "codex",
    );
    // Monday to Wednesday used $480; Thursday adds $160, then $60 more is Friday 13:00.
    expect(windowOf(codex, "weekly")).toMatchObject({
      start: "2026-10-26T00:00:00.000Z",
      end: "2026-11-02T00:00:00.000Z",
      usage_usd: 480,
      limit_usd: 700,
      basis: "table",
      basis_label: "team, test table",
      projected_usd: 800,
      status: "ok",
    });
    const runOut = Date.parse(windowOf(codex, "weekly")?.run_out ?? "");
    expect(Math.abs(runOut - Date.parse("2026-10-30T13:00:00Z"))).toBeLessThan(60_000);
    expect(codex.run_out_window).toBe("weekly");
  });

  it("warns once the run-out is inside the warning window", () => {
    const codex = plan(
      forecastLimits(weekdays, DEV, { now, tiers: { codex: "team" }, limits, warnHours: 48 }),
      "codex",
    );
    expect(codex.status).toBe("warn");
    expect(codex.suggestion).toEqual({
      kind: "quiet_hours",
      from_hour: 0,
      to_hour: 4,
      resets_at: "2026-11-02T00:00:00.000Z",
    });
  });

  it("says not this week when the projection stays under the limit", () => {
    const codex = plan(
      forecastLimits(weekdays, DEV, { now, tiers: { codex: "pro" }, limits: [BUILT_IN_LIMITS] }),
      "codex",
    );
    expect(windowOf(codex, "weekly")).toMatchObject({ limit_usd: 400, status: "reached" });
    const roomy = plan(
      forecastLimits(weekdays, DEV, {
        now,
        tiers: { codex: "big" },
        limits: [{ label: "t", limits: { codex: { big: { weekly_usd: 5000 } } } }],
      }),
      "codex",
    );
    expect(windowOf(roomy, "weekly")).toMatchObject({ run_out: null, status: "ok" });
  });

  it("starts the week when the vendor said it resets", () => {
    const reset = hit("2026-10-25T09:00:00Z", "codex", {
      window: "weekly",
      resets_at: "2026-10-27T06:00:00.000Z",
    });
    const codex = plan(
      forecastLimits([...weekdays, reset], DEV, { now, tiers: { codex: "team" }, limits }),
      "codex",
    );
    expect(windowOf(codex, "weekly")).toMatchObject({
      start: "2026-10-27T06:00:00.000Z",
      end: "2026-11-03T06:00:00.000Z",
    });
  });
});

describe("limits", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const today = steady("2026-10-28T11:00:00Z", "2026-10-28T12:00:00Z", 2, 0.5);

  it("calibrates from the usage before each limit hit, the median of the latest three", () => {
    const hits = [
      { day: "14", usd: 99 },
      { day: "20", usd: 30 },
      { day: "22", usd: 42 },
      { day: "24", usd: 36 },
    ].flatMap(({ day, usd }) => [
      ...steady(`2026-10-${day}T09:00:00Z`, `2026-10-${day}T10:00:00Z`, 1, usd / 60),
      hit(`2026-10-${day}T10:00:00Z`, "claude_code", { window: "session" }),
    ]);
    const claude = plan(
      forecastLimits([...hits, ...today], DEV, { now, tiers: { claude: "pro" } }),
      "claude",
    );
    expect(claude.hits).toBe(4);
    const session = windowOf(claude, "session");
    expect(session?.basis).toBe("calibrated");
    expect(session?.limit_usd).toBeCloseTo(36, 6);
    expect(session?.basis_label).toBe(
      "calibrated from 3 limit hits in the logs, latest 2026-10-24",
    );
    // A hit with no window counts as the session window; weekly falls back to the tier.
    expect(windowOf(claude, "weekly")?.basis).toBe("table");
  });

  it("forgets hits older than four weeks", () => {
    const old = [
      ...steady("2026-09-20T09:00:00Z", "2026-09-20T10:00:00Z", 1, 1),
      hit("2026-09-20T10:00:00Z", "claude_code", {}),
    ];
    const claude = plan(forecastLimits([...old, ...today], DEV, { now }), "claude");
    expect(claude.hits).toBe(0);
    expect(windowOf(claude, "session")).toMatchObject({
      basis: "none",
      basis_label: "no tier set and no limit hit in the logs",
      limit_usd: null,
      status: "unknown",
    });
  });

  it("reads limit hits per person and plan", () => {
    const hits = limitHits([
      hit("2026-10-20T10:00:00Z", "codex", { window: "weekly", resets_at: "2026-10-27T06:00:00Z" }),
      hit("2026-10-21T10:00:00Z", "claude_code", { window: "nonsense" }, "bob@example.com"),
      { ...hit("2026-10-21T11:00:00Z", "claude_code", {}), data: { alert: "api_error" } },
    ]);
    expect(hits).toEqual([
      {
        ts: "2026-10-20T10:00:00Z",
        person: DEV,
        plan: "codex",
        window: "weekly",
        resets_at: "2026-10-27T06:00:00Z",
      },
      { ts: "2026-10-21T10:00:00Z", person: "bob@example.com", plan: "claude", window: "session" },
    ]);
  });

  it("does not count API key traffic through the gateway against the plan", () => {
    const gateway = steady("2026-10-28T11:00:00Z", "2026-10-28T12:00:00Z", 1, 5).map((event) => ({
      ...event,
      source: "gateway" as const,
    }));
    const claude = plan(
      forecastLimits([...gateway, ...today], DEV, { now, tiers: { claude: "max_5x" } }),
      "claude",
    );
    expect(windowOf(claude, "session")?.usage_usd).toBe(15);
  });
});

describe("the fix it suggests", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const today = steady("2026-10-28T11:00:00Z", "2026-10-28T12:00:00Z", 2, 0.5);
  const overflowSpend = (usd: number): LedgerEvent => ({
    ...cost({ ts: "2026-10-03T10:00:00Z", usd }),
    source: "gateway",
    actor: { kind: "system", id: "litellm:team-overflow" },
    data: { gateway: "litellm", key_alias: "team-overflow" },
  });
  const overflow = { key: "team-overflow", monthly_cap_usd: 500 };

  it("overflows to the team's API key while it is under its cap", () => {
    const claude = plan(
      forecastLimits([...today, overflowSpend(120)], DEV, {
        now,
        tiers: { claude: "max_5x" },
        overflow,
      }),
      "claude",
    );
    expect(claude.suggestion).toEqual({
      kind: "overflow",
      key: "team-overflow",
      left_usd: 380,
      cap_usd: 500,
    });
  });

  it("moves background work to quieter hours once the key is at its cap", () => {
    const claude = plan(
      forecastLimits([...today, overflowSpend(500)], DEV, {
        now,
        tiers: { claude: "max_5x" },
        overflow,
      }),
      "claude",
    );
    expect(claude.suggestion).toMatchObject({
      kind: "quiet_hours",
      resets_at: "2026-10-28T16:00:00.000Z",
    });
  });

  it("suggests nothing when no window is close", () => {
    const claude = plan(
      forecastLimits(today, DEV, { now, tiers: { claude: "max_20x" } }),
      "claude",
    );
    expect(claude.suggestion).toBeNull();
  });
});

describe("forecastPeople", () => {
  it("lists people with plan usage in the last 7 days", () => {
    const events = [
      ...steady("2026-10-27T10:00:00Z", "2026-10-27T10:05:00Z", 1, 1, "codex", "b@example.com"),
      ...steady("2026-10-27T10:00:00Z", "2026-10-27T10:05:00Z", 1, 1),
      ...steady("2026-10-10T10:00:00Z", "2026-10-10T10:05:00Z", 1, 1, "codex", "old@example.com"),
    ];
    expect(forecastPeople(events, new Date("2026-10-28T12:00:00Z"))).toEqual([
      "b@example.com",
      DEV,
    ]);
  });
});
