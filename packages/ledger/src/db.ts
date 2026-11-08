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
 * The database has migrations this release does not know: a newer release ran them. The server
 * refuses to start rather than run against tables it was not written for.
 */
export class SchemaTooNewError extends Error {
  override name = "SchemaTooNewError";

  constructor(
    readonly unknown: readonly string[],
    readonly latest: string | null,
  ) {
    super(
      `The database schema is newer than this release: it has ${unknown.join(", ")}, and this release knows migrations up to ${latest ?? "none"}. Run the newer release, or use it to roll the database back to ${latest ?? "0"} first.`,
    );
  }
}

const inOrder = (migrations: readonly Migration[]) =>
  [...migrations].sort((a, b) => (a.version < b.version ? -1 : 1));

const latestOf = (migrations: readonly Migration[]) => inOrder(migrations).at(-1)?.version ?? null;

/**
 * A version as given, like 0008 or 0008_receipts, as the full version; 0 means before every
 * migration, returned as "". Throws for a version that is not in migrations.
 */
export function resolveVersion(
  input: string,
  migrations: readonly Migration[] = MIGRATIONS,
): string {
  const value = input.trim();
  if (/^0+$/.test(value)) return "";
  const found = migrations.find((m) => m.version === value || m.version.startsWith(`${value}_`));
  if (!found) {
    throw new Error(
      `Unknown migration "${input}": expected one of ${migrations.map((m) => m.version).join(", ")}, or 0 for none`,
    );
  }
  return found.version;
}

/** Takes the migration lock for this transaction and returns the versions already applied. */
async function lockApplied(tx: Queryable, migrations: readonly Migration[]): Promise<Set<string>> {
  await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
  await tx.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`,
  );
  const rows = await tx.query<{ version: string }>("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((row) => row.version));
  const known = new Set(migrations.map((m) => m.version));
  const unknown = [...applied].filter((version) => !known.has(version)).sort();
  if (unknown.length > 0) throw new SchemaTooNewError(unknown, latestOf(migrations));
  return applied;
}

/**
 * Applies migrations that have not run yet, in version order (up to and including `to` when
 * given), each recorded in schema_migrations. All of them run in one transaction under an
 * advisory lock: servers starting together against the same Postgres do not race, and a
 * migration that fails leaves the database at the version it had before. Throws
 * SchemaTooNewError, changing nothing, when the database has a migration this release does not
 * know.
 */
export async function migrate(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
  options: { to?: string } = {},
): Promise<string[]> {
  const to = options.to === undefined ? undefined : resolveVersion(options.to, migrations);
  return db.transaction(async (tx) => {
    const applied = await lockApplied(tx, migrations);
    const ran: string[] = [];
    for (const migration of inOrder(migrations)) {
      if (applied.has(migration.version)) continue;
      if (to !== undefined && migration.version > to) break;
      await tx.exec(migration.sql);
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
      ran.push(migration.version);
    }
    return ran;
  });
}

/**
 * Rolls the database back to `to` (see resolveVersion) with the down migrations of every applied
 * migration after it, newest first, in one transaction under the migration lock: a down that
 * fails changes nothing. Returns the versions rolled back.
 */
export async function rollback(
  db: Database,
  to: string,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<string[]> {
  const target = resolveVersion(to, migrations);
  return db.transaction(async (tx) => {
    const applied = await lockApplied(tx, migrations);
    const undone: string[] = [];
    for (const migration of inOrder(migrations).reverse()) {
      if (migration.version <= target || !applied.has(migration.version)) continue;
      await tx.exec(migration.down);
      await tx.query("DELETE FROM schema_migrations WHERE version = $1", [migration.version]);
      undone.push(migration.version);
    }
    return undone;
  });
}

export interface SchemaStatus {
  /** The newest migration applied, null on an empty database. */
  current: string | null;
  /** The newest migration this release knows. */
  latest: string | null;
  applied: string[];
  /** Known and not applied yet: the next start applies them. */
  pending: string[];
  /** Applied by a newer release: this one refuses to run until they are rolled back. */
  unknown: string[];
}

/** Where the database's schema is against these migrations. Reads only. */
export async function schemaStatus(
  db: Queryable,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<SchemaStatus> {
  const [table] = await db.query<{ found: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS found",
  );
  const applied = table?.found
    ? (await db.query<{ version: string }>("SELECT version FROM schema_migrations")).map(
        (row) => row.version,
      )
    : [];
  applied.sort();
  const known = new Set(migrations.map((m) => m.version));
  return {
    current: applied.at(-1) ?? null,
    latest: latestOf(migrations),
    applied,
    pending: inOrder(migrations)
      .map((m) => m.version)
      .filter((version) => !applied.includes(version)),
    unknown: applied.filter((version) => !known.has(version)),
  };
}

/** Rows in each table of the current schema, schema_migrations included, by table name. */
export async function rowCounts(db: Queryable): Promise<Record<string, number>> {
  const tables = await db.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const [row] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${name.replaceAll('"', '""')}"`,
    );
    counts[name] = Number(row?.n ?? 0);
  }
  return counts;
}

/**
 * The embedded database in dataDir as a gzipped tar of its folder (PGlite's dumpDataDir). Open it
 * while nothing else has the folder open: PGlite allows one process at a time.
 */
export async function dumpDataDir(dataDir: string): Promise<Uint8Array> {
  const db = await PGlite.create(dataDir);
  try {
    const archive = await db.dumpDataDir("gzip");
    return new Uint8Array(await archive.arrayBuffer());
  } finally {
    await db.close();
  }
}

/** Unpacks a dumpDataDir archive into dataDir, which should be a new, empty folder. */
export async function loadDataDir(dataDir: string, archive: Uint8Array): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const db = await PGlite.create(dataDir, { loadDataDir: new Blob([archive]) });
  await db.close();
}
