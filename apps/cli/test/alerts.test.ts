import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAlarms } from "../src/alerts/alarms.js";
import {
  readCache,
  renderStatusline,
  type StatuslineCache,
  writeCache,
} from "../src/alerts/cache.js";
import { runForecast, runPlan } from "../src/alerts/forecast.js";
import { startMonitor } from "../src/alerts/monitor.js";
import type { AlertIo } from "../src/alerts/settings.js";
import { runStatusline } from "../src/alerts/statusline.js";
import { runImport } from "../src/import.js";
import { createProgram } from "../src/program.js";
import { tempDir } from "./run.js";

const DEV = "dev@example.com";
const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");

let counter = 0;

function cost(
  ts: string,
  usd: number,
  extra: { person?: string; vendor?: "claude_code" | "codex"; data?: object; source?: string } = {},
): LedgerEvent {
  counter++;
  return {
    id: `01930c4e-2f1a-7b2c-8d3e-${counter.toString(16).padStart(12, "0")}`,
    schema: EVENT_SCHEMA,
    ts,
    source: (extra.source ?? "local_log") as LedgerEvent["source"],
    kind: "cost.recorded",
    actor: { kind: "person", id: extra.person ?? DEV },
    agent: { vendor: extra.vendor ?? "claude_code" },
    cost: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usd,
      estimated: true,
    },
    data: { request_type: "main", ...extra.data },
  };
}

/** `usd` an hour in requests every `everyMin` minutes, from `from` to `to`. */
function steady(from: string, to: string, everyMin: number, usdEach: number, extra = {}) {
  const events: LedgerEvent[] = [];
  for (let ms = Date.parse(from); ms < Date.parse(to); ms += everyMin * 60_000) {
    events.push(cost(new Date(ms + 30_000).toISOString(), usdEach, extra));
  }
  return events;
}

/** Two weeks of weekday work, 09:00 to 17:00, $1 per 15 minutes. */
const baseline = (extra = {}) =>
  ["19", "20", "21", "22", "23", "26", "27", "28", "29", "30"].flatMap((day) =>
    steady(`2026-10-${day}T09:00:00Z`, `2026-10-${day}T17:00:00Z`, 5, 1 / 3, extra),
  );

function io(dir: ReturnType<typeof tempDir>, now: string, env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  let code = 0;
  const value: AlertIo = {
    env: { SELFHOST_PERSON: DEV, ...env },
    cwd: dir.root,
    write: (line) => lines.push(line),
    setExitCode: (exit) => {
      code = exit;
    },
    now: new Date(now),
    configPath: dir.path("home", "config.json"),
  };
  return { io: value, lines, code: () => code };
}

describe("commands", () => {
  it("adds forecast, plan and alarms to spend, and a statusline command", () => {
    const program = createProgram();
    const spend = program.commands.find((command) => command.name() === "spend");
    expect(spend?.commands.map((command) => command.name())).toEqual([
      "forecast",
      "plan",
      "alarms",
    ]);
    expect(program.commands.map((command) => command.name())).toContain("statusline");
  });
});

