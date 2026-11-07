import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, openLedger, stableEventId } from "@selfhost/ledger";
import {
  EVENT_SCHEMA,
  type LedgerEvent,
  parseConfig,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import postgres from "postgres";

export const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");

export function readFixture(...parts: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, ...parts), "utf8"));
}

export interface Backend {
  name: string;
  skip: boolean;
  /** A fresh, migrated ledger and a way to drop it. */
  open(): Promise<{ ledger: Ledger; close(): Promise<void> }>;
}

const DATABASE_URL = process.env.DATABASE_URL;

/** PGlite in memory always; real Postgres when DATABASE_URL is set, in a schema of its own. */
export const BACKENDS: Backend[] = [
  {
    name: "pglite",
    skip: false,
    async open() {
      const ledger = await openLedger({ dataDir: "memory://" });
      return { ledger, close: () => ledger.close() };
    },
  },
  {
    name: "postgres",
    skip: !DATABASE_URL,
    async open() {
      const url = DATABASE_URL ?? "";
      const schema = `selfhost_test_${randomBytes(6).toString("hex")}`;
      const admin = postgres(url, { onnotice: () => {} });
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      const scoped = new URL(url);
      scoped.searchParams.set("search_path", schema);
      const ledger = await openLedger({ url: scoped.toString() });
      return {
        ledger,
        async close() {
          await ledger.close();
          await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
          await admin.end();
        },
      };
    },
  },
];

export function config(toml = ""): ResolvedSelfhostConfig {
  const parsed = parseConfig(`version = 1\n${toml}`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
}

let counter = 0;

/** A valid event. Ids are unique per call and sort by ts. */
export function event(
  fields: Pick<LedgerEvent, "kind" | "ts"> & Partial<LedgerEvent>,
): LedgerEvent {
  counter += 1;
  return {
    id: stableEventId(fields.ts, `review-test:${counter}`),
    schema: EVENT_SCHEMA,
    source: "hook",
    actor: { kind: "person", id: "dev@example.com" },
    ...fields,
  };
}

/** `minutes` after `base`, as an ISO time. */
export function at(base: string, minutes: number): string {
  return new Date(Date.parse(base) + minutes * 60_000).toISOString();
}
