import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { MIGRATIONS, type Migration } from "./migrations.generated.js";

/** The few calls the ledger needs, implemented the same way on Postgres and PGlite. */
export interface Queryable {
  /** One statement with $1, $2 ... parameters. */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Several statements, no parameters. */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  kind: "postgres" | "pglite";
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  url?: string;
  dataDir?: string;
}

export const MEMORY_DATA_DIR = "memory://";

/** Where the embedded database lives: dataDir, else SELFHOST_DATA_DIR, else ~/.selfhost/data. */
export function resolveDataDir(dataDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (dataDir) return dataDir;
  if (env.SELFHOST_DATA_DIR) return env.SELFHOST_DATA_DIR;
  return join(homedir(), ".selfhost", "data");
}

export function isPostgresUrl(url: string): boolean {
  return /^postgres(?:ql)?:\/\//i.test(url);
}

export async function connect(options: ConnectOptions = {}): Promise<Database> {
  const url = options.url?.trim();
  if (url) {
    if (!isPostgresUrl(url)) {
      throw new Error(
        "Unsupported database url: expected postgres:// or postgresql://. Leave it unset to use the embedded database.",
      );
    }
    return connectPostgres(url);
  }
  return connectPglite(resolveDataDir(options.dataDir));
}

function connectPostgres(url: string): Database {
  const sql = postgres(url, { onnotice: () => {} });
  const wrap = (client: postgres.Sql | postgres.TransactionSql): Queryable => ({
    async query<T>(text: string, params: unknown[] = []) {
      const rows = await client.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as T[];
    },
    async exec(text: string) {
      await client.unsafe(text);
    },
  });
  return {
    kind: "postgres",
    ...wrap(sql),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
      return (await sql.begin((tx) => fn(wrap(tx)))) as T;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

async function connectPglite(dataDir: string): Promise<Database> {
  if (dataDir !== MEMORY_DATA_DIR && !dataDir.includes("://")) {
    mkdirSync(dataDir, { recursive: true });
  }
  const db = await PGlite.create(dataDir);
  const wrap = (client: Pick<PGlite, "query" | "exec">): Queryable => ({
    async query<T>(text: string, params: unknown[] = []) {
      return (await client.query<T>(text, params)).rows;
    },
    async exec(text: string) {
      await client.exec(text);
    },
  });
  return {
    kind: "pglite",
    ...wrap(db),
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx))),
    close: () => db.close(),
  };
}

const MIGRATION_LOCK = 7_403_120_001;

/**
 * Applies migrations that have not run yet, in version order, each recorded in
 * schema_migrations. Runs in one transaction under an advisory lock, so servers starting
 * together against the same Postgres do not race.
 */
export async function migrate(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await tx.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`,
    );
    const rows = await tx.query<{ version: string }>("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.version));
    const ran: string[] = [];
    for (const migration of [...migrations].sort((a, b) => (a.version < b.version ? -1 : 1))) {
      if (applied.has(migration.version)) continue;
      await tx.exec(migration.sql);
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
      ran.push(migration.version);
    }
    return ran;
  });
}