describe("selfhost spend alarms", () => {
  let ledger: Ledger;

  beforeEach(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    await ledger.append(baseline());
  });

  afterEach(async () => {
    await ledger.close();
  });

  it("raises a normal week's spend in one hour as a possible stolen key, once", async () => {
    // A week of this person's spend is about $160; all of it from 10:00 on Monday.
    await ledger.append(steady("2026-11-02T10:00:00Z", "2026-11-02T11:00:00Z", 1, 160 / 60));
    const dir = tempDir("alarms");
    const first = io(dir, "2026-11-02T10:14:59Z");
    const report = await runAlarms({ since: "15m" }, first.io, ledger);
    expect(first.code()).toBe(2);
    expect(report.written).toBe(1);
    expect(report.alarms[0]).toMatchObject({
      kind: "alert.raised",
      source: "cli",
      actor: { kind: "system", id: "selfhost" },
      agent: { vendor: "claude_code" },
      data: {
        alert: "spend_spike",
        label: "possible stolen key",
        category: "security",
        owner: DEV,
        slot_start: "2026-11-02T10:00:00.000Z",
        reason: "above_band",
        actions: [
          {
            id: "rotate_key",
            target: null,
            url: "https://github.com/getselfhostai/selfhost/blob/main/packages/spend/README.md#key-rotation-runbook",
          },
        ],
      },
    });
    expect(first.lines[0]).toMatch(/^SPEND ALARM: 1 possible stolen key alarm/);
    expect(first.lines.join("\n")).toMatch(/Possible stolen key: \$40\.00 in 15 minutes/);
    expect(first.lines.join("\n")).toMatch(/Not a budget warning\./);

    // A rerun in the same slot records nothing new, and still exits 2 for scripts.
    const again = io(dir, "2026-11-02T10:20:00Z");
    const rerun = await runAlarms({ since: "20m", json: true }, again.io, ledger);
    expect(again.code()).toBe(2);
    expect(rerun.alarms.map((alarm) => alarm.data?.slot_start)).toEqual([
      "2026-11-02T10:00:00.000Z",
      "2026-11-02T10:15:00.000Z",
    ]);
    expect([rerun.written, rerun.already_raised]).toEqual([1, 1]);
    expect(JSON.parse(again.lines.join("\n")).schema).toBe("selfhost.spend_alarms/v1");
    const stored = await ledger.query({ kind: "alert.raised" });
    expect(stored.events).toHaveLength(2);
  });

  it("stays quiet on a normal day and under the floor", async () => {
    await ledger.append(steady("2026-11-02T10:00:00Z", "2026-11-02T11:00:00Z", 5, 1 / 3));
    const dir = tempDir("quiet");
    const normal = io(dir, "2026-11-02T11:00:00Z");
    const report = await runAlarms({}, normal.io, ledger);
    expect(report.alarms).toEqual([]);
    expect(normal.code()).toBe(0);
    expect(normal.lines[0]).toMatch(/^No spend spikes from 2026-11-02 10:00 to 11:00 UTC/);
  });

  it("offers to disable the gateway key a spike went through", async () => {
    const gateway = { source: "gateway", data: { gateway: "litellm", key_alias: "ci-bot" } };
    await ledger.append(steady("2026-11-02T03:00:00Z", "2026-11-02T03:15:00Z", 1, 1, gateway));
    const dir = tempDir("gateway");
    dir.write(
      "selfhost.toml",
      'version = 1\n[alerts]\nrunbook_url = "https://wiki.example.com/rotate"\n',
    );
    const run = io(dir, "2026-11-02T03:14:00Z");
    const report = await runAlarms({}, run.io, ledger);
    expect(report.alarms.map((alarm) => alarm.data?.actions)).toEqual([
      [
        {
          id: "rotate_key",
          target: "litellm:ci-bot",
          label: "Rotate litellm:ci-bot: open the key rotation runbook",
          url: "https://wiki.example.com/rotate",
        },
        {
          id: "disable_virtual_key",
          target: "litellm:ci-bot",
          label: "Disable virtual key litellm:ci-bot in the gateway",
        },
      ],
    ]);
    expect(report.alarms[0]?.data?.reason).toBe("no_baseline");
  });
});

describe("the subscription-week fixture, then its week in an hour", () => {
  it("raises in the first 15-minute slot", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const dir = tempDir("fixture-alarm");
      const week = join(FIXTURES, "sources", "subscription-week");
      await runImport(
        {
          claudeDir: join(week, "claude-code"),
          codexDir: join(week, "codex"),
          since: "2026-10-01",
          person: DEV,
        },
        { env: {}, write: () => {}, configPath: dir.path("home", "config.json") },
        ledger,
      );
      const costs = (await ledger.query({ kind: "cost.recorded", limit: 1000 })).events;
      const claude = costs
        .filter((event) => event.agent?.vendor === "claude_code")
        .reduce((sum, event) => sum + (event.cost?.usd ?? 0), 0);
      await ledger.append(steady("2026-10-25T14:00:00Z", "2026-10-25T15:00:00Z", 1, claude / 60));
      // The fixture's whole week is under $2, so its floor is lower than the default $5.
      dir.write("selfhost.toml", "version = 1\n[alerts]\nspike_floor_usd = 0.25\n");
      const run = io(dir, "2026-10-25T14:14:59Z");
      const report = await runAlarms({ since: "15m" }, run.io, ledger);
      expect(report.alarms.map((alarm) => alarm.data?.slot_start)).toEqual([
        "2026-10-25T14:00:00.000Z",
      ]);
      expect(run.code()).toBe(2);
    } finally {
      await ledger.close();
    }
  });
});

