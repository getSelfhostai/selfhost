import { chmodSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { MIGRATIONS, type Migration } from "./migrations.generated.js";
import { currentOrg } from "./scope.js";

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

/** Sets the org the row-level security policies of migration 0019 show, for this transaction. */
const SET_ORG = "SELECT set_config('selfhost.org', $1, true)";

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
  const plain = wrap(sql);
  /** Runs fn in a transaction, limited to the org of the current scope when there is one. */
  const begin = async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
    const org = currentOrg();
    return (await sql.begin(async (tx) => {
      if (org !== undefined) await tx.unsafe(SET_ORG, [org]);
      return fn(wrap(tx));
    })) as T;
  };
  return {
    kind: "postgres",
    // Outside an org scope a statement runs on its own, as always; inside one it needs a
    // transaction for SET LOCAL to last exactly as long as the statement.
    query: <T>(text: string, params?: unknown[]) =>
      currentOrg() === undefined
        ? plain.query<T>(text, params)
        : begin((tx) => tx.query<T>(text, params)),
    exec: (text: string) =>
      currentOrg() === undefined ? plain.exec(text) : begin((tx) => tx.exec(text)),
    transaction: begin,
    close: () => sql.end({ timeout: 5 }),
  };
}

/** Folder modes for the embedded ledger: its owner only. */
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

/**
 * Makes a folder and everything under it readable by its owner only: folders 0700, files 0600.
 * Symbolic links are left alone. true when anything was opened up to others before.
 */
export function makePrivate(dir: string): boolean {
  let changed = false;
  const visit = (path: string, folder: boolean) => {
    try {
      const mode = lstatSync(path).mode & 0o777;
      const wanted = folder ? PRIVATE_DIR : PRIVATE_FILE;
      if (mode !== wanted) {
        if (mode & 0o077) changed = true;
        chmodSync(path, wanted);
      }
      if (!folder) return;
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(join(path, entry.name), true);
        else if (entry.isFile()) visit(join(path, entry.name), false);
      }
    } catch (error) {
      // A file the database removed on the way, or a folder another process moved.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  visit(dir, true);
  return changed;
}

/**
 * Creates the embedded ledger's folder for its owner only. One made by an earlier release (0755
 * with 0666 files) is fixed here. The folder holds notify target URLs and everything the agents
 * did. true when the folder was open to others, for the note openPrivate prints.
 */
function privateDataDir(dataDir: string): boolean {
  mkdirSync(dataDir, { recursive: true, mode: PRIVATE_DIR });
  if ((statSync(dataDir).mode & 0o077) === 0) return false;
  return makePrivate(dataDir);
}

const isFolder = (dataDir: string) => dataDir !== MEMORY_DATA_DIR && !dataDir.includes("://");

/** Sets the process umask while `fn` runs, where the platform lets a process set it. */
async function withUmask<T>(mask: number, fn: () => Promise<T>): Promise<T> {
  let previous: number | undefined;
  try {
    previous = process.umask(mask);
  } catch {
    // Worker threads cannot change the umask; the files are made private after open instead.
  }
  try {
    return await fn();
  } finally {
    if (previous !== undefined) process.umask(previous);
  }
}

/**
 * Opens PGlite on a folder that only its owner can read: the folder before, every file PGlite
 * made on open after (it makes them 0666 under its file system), and new files under a umask
 * of 077 while it opens. A folder an earlier release left open is noted on stderr once, after it
 * is private.
 */
async function openPrivate(dataDir: string): Promise<PGlite> {
  if (!isFolder(dataDir)) return PGlite.create(dataDir);
  const fixed = privateDataDir(dataDir);
  const db = await withUmask(0o077, () => PGlite.create(dataDir));
  makePrivate(dataDir);
  if (fixed) {
    console.error(
      `selfhost: ${dataDir} was readable by other users; it is now private to you (folders 0700, files 0600).`,
    );
  }
  return db;
}

async function connectPglite(dataDir: string): Promise<Database> {
  const db = await openPrivate(dataDir);
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
    async close() {
      await db.close();
      // Files PGlite made while open (0666 under its file system) are made private too.
      if (isFolder(dataDir)) makePrivate(dataDir);
    },
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
  const db = await openPrivate(dataDir);
  try {
    const archive = await db.dumpDataDir("gzip");
    return privateArchive(new Uint8Array(await archive.arrayBuffer()));
  } finally {
    await db.close();
    if (isFolder(dataDir)) makePrivate(dataDir);
  }
}

/**
 * The archive with every entry's mode set for its owner only: 0700 for folders, 0600 for the
 * rest. PGlite writes 0666 and 0777, which a plain `tar -x` would keep.
 */
export function privateArchive(gzipped: Uint8Array): Uint8Array {
  const tar = Buffer.from(gunzipSync(gzipped));
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12) || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const mode = type === "5" ? PRIVATE_DIR : PRIVATE_FILE;
    if (type !== "2" && type !== "1") {
      header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
      header.fill(0x20, 148, 156);
      const sum = header.reduce((total, byte) => total + byte, 0);
      header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return new Uint8Array(gzipSync(tar));
}

/** A NUL or space terminated text field of a tar header. */
const field = (header: Buffer, offset: number, length: number) =>
  header
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/s, "")
    .trim();

/** Unpacks a dumpDataDir archive into dataDir, which should be a new, empty folder. */
export async function loadDataDir(dataDir: string, archive: Uint8Array): Promise<void> {
  mkdirSync(dataDir, { recursive: true, mode: PRIVATE_DIR });
  const db = await PGlite.create(dataDir, { loadDataDir: new Blob([archive]) });
  await db.close();
  makePrivate(dataDir);
}
