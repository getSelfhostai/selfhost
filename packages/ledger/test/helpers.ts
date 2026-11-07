import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEvent } from "@selfhost/schema";
import { connect, type Database, migrate } from "../src/db.js";
import { createLedger, type Ledger } from "../src/ledger.js";

export const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
export const FIXTURES = join(REPO_ROOT, "fixtures");

export function readJson(...parts: string[]): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, ...parts), "utf8"));
}

export function readJsonLines(...parts: string[]): unknown[] {
  return readFileSync(join(FIXTURES, ...parts), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

export function listJson(...parts: string[]): string[] {
  return readdirSync(join(FIXTURES, ...parts))
    .filter((file) => file.endsWith(".json") && file !== "manifest.json")
    .sort();
}

export function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A valid event with id number n. Ids sort by n. */
export function makeEvent(n: number, overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    id: `01930c4e-2f1a-7b2c-8d3e-${n.toString(16).padStart(12, "0")}`,
    schema: "selfhost.event/v1",
    ts: "2026-11-07T09:30:00.000Z",
    source: "hook",
    kind: "session.started",
    actor: { kind: "person", id: "alice@example.com" },
    ...overrides,
  };
}

export interface Store {
  db: Database;
  ledger: Ledger;
  close(): Promise<void>;
}

export interface Backend {
  name: string;
  skip: boolean;
  open(): Promise<Store>;
}

const DATABASE_URL = process.env.DATABASE_URL;

/** PGlite in memory always; real Postgres when DATABASE_URL is set, in a schema of its own. */
export const BACKENDS: Backend[] = [
  {
    name: "pglite",
    skip: false,
    async open() {
      const db = await connect({ dataDir: "memory://" });
      await migrate(db);
      return { db, ledger: createLedger(db), close: () => db.close() };
    },
  },
  {
    name: "postgres",
    skip: !DATABASE_URL,
    async open() {
      const url = DATABASE_URL ?? "";
      const schema = `selfhost_test_${randomBytes(6).toString("hex")}`;
      const admin = await connect({ url });
      await admin.exec(`CREATE SCHEMA ${schema}`);
      const scoped = new URL(url);
      scoped.searchParams.set("search_path", schema);
      const db = await connect({ url: scoped.toString() });
      await migrate(db);
      return {
        db,
        ledger: createLedger(db),
        async close() {
          await db.close();
          await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
          await admin.close();
        },
      };
    },
  },
];