describe("selfhost spend forecast and plan", () => {
  let ledger: Ledger;
  const hit: LedgerEvent = {
    id: "01930c4e-2f1a-7b2c-8d3e-00000000ffff",
    schema: EVENT_SCHEMA,
    ts: "2026-10-21T11:00:00Z",
    source: "local_log",
    kind: "alert.raised",
    actor: { kind: "person", id: DEV },
    agent: { vendor: "claude_code" },
    data: { alert: "usage_limit", window: "session" },
  };

  beforeEach(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    // A $20 session up to a limit hit last week; today $15 an hour since 11:00.
    await ledger.append([
      ...steady("2026-10-21T09:00:00Z", "2026-10-21T11:00:00Z", 2, 1 / 3),
      hit,
      ...steady("2026-10-28T11:00:00Z", "2026-10-28T12:00:00Z", 2, 0.5),
    ]);
  });

  afterEach(async () => {
    await ledger.close();
  });

  it("warns once per window, with the basis and a fix", async () => {
    const dir = tempDir("forecast");
    const run = io(dir, "2026-10-28T12:00:00Z");
    const report = await runForecast({}, run.io, ledger);
    expect(report.forecasts.map((forecast) => [forecast.person, forecast.plan])).toEqual([
      [DEV, "claude"],
    ]);
    expect(report.written).toBe(1);
    const text = run.lines.join("\n");
    expect(text).toMatch(/^Plan limits for dev@example\.com, 2026-10-28 12:00 UTC/);
    expect(text).toMatch(
      /Claude\s+5-hour\s+\$15\.00\s+\$20\.00\s+12:20 UTC \(in 20m\)\s+calibrated from 1 limit hit in the logs, latest 2026-10-21/,
    );
    expect(text).toMatch(
      /Warning: Claude 5-hour limit runs out around 12:20 UTC \(in 20m\), before the window resets at 16:00 UTC\./,
    );
    expect(text).toMatch(
      /Fix: Move background work \(subagents, reviews, scheduled runs\) to quieter hours/,
    );
    const [alert] = (await ledger.query({ kind: "alert.raised" })).events.filter(
      (event) => event.data?.alert === "limit_forecast",
    );
    expect(alert?.data).toMatchObject({
      owner: DEV,
      plan: "claude",
      window: "session",
      basis: "calibrated",
      run_out: "2026-10-28T12:20:00.000Z",
    });

    const again = io(dir, "2026-10-28T12:05:00Z");
    expect((await runForecast({ json: true }, again.io, ledger)).written).toBe(0);
    expect(JSON.parse(again.lines.join("\n")).schema).toBe("selfhost.limit_forecast/v1");
  });

  it("uses the tier the person set, and the overflow key from [plans]", async () => {
    const dir = tempDir("tiers");
    const plan = io(dir, "2026-10-28T12:00:00Z");
    const set = runPlan(["claude=max_5x"], {}, plan.io);
    expect(set.tiers).toEqual({ claude: "max_5x" });
    expect(JSON.parse(readFileSync(plan.io.configPath, "utf8"))).toEqual({
      plans: { claude: "max_5x" },
    });
    expect(plan.lines[0]).toBe("Claude: max_5x");
    expect(() => runPlan(["claude=max_9x"], {}, plan.io)).toThrow(/Unknown claude tier "max_9x"/);
    expect(() => runPlan(["gemini=pro"], {}, plan.io)).toThrow(/--plan: expected plan=tier/);

    dir.write(
      "selfhost.toml",
      [
        "version = 1",
        "[plans]",
        'as_of = "2026-11-05"',
        "[plans.claude.max_5x]",
        "weekly_usd = 20",
        "[plans.overflow]",
        'key = "team-overflow"',
        "monthly_cap_usd = 500",
      ].join("\n"),
    );
    await ledger.close();
    ledger = await openLedger({ dataDir: "memory://" });
    await ledger.append(steady("2026-10-28T11:00:00Z", "2026-10-28T12:00:00Z", 2, 0.5));
    const run = io(dir, "2026-10-28T12:00:00Z");
    const report = await runForecast({ json: true }, run.io, ledger);
    const [claude] = report.forecasts;
    expect(claude?.tier).toBe("max_5x");
    expect(
      claude?.windows.map((window) => [window.window, window.limit_usd, window.basis_label]),
    ).toEqual([
      ["session", 50, "max_5x, built-in table as of 2026-11-01"],
      ["weekly", 20, "max_5x, selfhost.toml [plans] as of 2026-11-05"],
    ]);
    expect(claude?.suggestion).toEqual({
      kind: "overflow",
      key: "team-overflow",
      left_usd: 500,
      cap_usd: 500,
    });

    const flag = io(dir, "2026-10-28T12:00:00Z");
    const pro = await runForecast({ plan: "claude=max_20x", json: true }, flag.io, ledger);
    expect(pro.forecasts[0]?.tier).toBe("max_20x");
  });
});

