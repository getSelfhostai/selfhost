import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

/**
 * Gives the ES module output the require that bundled CommonJS dependencies call. The import is
 * renamed so it cannot clash with a bundled module's own `import { createRequire }` in the same
 * chunk (ee/receipt's Playwright loader has one), which Node refuses to load.
 */
export const ESM_REQUIRE_BANNER =
  'import { createRequire as __selfhostCreateRequire } from "node:module"; const require = __selfhostCreateRequire(import.meta.url);';

/** Parses every built chunk, so a chunk Node cannot load fails the build, not a request. */
export function checkChunks(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".js"))
      execFileSync(process.execPath, ["--check", join(dir, name)], { stdio: "pipe" });
  }
}

/** The built web console, which `selfhost console` serves (see apps/server/src/console.ts). */
const CONSOLE_DIST = join(import.meta.dirname, "..", "console", "dist");

export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  clean: true,
  // Workspace packages export TypeScript source, so they are bundled in. Dependencies stay
  // external; PGlite must, as it reads its wasm and data files from beside its own code.
  noExternal: [/^@selfhost\//],
  // Their CommonJS dependencies (yaml, picomatch) call require, which ESM output lacks.
  banner: {
    js: ESM_REQUIRE_BANNER,
  },
  async onSuccess() {
    checkChunks("dist");
    if (!existsSync(join(CONSOLE_DIST, "index.html"))) {
      throw new Error(
        "The web console is not built. Run pnpm --filter @selfhost/console build first, or pnpm build.",
      );
    }
    rmSync("dist/console", { recursive: true, force: true });
    cpSync(CONSOLE_DIST, "dist/console", { recursive: true });
  },
});
