import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMigrationsModule, GENERATED_PATH, PACKAGE_ROOT } from "../scripts/migrations.js";
import { MIGRATIONS } from "../src/migrations.generated.js";

describe("migrations", () => {
  it("embeds the SQL files as they are", () => {
    const file = join(PACKAGE_ROOT, GENERATED_PATH);
    const hint = `${GENERATED_PATH} is out of date. Run: pnpm --filter @selfhost/ledger embed-migrations`;
    expect(existsSync(file), hint).toBe(true);
    expect(readFileSync(file, "utf8"), hint).toBe(buildMigrationsModule());
  });

  it("numbers versions in order with no gaps", () => {
    const numbers = MIGRATIONS.map((m) => Number(m.version.slice(0, 4)));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    for (const m of MIGRATIONS) expect(m.version).toMatch(/^\d{4}_[a-z0-9_]+$/);
  });

  it("ships a rollback with every migration", () => {
    for (const m of MIGRATIONS) expect(m.down.trim(), m.version).not.toBe("");
    const dir = mkdtempSync(join(tmpdir(), "selfhost-migrations-"));
    try {
      writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id int);");
      writeFileSync(join(dir, "0002_b.down.sql"), "DROP TABLE b;");
      expect(() => buildMigrationsModule(dir)).toThrow(
        "0001_a.sql has no rollback: add 0001_a.down.sql\n0002_b.down.sql rolls back no migration",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs inside a transaction, so nothing in a migration may end one or need to be outside one", () => {
    const outside = /^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|VACUUM)\b\s*;|\bCONCURRENTLY\b/im;
    for (const m of MIGRATIONS) {
      expect(m.sql, m.version).not.toMatch(outside);
      expect(m.down, `${m.version}.down`).not.toMatch(outside);
    }
  });
});
