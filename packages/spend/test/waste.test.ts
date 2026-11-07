import { describe, expect, it } from "vitest";
import { detectWaste, groupSpend, WASTE_REQUEST_TYPES } from "../src/index.js";
import { cost, day } from "./helpers.js";

const series = (...days: ReturnType<typeof day>[]) =>
  groupSpend(days.flat(), { by: ["request_type"] });

describe("detectWaste", () => {
  it("watches overhead, not the work itself or unlabelled spend", () => {
    expect(WASTE_REQUEST_TYPES).toEqual([
      "compaction",
      "title",
      "status_line",
      "background",
      "retry",
    ]);
  });

  it("flags a request type on the day its share crosses the threshold, with its trend", () => {
    const flags = detectWaste(
      series(
        day("2026-10-26", { main: 9, subagent: 1 }),
        day("2026-10-27", { main: 9, status_line: 0.5 }),
        day("2026-10-28", { main: 8, status_line: 2 }),
        day("2026-10-29", { main: 7, status_line: 3 }),
      ),
    );
    expect(flags).toEqual([
      {
        day: "2026-10-28",
        request_type: "status_line",
        usd: 2,
        day_usd: 10,
        share: 0.2,
        previous_share: 0.5 / 9.5,
        trend: [
          { day: "2026-10-26", usd: 0, share: 0 },
          { day: "2026-10-27", usd: 0.5, share: 0.5 / 9.5 },
        ],
      },
    ]);
  });

  it("uses a configurable threshold and minimum spend", () => {
    const s = series(
      day("2026-10-26", { main: 9.5, retry: 0.5 }),
      day("2026-10-27", { main: 9, retry: 1 }),
    );
    expect(detectWaste(s)).toHaveLength(1);
    expect(detectWaste(s, { shareThreshold: 0.05 }).map((f) => f.day)).toEqual(["2026-10-26"]);
    expect(detectWaste(s, { shareThreshold: 0.05, minUsd: 0.75 }).map((f) => f.day)).toEqual([
      "2026-10-27",
    ]);
    expect(detectWaste(s, { shareThreshold: 0.2 })).toEqual([]);
  });

  it("flags again only after the share drops back below the threshold", () => {
    const flags = detectWaste(
      series(
        day("2026-10-26", { main: 8, background: 2 }),
        day("2026-10-27", { main: 8, background: 2 }),
        day("2026-10-28", { main: 10 }),
        day("2026-10-29", { main: 8, background: 2 }),
      ),
    );
    expect(flags.map((f) => [f.day, f.previous_share])).toEqual([
      ["2026-10-26", null],
      ["2026-10-29", 0],
    ]);
  });

  it("does not let a day without any spend reset a crossing", () => {
    const flags = detectWaste(
      series(day("2026-10-24", { main: 8, title: 2 }), day("2026-10-27", { main: 8, title: 2 })),
    );
    expect(flags.map((f) => f.day)).toEqual(["2026-10-24"]);
    const quiet = groupSpend(day("2026-10-27", { main: 8, title: 2 }), {
      by: ["request_type"],
      from: "2026-10-18",
    });
    const [flag] = detectWaste(quiet);
    expect(flag?.previous_share).toBeNull();
    expect(flag?.trend.map((p) => p.day)).toEqual([
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
    ]);
  });

  it("adds up other dimensions and can watch any request type", () => {
    const ts = "2026-10-26T12:00:00.000Z";
    const events = [
      ...day("2026-10-26", { main: 5, compaction: 0.3 }),
      cost({ ts, usd: 0.3, type: "compaction", model: "claude-haiku-5-5" }),
      cost({ ts, usd: 4.4, type: "subagent", model: "claude-haiku-5-5" }),
    ];
    const byModel = groupSpend(events, { by: ["model", "request_type"] });
    expect(byModel.rows.filter((row) => row.group.request_type === "compaction")).toHaveLength(2);
    expect(detectWaste(byModel, { shareThreshold: 0.05 }).map((f) => f.usd)).toEqual([0.6]);
    const [subagent] = detectWaste(byModel, { types: ["subagent"] });
    expect(subagent?.request_type).toBe("subagent");
    expect(subagent?.share).toBeCloseTo(0.44, 10);
  });

  it("needs request_type in the series and a threshold between 0 and 1", () => {
    const events = day("2026-10-26", { main: 1 });
    expect(() => detectWaste(groupSpend(events, { by: ["model"] }))).toThrow(/request_type/);
    const s = groupSpend(events, { by: ["request_type"] });
    expect(() => detectWaste(s, { shareThreshold: 10 })).toThrow(RangeError);
    expect(() => detectWaste(s, { shareThreshold: 0 })).toThrow(RangeError);
  });
});
