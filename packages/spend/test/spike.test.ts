import type { LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { detectSpikes, keyOf, spikeActions, spikeSeriesOf } from "../src/index.js";
import { cost } from "./helpers.js";
import { burst, teamSpend, type Worker } from "./series.js";

/** `usd` at hh:mm UTC on each of `days` days ending the day before `last`. */
function daily(last: string, days: number, time: string, usd: number, person = "a@example.com") {
  const end = Date.parse(`${last}T${time}:00.000Z`);
  return Array.from({ length: days }, (_, index) =>
    cost({ ts: new Date(end - (days - index) * 86_400_000).toISOString(), usd, person }),
  );
}

const at = (ts: string, usd: number, person = "a@example.com") => cost({ ts, usd, person });

const window = (now: string, since: string) => ({ now: new Date(now), since: new Date(since) });

describe("the baseline and band", () => {
  const history = daily("2026-11-02", 14, "10:05", 2);

  it("alarms above spike_factor x the median for the same time of day", () => {
    const alarms = detectSpikes(
      [...history, at("2026-11-02T10:05:00.000Z", 25)],
      window("2026-11-02T10:14:00.000Z", "2026-11-02T10:00:00.000Z"),
    );
    expect(alarms).toEqual([
      {
        series: { key: null, person: "a@example.com", agent: "claude_code", runtime: null },
        slot_start: "2026-11-02T10:00:00.000Z",
        slot_end: "2026-11-02T10:15:00.000Z",
        usd: 25,
        requests: 1,
        baseline: { days: 14, active_days: 14, median: 2, mad: 0, band: 20 },
        reason: "above_band",
        actions: [{ id: "rotate_key", target: null }],
      },
    ]);
  });

  it("stays quiet inside the band", () => {
    const quiet = detectSpikes(
      [...history, at("2026-11-02T10:05:00.000Z", 19)],
      window("2026-11-02T10:14:00.000Z", "2026-11-02T10:00:00.000Z"),
    );
    expect(quiet).toEqual([]);
  });

  it("widens the band for a series that varies, by its MAD", () => {
    const varied = [...daily("2026-11-02", 7, "10:05", 1), ...daily("2026-10-26", 7, "10:05", 9)];
    // Median 5, MAD 4: band max(10 x 5, 5 + 6 x 1.4826 x 4) = 50.
    const [alarm] = detectSpikes(
      [...varied, at("2026-11-02T10:05:00.000Z", 51)],
      window("2026-11-02T10:14:00.000Z", "2026-11-02T10:00:00.000Z"),
    );
    expect(alarm?.baseline).toEqual({ days: 14, active_days: 14, median: 5, mad: 4, band: 50 });
    // With factor 2 and madK 10 the MAD term sets the band: 5 + 10 x 1.4826 x 4 = 64.3.
    const opts = {
      ...window("2026-11-02T10:14:00.000Z", "2026-11-02T10:00:00.000Z"),
      factor: 2,
      madK: 10,
    };
    expect(detectSpikes([...varied, at("2026-11-02T10:05:00.000Z", 64)], opts)).toEqual([]);
    const [wide] = detectSpikes([...varied, at("2026-11-02T10:05:00.000Z", 65)], opts);
    expect(wide?.baseline.band).toBeCloseTo(5 + 10 * 1.4826 * 4, 10);
  });

  it("compares with the same time of day, not the day's total", () => {
    // Usual work at 10:05; the same $6 at 03:05 is outside the band for 03:00.
    const night = detectSpikes(
      [...history, at("2026-11-02T03:05:00.000Z", 6)],
      window("2026-11-02T03:14:00.000Z", "2026-11-02T03:00:00.000Z"),
    );
    expect(night.map((a) => [a.slot_start, a.baseline.median, a.baseline.band])).toEqual([
      ["2026-11-02T03:00:00.000Z", 0, 0],
    ]);
  });

  it("tolerates work starting up to 30 minutes off the usual time", () => {
    const late = detectSpikes([...history, at("2026-11-02T10:35:00.000Z", 6)], {
      ...window("2026-11-02T10:44:00.000Z", "2026-11-02T10:30:00.000Z"),
      floorUsd: 0,
    });
    expect(late).toEqual([]);
  });

  it("counts only days the series had spend", () => {
    // Seven working days out of fourteen: the quiet days do not pull the median to zero.
    const workdays = daily("2026-11-02", 14, "10:05", 2).filter((_, index) => index % 2 === 0);
    const alarms = detectSpikes(
      [...workdays, at("2026-11-02T10:05:00.000Z", 15)],
      window("2026-11-02T10:14:00.000Z", "2026-11-02T10:00:00.000Z"),
    );
    expect(alarms).toEqual([]);
  });

  it("never alarms under the floor, and alarms at it for a series with no baseline", () => {
    const fresh = [at("2026-11-02T10:05:00.000Z", 4.99, "new@example.com")];
    const opts = window("2026-11-02T10:14:00.000Z", "2026-11-02T10:00:00.000Z");
    expect(detectSpikes(fresh, opts)).toEqual([]);
    expect(detectSpikes(fresh, { ...opts, floorUsd: 4 })).toMatchObject([
      { reason: "no_baseline", baseline: { active_days: 0, band: 0 } },
    ]);
    const twoDays = [...daily("2026-11-02", 2, "10:05", 50, "new@example.com"), ...fresh];
    expect(detectSpikes(twoDays, { ...opts, floorUsd: 4 })[0]?.reason).toBe("no_baseline");
    expect(detectSpikes(twoDays, { ...opts, floorUsd: 4, minActiveDays: 2 })).toEqual([]);
  });

  it("is deterministic and evaluates every slot from since to now", () => {
    const events = [
      ...history,
      ...burst("2026-11-02T10:00:00.000Z", 45, 90, "a@example.com"),
      ...burst("2026-11-02T10:00:00.000Z", 15, 40, "b@example.com"),
    ];
    const opts = window("2026-11-02T10:50:00.000Z", "2026-11-02T10:00:00.000Z");
    const alarms = detectSpikes(events, opts);
    expect(detectSpikes([...events].reverse(), opts)).toEqual(alarms);
    const rows = alarms.map((a) => [
      a.slot_start.slice(11, 16),
      a.series.person,
      +a.usd.toFixed(6),
    ]);
    expect(rows).toEqual([
      ["10:00", "b@example.com", 40],
      ["10:00", "a@example.com", 30],
      ["10:15", "a@example.com", 30],
      ["10:30", "a@example.com", 30],
    ]);
  });
});

describe("series and actions", () => {
  const gateway: LedgerEvent = {
    ...cost({ ts: "2026-11-02T10:00:00.000Z", usd: 1, person: "dev@example.com" }),
    source: "gateway",
    data: { gateway: "litellm", key_alias: "ci-bot", request_type: "unknown" },
  };
  const providerKey: LedgerEvent = {
    ...cost({ ts: "2026-11-02T10:00:00.000Z", usd: 1 }),
    source: "vendor_api",
    actor: { kind: "system", id: "anthropic:api_key:apikey_01" },
  };
  const remote: LedgerEvent = {
    ...cost({ ts: "2026-11-02T10:00:00.000Z", usd: 1, person: "dev@example.com" }),
    data: { runtime: "e2b:sbx_42" },
  };

  it("splits spend by key, person, agent and runtime", () => {
    expect(spikeSeriesOf(gateway)).toEqual({
      key: "litellm:ci-bot",
      person: "dev@example.com",
      agent: "claude_code",
      runtime: null,
    });
    expect(keyOf(providerKey)).toBe("anthropic:api_key:apikey_01");
    expect(spikeSeriesOf(providerKey).person).toBeNull();
    expect(spikeSeriesOf(remote).runtime).toBe("e2b:sbx_42");
  });

  it("offers only the actions that apply", () => {
    expect(spikeActions(spikeSeriesOf(gateway)).map((a) => a.id)).toEqual([
      "rotate_key",
      "disable_virtual_key",
    ]);
    expect(spikeActions(spikeSeriesOf(providerKey))).toEqual([
      { id: "rotate_key", target: "anthropic:api_key:apikey_01" },
    ]);
    expect(spikeActions(spikeSeriesOf(remote))).toEqual([
      { id: "rotate_key", target: null },
      { id: "pause_runtime", target: "e2b:sbx_42" },
    ]);
  });
});

describe("a team's normal three weeks, then a normal week's spend in one hour", () => {
  const workers: Worker[] = [
    { person: "alice@example.com", vendor: "claude_code", from: 8, to: 17, usdPerSlot: 1.2 },
    { person: "alice@example.com", vendor: "codex", from: 13, to: 16, usdPerSlot: 0.6 },
    { person: "bob@example.com", vendor: "claude_code", from: 14, to: 23, usdPerSlot: 2.5 },
    {
      person: "chen@example.com",
      vendor: "claude_code",
      from: 2,
      to: 7,
      usdPerSlot: 4,
      weekends: true,
    },
  ];
  // 2026-10-12 to 2026-11-01, three weeks.
  const normal = teamSpend(workers, "2026-10-12", 21);
  const lastWeek = normal.filter((event) => event.ts >= "2026-10-26");

  it("raises nothing on any 15-minute slot of the last week, even with no floor", () => {
    // A slot's baseline only looks back, so evaluating the whole week at once gives what each
    // slot gave as it ended.
    const week = { now: new Date("2026-11-01T23:59:59Z"), since: new Date("2026-10-26T00:00Z") };
    expect(detectSpikes(normal, week)).toEqual([]);
    expect(detectSpikes(normal, { ...week, floorUsd: 0 })).toEqual([]);
    // The band is what keeps it quiet: at 1.2x the median some slots do cross.
    const tight = { ...week, floorUsd: 0, factor: 1.2, madK: 0 };
    expect(detectSpikes(normal, tight).length).toBeGreaterThan(0);
  });

  it("raises in the first 15 minutes of the burst", () => {
    const week = lastWeek
      .filter((event) => event.actor.id === "bob@example.com")
      .reduce((sum, event) => sum + (event.cost?.usd ?? 0), 0);
    expect(week).toBeGreaterThan(100);
    // Bob's normal week, spent between 15:00 and 16:00 on Monday, an hour he usually works.
    const spike = burst("2026-11-02T15:00:00.000Z", 60, week, "bob@example.com");
    const firstSlot = [...normal, ...spike].filter((event) => event.ts < "2026-11-02T15:15");
    const alarms = detectSpikes(firstSlot, window("2026-11-02T15:14:59.000Z", "2026-11-02T15:00Z"));
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({
      series: { person: "bob@example.com", agent: "claude_code" },
      slot_start: "2026-11-02T15:00:00.000Z",
      reason: "above_band",
    });
    expect(alarms[0]?.usd).toBeCloseTo(week / 4, 6);
    expect(alarms[0]?.usd).toBeGreaterThan(alarms[0]?.baseline.band ?? Number.POSITIVE_INFINITY);
  });
});
