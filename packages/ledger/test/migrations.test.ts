import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMigrationsModule, GENERATED_PATH, PACKAGE_ROOT } from "../scripts/migrations.js";
import { MIGRATIONS } from "../src/migrations.generated.js";

/**
 * Numbers held for a migration on a branch that has not merged yet, the only gaps allowed.
 * 0004 is the review list's; remove it here once that migration is in.
 */
const RESERVED = [4];

describe("migrations", () => {
  it("embeds the SQL files as they are", () => {
    const file = join(PACKAGE_ROOT, GENERATED_PATH);
    const hint = `${GENERATED_PATH} is out of date. Run: pnpm --filter @selfhost/ledger embed-migrations`;
    expect(existsSync(file), hint).toBe(true);
    expect(readFileSync(file, "utf8"), hint).toBe(buildMigrationsModule());
  });

  it("numbers versions in order with no gaps", () => {
    const numbers = MIGRATIONS.map((m) => Number(m.version.slice(0, 4)));
    const taken = [...numbers, ...RESERVED.filter((n) => !numbers.includes(n))].sort(
      (a, b) => a - b,
    );
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(taken).toEqual(taken.map((_, i) => i + 1));
    for (const m of MIGRATIONS) expect(m.version).toMatch(/^\d{4}_[a-z0-9_]+$/);
  });
});
