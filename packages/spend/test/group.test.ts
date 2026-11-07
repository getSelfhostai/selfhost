import type { LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { dayRange, groupSpend, totalSpend, utcDay } from "../src/index.js";
import { cost } from "./helpers.js";

const events: LedgerEvent[] = [
  cost({
    ts: "2026-10-26T09:00:00.000Z",
    usd: 0.5,
    type: "main",
    model: "claude-opus-5-5",
    person: "alice@example.com",
    tokens: 100,
  }),
  cost({
    ts: "2026-10-26T10:00:00.000Z",
    usd: 0.25,
    type: "main",
    model: "claude-opus-5-5",
    person: "alice@example.com",
    tokens: 40,
  }),
  cost({
    ts: "2026-10-26T11:00:00.000Z",
    usd: 0.25,
    type: "status_line",
    model: "claude-opus-5-5",
    person: "bob@example.com",
    tokens: 900,
  }),
  cost({
    ts: "2026-10-28T23:30:00.000-02:00",
    usd: 1,
    type: "main",
    vendor: "codex",
    model: "gpt-5.5",
    person: "alice@example.com",
  }),
  cost({ ts: "2026-10-28T08:00:00.000Z", usd: 0.1, type: "agent_summary" }),
  cost({ ts: "2026-10-28T08:00:00.000Z", usd: 0.1 }),
];

describe("groupSpend", () => {
  it("adds up tokens, requests and USD per UTC day and request type", () => {
    const series = groupSpend(events, { by: ["request_type"], interval: "day" });
    expect(series.by).toEqual(["request_type"]);
    expect(series.days).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"]);
    expect(
      series.rows.map((row) => [row.day, row.group.request_type, row.requests, row.usd]),
    ).toEqual([
      ["2026-10-26", "main", 2, 0.75],
      ["2026-10-26", "status_line", 1, 0.25],
      ["2026-10-28", "unknown", 2, 0.2],
      ["2026-10-29", "main", 1, 1],
    ]);
    expect(series.rows[0]).toMatchObject({ input_tokens: 140, tokens: 140 });
  });

  it("groups by agent, model and person together", () => {
    const series = groupSpend(events, { by: ["agent", "model", "person"] });
    expect(series.rows.map((row) => row.group)).toEqual([
      { agent: "claude_code", model: "claude-opus-5-5", person: "alice@example.com" },
      { agent: "claude_code", model: "claude-opus-5-5", person: "bob@example.com" },
      { agent: "claude_code", model: "unknown", person: "unknown" },
      { agent: "codex", model: "gpt-5.5", person: "alice@example.com" },
    ]);
  });

  it("fills the requested range and drops events outside it", () => {
    const series = groupSpend(events, {
      by: ["request_type"],
      from: new Date("2026-10-25T18:00:00Z"),
      to: "2026-10-28",
    });
    expect(series.days).toEqual(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"]);
    expect(series.rows.some((row) => row.day === "2026-10-29")).toBe(false);
  });

  it("ignores other event kinds and returns an empty series for no spend", () => {
    const session = { ...events[0], kind: "session.started" } as LedgerEvent;
    expect(groupSpend([session], { by: ["model"] })).toEqual({
      by: ["model"],
      interval: "day",
      days: [],
      rows: [],
    });
  });

  it("rejects unknown dimensions and intervals", () => {
    expect(() => groupSpend(events, { by: ["repo" as "model"] })).toThrow(
      /Unknown spend dimension/,
    );
    expect(() => groupSpend(events, { by: ["model"], interval: "week" as "day" })).toThrow(
      /interval/,
    );
    expect(() => groupSpend(events, { by: ["model"], from: "soon" })).toThrow(/from/);
  });

  it("gives the same series for the same events in any order", () => {
    const forward = groupSpend(events, { by: ["request_type", "person"] });
    const backward = groupSpend([...events].reverse(), { by: ["request_type", "person"] });
    expect(backward).toEqual(forward);
  });
});

describe("totalSpend", () => {
  it("totals each group over the series with its share", () => {
    const { total, groups } = totalSpend(groupSpend(events, { by: ["request_type"] }));
    expect(total.usd).toBeCloseTo(2.2, 10);
    expect(total.requests).toBe(6);
    expect(groups.map((g) => [g.group.request_type, g.usd, Number(g.share.toFixed(4))])).toEqual([
      ["main", 1.75, 0.7955],
      ["status_line", 0.25, 0.1136],
      ["unknown", 0.2, 0.0909],
    ]);
  });
});

describe("days", () => {
  it("reads UTC days and ranges", () => {
    expect(utcDay("2026-10-28T23:30:00.000-02:00")).toBe("2026-10-29");
    expect(utcDay("nope")).toBeUndefined();
    expect(dayRange("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });
});
