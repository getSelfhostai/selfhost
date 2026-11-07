import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, mapOtelLogs, openLedger } from "@selfhost/ledger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runImport } from "../src/import.js";
import { createProgram } from "../src/program.js";
import { parseBy, parseThreshold, runSpend } from "../src/spend.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const week = join(fixtures, "sources", "subscription-week");

function otelWeek() {
  return readFileSync(join(fixtures, "sources", "otel", "claude-code-week.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

describe("spend options", () => {
  it("reads dimensions and thresholds", () => {
    expect(parseBy(undefined)).toEqual(["request_type"]);
    expect(parseBy("request_type, model,Person")).toEqual(["request_type", "model", "person"]);
    expect(() => parseBy("repo")).toThrow(/--by/);
    expect(parseThreshold("12.5")).toBe(0.125);
    expect(parseThreshold(undefined)).toBe(0.1);
    expect(() => parseThreshold("0")).toThrow(/--threshold/);
    expect(() => parseThreshold("ten")).toThrow(/--threshold/);
  });

  it("is registered on the program", () => {
    const spend = createProgram().commands.find((command) => command.name() === "spend");
    expect(spend?.options.map((option) => option.long)).toEqual([
      "--since",
      "--by",
      "--threshold",
      "--min-usd",
      "--json",
      "--database",
      "--data-dir",
    ]);
  });
});

describe("selfhost spend", () => {
  let ledger: Ledger;

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    await runImport(
      {
        claudeDir: join(week, "claude-code"),
        codexDir: join(week, "codex"),
        since: "2026-10-01",
        person: "dev@example.com",
      },
      { env: {}, write: () => {} },
      ledger,
    );
    await ledger.append(mapOtelLogs(otelWeek()));
  });

  afterAll(async () => {
    await ledger.close();
  });

  const run = async (options: Parameters<typeof runSpend>[0], now: string) => {
    const lines: string[] = [];
    const report = await runSpend(
      options,
      { env: {}, write: (line) => lines.push(line), now: new Date(now) },
      ledger,
    );
    return { report, lines };
  };

  it("prints a table and flags the status line in the OpenTelemetry week", async () => {
    const { report, lines } = await run({ since: "2026-10-26" }, "2026-11-01T23:00:00Z");
    expect(report).toMatchObject({ from: "2026-10-26", to: "2026-11-01", threshold: 0.1 });
    expect(report.flags.map((flag) => [flag.day, flag.request_type])).toEqual([
      ["2026-10-28", "status_line"],
    ]);
    const status = report.groups.find((group) => group.group.request_type === "status_line");
    expect(status?.share).toBeCloseTo(0.164, 3);
    expect(lines[0]).toBe("Spend from 2026-10-26 to 2026-11-01 (UTC days), by request_type");
    expect(lines[1]).toMatch(/^request_type\s+requests\s+tokens\s+usd\s+share$/);
    expect(
      lines.some((line) => /^status_line\s+\d+\s+[\d.]+[kM]\s+\$\d+\.\d\d\s+16\.4%$/.test(line)),
    ).toBe(true);
    expect(lines).toContain("Flagged: request types that crossed 10.0% of a day's spend");
    expect(lines.at(-1)).toMatch(/^ {2}2026-10-28 {2}status_line {2}16\.5% of \$/);
  });

  it("flags the background type in the subscription week, as JSON", async () => {
    const { report, lines } = await run(
      { since: "7d", by: "request_type,agent", json: true },
      "2026-10-25T20:00:00Z",
    );
    expect(report.from).toBe("2026-10-18");
    expect(report.flags.map((flag) => [flag.day, flag.request_type])).toEqual([
      ["2026-10-22", "background"],
    ]);
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.by).toEqual(["request_type", "agent"]);
    expect(parsed.flags).toEqual(JSON.parse(JSON.stringify(report.flags)));
    expect(parsed.groups.map((g: { group: object }) => g.group)).toContainEqual({
      request_type: "background",
      agent: "codex",
    });
  });

  it("still flags by request type when grouping by something else", async () => {
    const { report } = await run(
      { since: "2026-10-26", by: "person", threshold: "20" },
      "2026-11-01T23:00:00Z",
    );
    expect(report.groups.map((group) => group.group.person).sort()).toEqual([
      "alice@example.com",
      "bob@example.com",
      "chen@example.com",
    ]);
    expect(report.flags.map((flag) => [flag.day, flag.request_type])).toEqual([
      ["2026-10-29", "status_line"],
    ]);
  });

  it("says so when there is nothing to show", async () => {
    const { report, lines } = await run({ since: "1d" }, "2026-12-01T00:00:00Z");
    expect(report.total.requests).toBe(0);
    expect(lines).toEqual([
      "Spend from 2026-11-30 to 2026-12-01 (UTC days), by request_type",
      "No cost.recorded events in this window. Run selfhost import first.",
    ]);
  });
});
