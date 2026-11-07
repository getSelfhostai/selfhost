import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import type { LedgerEvent } from "@selfhost/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETENTION_INTERVAL_MS, serverConfig, startRetentionJob } from "../src/retention.js";

const DAY = 86_400_000;
const NOW = new Date("2026-11-08T12:00:00.000Z");

const aged = (n: number, days: number): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-8d3e-${n.toString(16).padStart(12, "0")}`,
  schema: "selfhost.event/v1",
  ts: new Date(NOW.getTime() - days * DAY).toISOString(),
  source: "hook",
  kind: "session.started",
  actor: { kind: "person", id: "alice@example.com" },
});

describe("serverConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "selfhost-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the selfhost.toml defaults without SELFHOST_CONFIG", () => {
    expect(serverConfig({}).ledger).toEqual({ retention_days: 90, log_prompts: false });
  });

  it("reads SELFHOST_CONFIG", () => {
    const path = join(dir, "selfhost.toml");
    writeFileSync(
      path,
      'version = 1\n[ledger]\nretention_days = 30\n[[redaction]]\nname = "ticket"\npattern = "T-[0-9]+"\n',
    );
    const config = serverConfig({ SELFHOST_CONFIG: path });
    expect(config.ledger.retention_days).toBe(30);
    expect(config.redaction).toEqual([{ name: "ticket", pattern: "T-[0-9]+" }]);
  });

  it("refuses an invalid SELFHOST_CONFIG, naming the line", () => {
    const path = join(dir, "selfhost.toml");
    writeFileSync(path, "version = 1\n[ledger]\nretention_days = 0\n");
    expect(() => serverConfig({ SELFHOST_CONFIG: path })).toThrow(
      `${path}:3: ledger.retention_days`,
    );
  });
});

describe("startRetentionJob", () => {
  let ledger: Ledger;

  beforeEach(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await ledger.close();
  });

  const ids = async () => (await ledger.query({})).events.map((event) => event.id);

  it("sweeps on start, then once a day until stopped", async () => {
    await ledger.append([aged(1, 40), aged(2, 20), aged(3, 1)]);
    let now = NOW;
    const log: string[] = [];
    const job = startRetentionJob(ledger, { days: 30, now: () => now, log: (l) => log.push(l) });

    expect(await job.run()).toMatchObject({ deleted: 1 });
    expect(await ids()).toEqual([aged(3, 1).id, aged(2, 20).id]);
    expect(log).toEqual(["retention: deleted 1 expired events"]);

    now = new Date(NOW.getTime() + 15 * DAY);
    vi.advanceTimersByTime(RETENTION_INTERVAL_MS);
    expect(await job.run()).toMatchObject({ deleted: 1 });
    expect(await ids()).toEqual([aged(3, 1).id]);

    job.stop();
    now = new Date(NOW.getTime() + 60 * DAY);
    vi.advanceTimersByTime(10 * RETENTION_INTERVAL_MS);
    expect(await ids()).toEqual([aged(3, 1).id]);
  });

  it("logs a failed sweep instead of throwing", async () => {
    const log: string[] = [];
    const job = startRetentionJob(ledger, { days: 0, log: (l) => log.push(l) });
    expect(await job.run()).toBeUndefined();
    expect(log).toEqual([
      "retention: sweep failed: Retention days: expected a whole number of 1 or more, got 0",
    ]);
    job.stop();
  });
});
