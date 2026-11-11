import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ledger, mapOtelLogs, openLedger } from "@selfhost/ledger";
import {
  type CreateTeamResponse,
  EVENT_SCHEMA,
  type JoinResponse,
  type LedgerEvent,
} from "@selfhost/schema";
import { createApp } from "@selfhost/server/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runImport } from "../src/import.js";
import { createProgram } from "../src/program.js";
import { parseBy, parseThreshold, runSpend, type TeamSpendReport } from "../src/spend.js";

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
      "--local",
      "--config",
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
      // A config path that does not exist: solo mode, never the real ~/.selfhost.
      {
        env: {},
        write: () => {},
        configPath: join(tmpdir(), "selfhost-spend-none", "config.json"),
      },
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
    expect(lines[1]).toMatch(/^request_type\s+requests\s+tokens\s+usd\s+share\s+cache hits$/);
    expect(
      lines.some((line) =>
        /^status_line\s+\d+\s+[\d.]+[kM]\s+\$\d+\.\d\d\s+16\.4%\s+\d+\.\d%$/.test(line),
      ),
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

describe("selfhost spend cache hit rates", () => {
  let ledger: Ledger;
  let n = 0;
  const request = (
    session: string,
    vendor: "claude_code" | "cursor",
    tokens: { input: number; read?: number; write?: number },
    usd: number,
  ): LedgerEvent => ({
    id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
    schema: EVENT_SCHEMA,
    ts: new Date(Date.UTC(2026, 10, 8, 10, 0) + n * 60_000).toISOString(),
    source: "local_log",
    kind: "cost.recorded",
    actor: { kind: "person", id: "ada@example.com" },
    agent: { vendor },
    model: vendor === "cursor" ? "gpt-5" : "claude-sonnet-4-5",
    session_id: session,
    cost: {
      input_tokens: tokens.input,
      output_tokens: 100,
      cache_read_tokens: tokens.read ?? 0,
      cache_write_tokens: tokens.write ?? 0,
      usd,
      estimated: true,
    },
  });

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    await ledger.append([
      // Warm: written once, then read.
      request("warm-session", "claude_code", { input: 100, write: 9000 }, 0.1),
      ...Array.from({ length: 5 }, () =>
        request("warm-session", "claude_code", { input: 100, read: 9000 }, 0.05),
      ),
      // Rewrites its cache on every request, and costs enough for a tip.
      ...Array.from({ length: 6 }, () =>
        request("churn-session", "claude_code", { input: 100, write: 9000 }, 1.5),
      ),
      // An agent whose logs carry no cache fields.
      ...Array.from({ length: 3 }, () => request("cursor-1", "cursor", { input: 5000 }, 0.4)),
    ]);
  });

  afterAll(async () => {
    await ledger.close();
  });

  const run = async (options: Parameters<typeof runSpend>[0], io: { configPath?: string } = {}) => {
    const lines: string[] = [];
    const report = await runSpend(
      options,
      { env: {}, write: (line) => lines.push(line), now: new Date("2026-11-09T00:00:00Z"), ...io },
      ledger,
    );
    return { report, lines };
  };

  it("shows a rate per agent, unknown for one with no cache fields, and one tip line", async () => {
    const { report, lines } = await run({ since: "2d", by: "agent" });
    const agent = (name: string) => report.groups.find((g) => g.group.agent === name);
    expect(agent("cursor")).toMatchObject({ cache_hit_rate: null, cache_unknown_requests: 3 });
    const read = 5 * 9000;
    expect(agent("claude_code")?.cache_hit_rate).toBeCloseTo(read / (read + 1200 + 7 * 9000), 9);
    expect(report.total.cache_hit_rate).toBe(agent("claude_code")?.cache_hit_rate);
    expect(report.cache_tips.map((tip) => [tip.session_id, tip.cache_hit_rate])).toEqual([
      ["churn-session", 0],
    ]);
    expect(lines.some((line) => /^cursor\s.*\sunknown$/.test(line))).toBe(true);
    const tips = lines.filter((line) => line.startsWith("Cost tip: "));
    expect(tips).toEqual([
      "Cost tip: Session churn-se (claude_code, ada@example.com) cost $9.00 at 0% cache hits: usually a value that changes early in the prompt (such as a timestamp), tool lists that reorder, or a model switch.",
    ]);
  });

  it("puts the same in --json, with the thresholds from [alerts]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "selfhost-spend-cache-"));
    const config = join(dir, "selfhost.toml");
    writeFileSync(config, "version = 1\n\n[alerts]\ncache_hit_floor = 0.9\ncache_tip_usd = 0.3\n");
    const { report, lines } = await run(
      { since: "2d", by: "agent", json: true, config },
      { configPath: join(dir, "config.json") },
    );
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.cache_hit_floor).toBe(0.9);
    expect(parsed.cache_tip_usd).toBe(0.3);
    expect(parsed.cache_tips.map((tip: { session_id: string }) => tip.session_id)).toEqual([
      "churn-session",
      "warm-session",
    ]);
    expect(
      parsed.groups.find((g: { group: { agent: string } }) => g.group.agent === "cursor"),
    ).toMatchObject({ cache_hit_rate: null });
    expect(report.cache_tips).toHaveLength(2);
  });
});

