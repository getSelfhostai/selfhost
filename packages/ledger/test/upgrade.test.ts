import { describe, expect, it } from "vitest";
import { seedLedger } from "../../../fixtures/ledger/seed.js";
import {
  type Database,
  migrate,
  type Queryable,
  resolveVersion,
  rollback,
  rowCounts,
  SchemaTooNewError,
  schemaStatus,
} from "../src/db.js";
import { createLedger } from "../src/ledger.js";
import { MIGRATIONS, type Migration } from "../src/migrations.generated.js";
import { BACKENDS, makeEvent } from "./helpers.js";

const versions = MIGRATIONS.map((m) => m.version);
const LATEST = versions.at(-1) as string;

/** Tables, columns, indexes, constraints, triggers and functions of the current schema. */
async function schemaOf(db: Queryable): Promise<string[]> {
  const rows = await db.query<{ line: string }>(`
    SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' ||
      is_nullable || ' ' || coalesce(column_default, '') AS line
    FROM information_schema.columns WHERE table_schema = current_schema()
    UNION ALL
    SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = current_schema()
    UNION ALL
    SELECT 'constraint ' || c.conrelid::regclass::text || ' ' || c.conname || ' ' ||
      pg_get_constraintdef(c.oid)
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = current_schema()
    UNION ALL
    SELECT 'trigger ' || t.tgrelid::regclass::text || ' ' || t.tgname || ' ' || t.tgenabled::text
    FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname = current_schema()
    UNION ALL
    SELECT 'function ' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema()`);
  return rows.map((row) => row.line).sort();
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("resolveVersion", () => {
  it("takes the number alone, the full version, or 0 for none", () => {
    expect(resolveVersion("0008")).toBe("0008_receipts");
    expect(resolveVersion("0008_receipts")).toBe("0008_receipts");
    expect(resolveVersion("0")).toBe("");
    expect(() => resolveVersion("0042")).toThrow(/Unknown migration "0042"/);
  });
});

describe.each(BACKENDS)("upgrades and rollbacks on $name", (backend) => {
  it.skipIf(backend.skip)(
    "each down migration gives back the exact schema of the version before",
    async () => {
      const store = await backend.open([]);
      try {
        const schemas = [await schemaOf(store.db)];
        for (const version of versions) {
          await migrate(store.db, MIGRATIONS, { to: version });
          schemas.push(await schemaOf(store.db));
        }
        for (let i = versions.length - 1; i >= 0; i--) {
          const to = i === 0 ? "0" : (versions[i - 1] as string);
          expect(await rollback(store.db, to)).toEqual([versions[i]]);
          expect(await schemaOf(store.db), `rolling back ${versions[i]}`).toEqual(schemas[i]);
        }
        expect((await schemaStatus(store.db)).applied).toEqual([]);
        expect(await migrate(store.db)).toEqual(versions);
        expect(await schemaOf(store.db)).toEqual(schemas.at(-1));
      } finally {
        await store.close();
      }
    },
    // Every migration is applied and rolled back in turn, so this grows with each new one.
    180_000,
  );

  // No release is tagged yet, so the previous release is the migration set without its newest
  // one (or two), on data seeded at that version.
  it.skipIf(backend.skip).each([1, 2])(
    "keeps every row across an upgrade from %i migrations back, its rollback and the upgrade again",
    async (back) => {
      const previous = MIGRATIONS.slice(0, -back);
      const target = previous.at(-1)?.version as string;
      const store = await backend.open(previous);
      try {
        await seedLedger(store.db);
        const before = await rowCounts(store.db);

        expect(await migrate(store.db)).toEqual(versions.slice(-back));
        const upgraded = await rowCounts(store.db);
        for (const [table, count] of Object.entries(before)) {
          if (table !== "schema_migrations") expect(upgraded[table], table).toBe(count);
        }
        // Rows in the tables the upgrade added, as the new release would write them.
        await seedLedger(store.db);
        for (const [table, count] of Object.entries(await rowCounts(store.db))) {
          expect(count, `${table} has no seed row in fixtures/ledger/seed.ts`).toBeGreaterThan(0);
        }

        expect(await rollback(store.db, target)).toEqual(versions.slice(-back).reverse());
        expect(await rowCounts(store.db)).toEqual(before);
        expect((await schemaStatus(store.db)).current).toBe(target);

        expect(await migrate(store.db)).toEqual(versions.slice(-back));
        const again = await rowCounts(store.db);
        for (const [table, count] of Object.entries(before)) {
          if (table !== "schema_migrations") expect(again[table], table).toBe(count);
        }
      } finally {
        await store.close();
      }
    },
  );

  it.skipIf(backend.skip)(
    "a failed migration leaves the database at the previous version, and that release keeps working",
    async () => {
      const store = await backend.open();
      try {
        await seedLedger(store.db);
        const before = await rowCounts(store.db);
        const schema = await schemaOf(store.db);
        const next: Migration[] = [
          ...MIGRATIONS,
          { version: "9998_fine", sql: "CREATE TABLE fine (id int);", down: "DROP TABLE fine;" },
          {
            version: "9999_broken",
            sql: "ALTER TABLE events ADD COLUMN half text;\nSELECT 1 / 0;",
            down: "ALTER TABLE events DROP COLUMN half;",
          },
        ];
        const error = await failure(migrate(store.db, next));
        expect(String(error)).toMatch(/division by zero/);

        expect(await schemaOf(store.db)).toEqual(schema);
        expect(await rowCounts(store.db)).toEqual(before);
        expect(await schemaStatus(store.db, next)).toMatchObject({
          current: LATEST,
          pending: ["9998_fine", "9999_broken"],
        });
        // The release that was running still opens the database and writes to it.
        expect(await migrate(store.db)).toEqual([]);
        const ledger = createLedger(store.db);
        const event = makeEvent(99, { actor: { kind: "person", id: "after@example.com" } });
        expect((await ledger.append([event])).accepted).toEqual([event.id]);
      } finally {
        await store.close();
      }
    },
  );

  it.skipIf(backend.skip)(
    "refuses a schema newer than this release, and changes nothing",
    async () => {
      const store = await backend.open();
      try {
        await store.db.query("INSERT INTO schema_migrations (version) VALUES ('9999_newer')");
        const schema = await schemaOf(store.db);
        const check = async (attempt: Promise<unknown>) => {
          const error = await failure(attempt);
          expect(error).toBeInstanceOf(SchemaTooNewError);
          expect((error as Error).message).toContain(
            `it has 9999_newer, and this release knows migrations up to ${LATEST}`,
          );
          expect(await schemaOf(store.db)).toEqual(schema);
        };
        await check(migrate(store.db));
        // Its down migration is only in the newer release, so this one cannot roll it back.
        await check(rollback(store.db, "0"));
        expect(await schemaStatus(store.db)).toMatchObject({
          current: "9999_newer",
          latest: LATEST,
          pending: [],
          unknown: ["9999_newer"],
        });
      } finally {
        await store.close();
      }
    },
  );
});

describe("migrate with a target", () => {
  it("applies up to the version given and no further", async () => {
    const store = await BACKENDS[0]?.open([]);
    if (!store) throw new Error("no PGlite backend");
    const db: Database = store.db;
    try {
      expect(await migrate(db, MIGRATIONS, { to: "0002" })).toEqual(versions.slice(0, 2));
      expect((await schemaStatus(db)).pending).toEqual(versions.slice(2));
      expect(await migrate(db)).toEqual(versions.slice(2));
    } finally {
      await store.close();
    }
  });
});
