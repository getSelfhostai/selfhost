import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE_ROOT = join(import.meta.dirname, "..");
export const MIGRATIONS_DIR = join(PACKAGE_ROOT, "migrations");
export const GENERATED_PATH = "src/migrations.generated.ts";

const DOWN = ".down.sql";

/**
 * Builds src/migrations.generated.ts from migrations/*.sql. The SQL files are the source; the
 * generated module embeds them so bundled servers and compiled binaries need no files on disk.
 * Every NNNN_name.sql needs a NNNN_name.down.sql that undoes it, so each release can be rolled
 * back; this throws when one is missing or has no migration of its own.
 */
export function buildMigrationsModule(dir = MIGRATIONS_DIR): string {
  const files = readdirSync(dir).filter((file) => file.endsWith(".sql"));
  const ups = files.filter((file) => !file.endsWith(DOWN)).sort();
  const downs = new Set(files.filter((file) => file.endsWith(DOWN)));
  const problems = [
    ...ups
      .filter((file) => !downs.has(file.replace(/\.sql$/, DOWN)))
      .map((file) => `${file} has no rollback: add ${file.replace(/\.sql$/, DOWN)}`),
    ...[...downs]
      .filter((file) => !ups.includes(file.replace(DOWN, ".sql")))
      .map((file) => `${file} rolls back no migration`),
  ];
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const entries = ups.map((file) => {
    const sql = readFileSync(join(dir, file), "utf8");
    const down = readFileSync(join(dir, file.replace(/\.sql$/, DOWN)), "utf8");
    return `  {\n    version: ${JSON.stringify(file.replace(/\.sql$/, ""))},\n    sql: ${JSON.stringify(sql)},\n    down: ${JSON.stringify(down)},\n  },`;
  });
  return [
    "// Generated from packages/ledger/migrations. Run `pnpm --filter @selfhost/ledger embed-migrations` after changing them. Do not edit by hand.",
    "",
    "export interface Migration {",
    "  version: string;",
    "  sql: string;",
    "  /** Undoes sql, from NNNN_name.down.sql. */",
    "  down: string;",
    "}",
    "",
    "export const MIGRATIONS: readonly Migration[] = [",
    ...entries,
    "];",
    "",
  ].join("\n");
}
