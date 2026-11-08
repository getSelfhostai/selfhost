import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildStackModule,
  DOCKER_DIR,
  GENERATED_PATH,
  PACKAGE_ROOT,
  STACK_PATHS,
} from "../scripts/stack.js";
import { STACK_FILES } from "../src/stack.generated.js";

describe("stack.generated.ts", () => {
  it("embeds the docker/ files as they are", () => {
    const file = join(PACKAGE_ROOT, GENERATED_PATH);
    const hint = `${GENERATED_PATH} is out of date. Run: pnpm --filter @selfhost/deploy embed-stack`;
    expect(existsSync(file), hint).toBe(true);
    expect(readFileSync(file, "utf8"), hint).toBe(buildStackModule());
  });

  it("carries every file a server needs and leaves the build files behind", () => {
    const shipped = new Set<string>(STACK_PATHS);
    const left = readdirSync(DOCKER_DIR, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(DOCKER_DIR.length + 1))
      .filter(
        (path) =>
          !shipped.has(path) &&
          ![".env", "bifrost.json"].includes(path) &&
          !path.startsWith("backups/"),
      )
      .sort();
    expect(left).toEqual([".gitignore", "Dockerfile", "Dockerfile.dockerignore", "README.md"]);
  });

  it("keeps the scripts executable", () => {
    const modes = Object.fromEntries(STACK_FILES.map((file) => [file.path, file.mode]));
    for (const script of ["install.sh", "backup.sh", "restore.sh", "gateway-config.sh"]) {
      expect(modes[script], script).toBe(0o755);
    }
    expect(modes["compose.yml"]).toBe(0o644);
  });
});