describe("selfhost statusline", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const base: StatuslineCache = {
    schema: "selfhost.statusline/v1",
    written_at: "2026-10-28T11:59:00.000Z",
    pid: null,
    person: DEV,
    today: { day: "2026-10-28", usd: 12.345 },
    warnings: [],
    alarms: [],
  };

  it("prints spend today, else a limit about to run out, else an alarm", () => {
    expect(renderStatusline(base, now)).toBe("selfhost: $12.35 today");
    expect(renderStatusline({ ...base, today: { day: "2026-10-27", usd: 9 } }, now)).toBe(
      "selfhost: $0.00 today",
    );
    const warning = {
      plan: "claude" as const,
      window: "session" as const,
      status: "warn" as const,
      run_out: "2026-10-28T13:40:00.000Z",
      window_end: "2026-10-28T16:00:00.000Z",
      fix: "overflow to team-overflow",
    };
    expect(renderStatusline({ ...base, warnings: [warning] }, now)).toBe(
      "Claude 5h limit in ~1h40m · overflow to team-overflow",
    );
    expect(
      renderStatusline({ ...base, warnings: [{ ...warning, status: "reached", fix: "" }] }, now),
    ).toBe("Claude 5h limit reached, resets in 4h00m");
    const alarm = {
      slot_start: "2026-10-28T11:30:00.000Z",
      slot_end: "2026-10-28T11:45:00.000Z",
      usd: 412.5,
      on: "dev@example.com, claude_code",
    };
    expect(renderStatusline({ ...base, warnings: [warning], alarms: [alarm] }, now)).toBe(
      "selfhost: possible stolen key, $412.50 in 15 min on dev@example.com, claude_code",
    );
  });

  /** A ledger that fails the test if the statusline opens it. */
  const untouchable = {
    query: () => {
      throw new Error("the statusline opened the ledger");
    },
  } as unknown as Ledger;

  it("reads the cache a running watcher keeps, without opening the ledger", async () => {
    const dir = tempDir("statusline");
    const run = io(dir, now.toISOString());
    const cache = dir.path("statusline.json");
    // Old, but its watcher (this process) is alive.
    writeCache(cache, { ...base, written_at: "2026-10-28T08:00:00.000Z", pid: process.pid });
    const line = await runStatusline({ cache, refresh: true }, run.io, untouchable);
    expect(line).toBe("selfhost: $12.35 today");
    expect(run.lines).toEqual([line]);
  });

  it("recomputes a stale cache from the ledger and keeps the result", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      await ledger.append(steady("2026-10-28T11:00:00Z", "2026-10-28T12:00:00Z", 2, 0.5));
      const dir = tempDir("statusline-stale");
      const run = io(dir, now.toISOString());
      const cache = dir.path("statusline.json");
      writeCache(cache, { ...base, written_at: "2026-10-28T08:00:00.000Z", pid: 999_999_999 });
      const line = await runStatusline({ cache, plan: "claude=max_5x" }, run.io, ledger);
      expect(line).toBe("Claude 5h limit in ~2h20m · move background work to 00-04 UTC");
      expect(readCache(cache)).toMatchObject({
        written_at: now.toISOString(),
        pid: null,
        today: { day: "2026-10-28", usd: 15 },
      });
    } finally {
      await ledger.close();
    }
  });

  it("says there is no data instead of failing", async () => {
    const dir = tempDir("statusline-empty");
    const run = io(dir, now.toISOString());
    const line = await runStatusline({ cache: dir.path("none.json") }, run.io, untouchable);
    expect(line).toBe("selfhost: no data yet, run selfhost import");
    expect(run.code()).toBe(0);
    await expect(
      runStatusline({ cache: dir.path("none.json"), plan: "claude" }, run.io, untouchable),
    ).rejects.toThrow(/--plan: expected plan=tier/);
  });
});

