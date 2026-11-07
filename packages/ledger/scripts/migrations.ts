import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE_ROOT = join(import.meta.dirname, "..");
export const MIGRATIONS_DIR = join(PACKAGE_ROOT, "migrations");
export const GENERATED_PATH = "src/migrations.generated.ts";

/**
 * Builds src/migrations.generated.ts from migrations/*.sql. The SQL files are the source; the
 * generated module embeds them so bundled servers and compiled binaries need no files on disk.
 */
export function buildMigrationsModule(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const entries = files.map((file) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    return `  {\n    version: ${JSON.stringify(file.replace(/\.sql$/, ""))},\n    sql: ${JSON.stringify(sql)},\n  },`;
  });
  return [
    "// Generated from packages/ledger/migrations. Run `pnpm --filter @selfhost/ledger embed-migrations` after changing them. Do not edit by hand.",
    "",
    "export interface Migration {",
    "  version: string;",
    "  sql: string;",
    "}",
    "",
    "export const MIGRATIONS: readonly Migration[] = [",
    ...entries,
    "];",
    "",
  ].join("\n");
}