describe("selfhost spend in a team", () => {
  it("reads the team's spend and budget from the server, not the empty local ledger", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      // Relative to the run, so the spend is inside every window whenever it runs.
      const now = new Date();
      const app = createApp({ version: "test", ledger, token: "admin-token", now: () => now });
      const created = (await (
        await app.request("/v1/teams", {
          method: "POST",
          headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
          body: JSON.stringify({ name: "Web" }),
        })
      ).json()) as CreateTeamResponse;
      const member = async (person: string) =>
        (
          (await (
            await app.request("/v1/join", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ invite: created.invite, person }),
            })
          ).json()) as JoinResponse
        ).token;
      const lead = await member("lead@example.com");
      const dev = await member("dev@example.com");
      const cost = (usd: number, hoursAgo: number): LedgerEvent => ({
        id: `01930c4e-2f1a-7b2c-9d3e-${Math.round(usd * 100)
          .toString(16)
          .padStart(12, "0")}`,
        schema: EVENT_SCHEMA,
        ts: new Date(now.getTime() - hoursAgo * 3_600_000).toISOString(),
        source: "local_log",
        kind: "cost.recorded",
        actor: { kind: "person", id: "dev@example.com" },
        session_id: "s-team",
        agent: { vendor: "claude_code" },
        model: "claude-sonnet-4-5",
        cost: {
          input_tokens: 1000,
          output_tokens: 100,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          usd,
          estimated: true,
        },
      });
      // The member syncs; the lead's laptop has nothing in its own ledger.
      const synced = await app.request("/v1/events", {
        method: "POST",
        headers: { authorization: `Bearer ${dev}`, "content-type": "application/json" },
        body: JSON.stringify({ events: [cost(1.5, 2), cost(2.25, 30)] }),
      });
      expect(synced.status).toBe(200);

      const server = "https://selfhost.acme.example.com";
      const dir = mkdtempSync(join(tmpdir(), "selfhost-spend-team-"));
      const configPath = join(dir, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({ server, token: lead, person: "lead@example.com", team: "web" }),
      );
      const lines: string[] = [];
      const fetch = (url: string, init: RequestInit) =>
        Promise.resolve(app.request(url.replace(server, ""), init));
      const io = { env: {}, write: (line: string) => lines.push(line), now, configPath, fetch };

      const report = (await runSpend({ since: "7d" }, io)) as TeamSpendReport;
      expect(report.schema).toBe("selfhost.team_spend/v1");
      expect(report.usage.total.usd).toBeCloseTo(3.75);
      expect(report.usage.rows.map((row) => [row.group.person, row.usd])).toEqual([
        ["dev@example.com", 3.75],
      ]);
      expect(report.budget.spent_usd).toBeGreaterThan(0);
      expect(lines[0]).toMatch(/^Spend of team web on https:\/\/selfhost\.acme\.example\.com/);
      expect(lines.join("\n")).toContain("dev@example.com");
      expect(lines.join("\n")).not.toContain("Run selfhost import first");

      // Request types are a laptop's own: the server has none, so --by names --local.
      await expect(runSpend({ by: "request_type" }, io)).rejects.toThrow(/--local/);
    } finally {
      await ledger.close();
    }
  });
});
