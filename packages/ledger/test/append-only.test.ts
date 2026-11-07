import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db.js";
import { openLedger } from "../src/ledger.js";
import { MIGRATIONS } from "../src/migrations.generated.js";
import { BACKENDS, makeEvent, type Store } from "./helpers.js";

describe.each(BACKENDS)("append-only events table on $name", (backend) => {
  let store: Store;
  const event = makeEvent(1, { actor: { kind: "person", id: "keep@example.com" } });

  beforeAll(async () => {
    if (backend.skip) return;
    store = await backend.open();
    await store.ledger.append([event]);
  });

  afterAll(async () => {
    await store?.close();
  });

  const stored = async () => (await store.ledger.query({ person: "keep@example.com" })).events;
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => "no error",
      (error: Error) => error.message,
    );

  it.skipIf(backend.skip).each([
    ["UPDATE", "UPDATE events SET kind = 'session.ended'"],
    ["DELETE", "DELETE FROM events"],
    ["TRUNCATE", "TRUNCATE events"],
  ])("blocks %s", async (op, sql) => {
    expect(await failure(store.db.query(sql))).toContain(
      `ledger events are append-only: ${op} is not allowed`,
    );
    expect(await stored()).toEqual([event]);
  });

  it.skipIf(backend.skip)("blocks UPDATE and DELETE inside a transaction too", async () => {
    const attempt = store.db.transaction(async (tx) => {
      await tx.query('UPDATE events SET body = body || \'{"kind":"session.ended"}\'::jsonb');
    });
    expect(await failure(attempt)).toContain("append-only");
    expect(await stored()).toEqual([event]);
  });

  it.skipIf(backend.skip)("allows the retention job, which sets selfhost.retention", async () => {
    const doomed = makeEvent(2, { actor: { kind: "person", id: "expired@example.com" } });
    await store.ledger.append([doomed]);
    const deleted = await store.db.transaction(async (tx) => {
      await tx.query("SET LOCAL selfhost.retention = 'on'");
      return tx.query("DELETE FROM events WHERE actor_id = $1 RETURNING id", [doomed.actor.id]);
    });
    expect(deleted).toHaveLength(1);
    // SET LOCAL ends with the transaction, so the next statement is blocked again.
    expect(await failure(store.db.query("DELETE FROM events"))).toContain("append-only");
    expect(await stored()).toEqual([event]);
  });

  it.skipIf(backend.skip)("records migrations and applies each once", async () => {
    const rows = await store.db.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(rows.map((row) => row.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(await migrate(store.db)).toEqual([]);
  });
});

describe("embedded ledger on disk", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "selfhost-ledger-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps events across restarts", async () => {
    const event = makeEvent(1);
    const first = await openLedger({ dataDir: join(dir, "data") });
    await first.append([event]);
    await first.close();
    const second = await openLedger({ dataDir: join(dir, "data") });
    expect((await second.query({})).events).toEqual([event]);
    expect(await second.append([event])).toEqual({ accepted: [], duplicates: [event.id] });
    await second.close();
  });

  it("refuses database urls it cannot use", async () => {
    await expect(openLedger({ url: "mysql://localhost/selfhost" })).rejects.toThrow(
      "Unsupported database url",
    );
  });
});
