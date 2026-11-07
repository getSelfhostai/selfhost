import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildArtifacts } from "../scripts/artifacts.js";
import { PACKAGE_ROOT } from "./contracts.js";

describe("generated files", () => {
  it.each(buildArtifacts().map((a) => [a.path, a.content] as const))(
    "%s matches the TypeBox source",
    (path, content) => {
      const file = join(PACKAGE_ROOT, path);
      const hint = `${path} is out of date. Run: pnpm --filter @selfhost/schema export`;
      expect(existsSync(file), hint).toBe(true);
      expect(readFileSync(file, "utf8"), hint).toBe(content);
    },
  );
});
