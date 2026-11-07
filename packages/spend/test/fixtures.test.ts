import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importAll } from "@selfhost/importers";
import { mapOtelLogs } from "@selfhost/ledger";
import type { LedgerEvent } from "@selfhost/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { detectWaste, groupSpend, totalSpend } from "../src/index.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");

function otelWeek(): LedgerEvent[] {
  const lines = readFileSync(join(FIXTURES, "sources", "otel", "claude-code-week.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  return mapOtelLogs(lines);
}

async function subscriptionWeek(): Promise<LedgerEvent[]> {
  const week = join(FIXTURES, "sources", "subscription-week");
  const events: LedgerEvent[] = [];
  await importAll(
    {
      append: async (batch) => {
        events.push(...batch);
        return { accepted: batch.map((event) => event.id), duplicates: [] };
      },
    },
    {
      claudeDir: join(week, "claude-code"),
      codexDir: join(week, "codex"),
      since: new Date("2026-10-01T00:00:00Z"),
      actorId: "dev@example.com",
    },
  );
  return events;
}

const share = (events: LedgerEvent[], type: string) =>
  totalSpend(groupSpend(events, { by: ["request_type"] })).groups.find(
    (group) => group.group.request_type === type,
  )?.share;

describe("the OpenTelemetry week where the status line is 16.4% of spend", () => {
  const events = otelWeek();
  const series = groupSpend(events, { by: ["request_type"] });

  it("puts the status line requests in a group of their own", () => {
    expect(share(events, "status_line")).toBeCloseTo(0.164, 3);
    expect(series.days).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
  });

  it("flags the status line on the day it crosses 10%, and nothing else", () => {
    const flags = detectWaste(series);
    expect(flags.map((flag) => [flag.day, flag.request_type])).toEqual([
      ["2026-10-28", "status_line"],
    ]);
    const [flag] = flags;
    expect(flag?.share).toBeGreaterThan(0.1);
    expect(flag?.previous_share).toBeLessThan(0.1);
    expect(flag?.trend.map((point) => point.day)).toEqual(["2026-10-26", "2026-10-27"]);
  });

  it("moves the flag with the threshold", () => {
    expect(detectWaste(series, { shareThreshold: 0.2 }).map((f) => f.day)).toEqual(["2026-10-29"]);
    expect(detectWaste(series, { shareThreshold: 0.5 })).toEqual([]);
  });

  it("groups the same spend by agent, model and person", () => {
    const { total, groups } = totalSpend(
      groupSpend(events, { by: ["request_type", "agent", "model", "person"] }),
    );
    expect(total.usd).toBeCloseTo(totalSpend(series).total.usd, 10);
    expect(new Set(groups.map((g) => g.group.person))).toEqual(
      new Set(["alice@example.com", "bob@example.com", "chen@example.com"]),
    );
    expect(new Set(groups.map((g) => g.group.model))).toEqual(
      new Set(["claude-opus-5-5", "claude-haiku-5-5"]),
    );
    expect(new Set(groups.map((g) => g.group.agent))).toEqual(new Set(["claude_code"]));
  });
});

describe("the subscription week from local logs, with no gateway data", () => {
  let events: LedgerEvent[];

  beforeAll(async () => {
    events = await subscriptionWeek();
  });

  it("estimates every cost from the agents' own logs", () => {
    const costs = events.filter((event) => event.kind === "cost.recorded");
    expect(costs.length).toBeGreaterThan(0);
    expect(new Set(costs.map((event) => event.source))).toEqual(new Set(["local_log"]));
    expect(costs.every((event) => event.cost?.estimated === true)).toBe(true);
    expect(new Set(costs.map((event) => event.agent?.vendor))).toEqual(
      new Set(["claude_code", "codex"]),
    );
  });

  it("flags the growing background type on the day it crosses 10%", () => {
    const series = groupSpend(events, { by: ["request_type"] });
    const flags = detectWaste(series);
    expect(flags.map((flag) => [flag.day, flag.request_type])).toEqual([
      ["2026-10-22", "background"],
    ]);
    const shares = (flags[0]?.trend ?? []).map((point) => point.share);
    expect(shares[0]).toBe(0);
    expect(shares.at(-1)).toBeGreaterThan(0);
    expect(shares.at(-1)).toBeLessThan(0.1);
  });

  it("groups it by agent and model too", () => {
    const { groups } = totalSpend(
      groupSpend(events, { by: ["request_type", "agent", "model", "person"] }),
    );
    expect(
      groups
        .filter((g) => g.group.request_type === "background")
        .map((g) => [g.group.agent, g.group.model, g.group.person]),
    ).toEqual([["codex", "gpt-5.6-luna", "dev@example.com"]]);
  });
});
