import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retentionSweep } from "../src/retention.js";
import { BACKENDS, makeEvent, type Store } from "./helpers.js";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const DAY = 86_400_000;

/** An event `days` days before NOW. */
const aged = (n: number, days: number, team?: string) =>
  makeEvent(n, {
    ts: new Date(NOW.getTime() - days * DAY).toISOString(),
    ...(team ? { team } : {}),
  });

describe.each(BACKENDS)("retentionSweep on $name", (backend) => {
  let store: Store;

  beforeEach(async () => {
    if (backend.skip) return;
    store = await backend.open();
  });

  afterEach(async () => {
    await store?.close();
  });

  const ids = async () => (await store.ledger.query({ limit: 1000 })).events.map((e) => e.id);

  it.skipIf(backend.skip)("deletes backdated events older than the retention", async () => {
    const old = [aged(1, 400), aged(2, 91), aged(3, 90.01)];
    const kept = [aged(4, 89.99), aged(5, 10), aged(6, 0)];
    await store.ledger.append([...old, ...kept]);

    const result = await retentionSweep(store.ledger, 90, NOW);
    expect(result).toEqual({
      deleted: 3,
      before: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      teams: {},
    });
    expect((await ids()).sort()).toEqual(kept.map((e) => e.id).sort());
    expect((await retentionSweep(store.ledger, 90, NOW)).deleted).toBe(0);
  });

  it.skipIf(backend.skip)("ends the retention guard with its transaction", async () => {
    await store.ledger.append([aged(1, 100), aged(2, 1)]);
    expect((await retentionSweep(store.ledger, 30, NOW)).deleted).toBe(1);
    await expect(store.db.query("DELETE FROM events")).rejects.toThrow(
      "ledger events are append-only: DELETE is not allowed",
    );
    const [setting] = await store.db.query<{ value: string | null }>(
      "SELECT current_setting('selfhost.retention', true) AS value",
    );
    expect(setting?.value ?? "").not.toBe("on");
    expect(await ids()).toEqual([aged(2, 1).id]);
  });

  it.skipIf(backend.skip)("uses a team's stored retention_days for its events", async () => {
    await store.ledger.teams.createTeam({ id: "short", name: "Short" });
    await store.ledger.teams.setPolicy("short", "version = 1\n[ledger]\nretention_days = 7\n");
    await store.ledger.teams.createTeam({ id: "plain", name: "Plain" });
    await store.ledger.teams.setPolicy("plain", "version = 1\n");
    await store.ledger.append([
      aged(1, 8, "short"),
      aged(2, 6, "short"),
      aged(3, 8),
      aged(4, 8, "no-policy"),
      aged(5, 91, "plain"),
      aged(6, 31),
    ]);
    const result = await retentionSweep(store.ledger, 30, NOW);
    expect(result.teams).toEqual({
      short: new Date(NOW.getTime() - 7 * DAY).toISOString(),
      plain: new Date(NOW.getTime() - 90 * DAY).toISOString(),
    });
    expect(result.deleted).toBe(3);
    expect((await ids()).sort()).toEqual([aged(2, 6).id, aged(3, 8).id, aged(4, 8).id].sort());
  });

  it.skipIf(backend.skip)("refuses a retention that is not a whole number of days", async () => {
    await expect(retentionSweep(store.ledger, 0, NOW)).rejects.toThrow(RangeError);
    await expect(retentionSweep(store.ledger, 1.5, NOW)).rejects.toThrow(RangeError);
  });

  it.skipIf(backend.skip)("handles a retention longer than the calendar", async () => {
    await store.ledger.append([aged(1, 400)]);
    expect((await retentionSweep(store.ledger, 10_000_000, NOW)).deleted).toBe(0);
  });
});