describe("the import --watch monitor", () => {
  it("raises the alarm right after the batch with the spike lands", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      await ledger.append(baseline());
      const dir = tempDir("monitor");
      const lines: string[] = [];
      let clock = new Date("2026-11-02T09:59:00Z");
      const cachePath = dir.path("statusline.json");
      const monitor = await startMonitor(ledger, {
        person: DEV,
        env: {},
        configPath: dir.path("home", "config.json"),
        cwd: dir.root,
        write: (line) => lines.push(line),
        cachePath,
        now: () => clock,
        minIntervalMs: 0,
      });
      expect(lines).toEqual([]);
      expect(readCache(cachePath)?.pid).toBe(process.pid);

      // The watcher writes a batch: $40 in the first 5 minutes after 10:00.
      const writer = monitor.tap(ledger);
      await writer.append(steady("2026-11-02T10:00:00Z", "2026-11-02T10:05:00Z", 1, 8));
      clock = new Date("2026-11-02T10:05:00Z");
      monitor.check();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await monitor.close();

      expect(lines[0]).toMatch(
        /^SPEND ALARM: Possible stolen key: \$40\.00 in 15 minutes \(10:00-10:15 UTC/,
      );
      const alerts = (await ledger.query({ kind: "alert.raised" })).events;
      expect(alerts.map((event) => event.data?.alert)).toEqual(["spend_spike"]);
      expect(readCache(cachePath)?.alarms).toHaveLength(1);
    } finally {
      await ledger.close();
    }
  });
});

describe("credentials", () => {
  it("stores no credential fields in the alerts it writes", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const gateway = { source: "gateway", data: { gateway: "litellm", key_alias: "ci-bot" } };
      await ledger.append([
        ...steady("2026-10-28T11:00:00Z", "2026-10-28T12:00:00Z", 1, 1, gateway),
        ...steady("2026-10-28T11:00:00Z", "2026-10-28T12:00:00Z", 2, 0.5),
      ]);
      const dir = tempDir("credentials");
      writeFileSync(dir.path("selfhost.toml"), "version = 1\n");
      await runAlarms({}, io(dir, "2026-10-28T12:00:00Z").io, ledger);
      await runForecast({ plan: "claude=max_5x" }, io(dir, "2026-10-28T12:00:00Z").io, ledger);
      const alerts = (await ledger.query({ kind: "alert.raised" })).events;
      expect(new Set(alerts.map((event) => event.data?.alert))).toEqual(
        new Set(["spend_spike", "limit_forecast"]),
      );
      const keys = (value: unknown): string[] =>
        typeof value !== "object" || value === null
          ? []
          : Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)]);
      const names = alerts.flatMap((event) => keys(event));
      expect(
        names.filter((name) => /token|secret|password|credential|auth|cookie/i.test(name)),
      ).toEqual([]);
    } finally {
      await ledger.close();
    }
  });
});
