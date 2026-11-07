import { mkdirSync, writeFileSync } from "node:fs";
import { openLedger } from "@selfhost/ledger";
import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runAlarms } from "../src/alerts/alarms.js";
import { runForecast, runPlan } from "../src/alerts/forecast.js";
import { startMonitor } from "../src/alerts/monitor.js";
import type { AlertIo } from "../src/alerts/settings.js";
import { runStatusline } from "../src/alerts/statusline.js";
import { tempDir } from "./run.js";

/** Every path the code under test opens, reads, lists or checks, through node:fs. */
const { touched, READS } = vi.hoisted(() => ({
  touched: [] as string[],
  READS: [
    "readFileSync",
    "readFile",
    "existsSync",
    "statSync",
    "lstatSync",
    "openSync",
    "open",
    "createReadStream",
    "readdirSync",
    "readdir",
    "accessSync",
    "access",
    "stat",
  ],
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = { ...fs };
  for (const name of READS) {
    const original = fs[name];
    if (typeof original !== "function") continue;
    wrapped[name] = (...args: unknown[]) => {
      touched.push(String(args[0]));
      return original(...args);
    };
  }
  return { ...wrapped, default: wrapped };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = { ...fs };
  for (const name of READS) {
    const original = fs[name];
    if (typeof original !== "function") continue;
    wrapped[name] = (...args: unknown[]) => {
      touched.push(String(args[0]));
      return original(...args);
    };
  }
  return { ...wrapped, default: wrapped };
});

const DEV = "dev@example.com";

function cost(ts: string, usd: number, n: number): LedgerEvent {
  return {
    id: `01930c4e-2f1a-7b2c-8d3e-${n.toString(16).padStart(12, "0")}`,
    schema: EVENT_SCHEMA,
    ts,
    source: "local_log",
    kind: "cost.recorded",
    actor: { kind: "person", id: DEV },
    agent: { vendor: "claude_code" },
    cost: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usd,
      estimated: true,
    },
  };
}

describe("the forecast, the statusline and the alarms never touch vendor credentials", () => {
  const home = tempDir("home");
  const previousHome = process.env.HOME;
  const credentialFiles = [
    home.write(".claude/.credentials.json", '{"claudeAiOauth":{"accessToken":"fake"}}'),
    home.write(".claude.json", '{"oauthAccount":{"emailAddress":"dev@example.com"}}'),
    home.write(".codex/auth.json", '{"tokens":{"access_token":"fake"}}'),
  ];

  beforeAll(() => {
    // Anything that looked in the real home directory would look here instead.
    process.env.HOME = home.root;
  });

  afterAll(() => {
    process.env.HOME = previousHome;
  });

  it("reads only the ledger, selfhost's own files and selfhost.toml", async () => {
    const dir = tempDir("audit");
    mkdirSync(dir.path("home"), { recursive: true });
    writeFileSync(dir.path("selfhost.toml"), "version = 1\n");
    const io: AlertIo = {
      env: { SELFHOST_PERSON: DEV, HOME: home.root },
      cwd: dir.root,
      write: () => {},
      setExitCode: () => {},
      now: new Date("2026-10-28T12:00:00Z"),
      configPath: dir.path("home", "config.json"),
    };
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      await ledger.append(
        Array.from({ length: 60 }, (_, n) =>
          cost(new Date(Date.parse("2026-10-28T11:00:00Z") + n * 60_000).toISOString(), 0.5, n + 1),
        ),
      );
      touched.length = 0;
      runPlan(["claude=max_5x"], {}, io);
      await runForecast({}, io, ledger);
      await runAlarms({}, io, ledger);
      await runStatusline({ refresh: true }, io, ledger);
      const monitor = await startMonitor(ledger, {
        person: DEV,
        env: io.env,
        cwd: io.cwd,
        write: io.write,
        configPath: io.configPath,
        now: () => new Date("2026-10-28T12:00:00Z"),
      });
      await monitor.close();

      expect(touched.length).toBeGreaterThan(0);
      for (const file of credentialFiles) expect(touched).not.toContain(file);
      expect(touched.filter((path) => path.startsWith(home.root))).toEqual([]);
      expect(touched.filter((path) => /credential|auth\.json|\.claude\.json/i.test(path))).toEqual(
        [],
      );
      expect(
        [...new Set(touched)].every(
          (path) => path.startsWith(dir.root) || path.endsWith("selfhost.toml"),
        ),
      ).toBe(true);
      // The forecast did run: the tier came from selfhost's own config file.
      const alerts = (await ledger.query({ kind: "alert.raised" })).events;
      expect(alerts.map((event) => event.data?.alert).sort()).toEqual([
        "limit_forecast",
        "spend_spike",
        "spend_spike",
        "spend_spike",
        "spend_spike",
      ]);
    } finally {
      await ledger.close();
    }
  });
});
