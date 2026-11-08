import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

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
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  async onSuccess() {
    if (!existsSync(join(CONSOLE_DIST, "index.html"))) {
      throw new Error(
        "The web console is not built. Run pnpm --filter @selfhost/console build first, or pnpm build.",
      );
    }
    rmSync("dist/console", { recursive: true, force: true });
    cpSync(CONSOLE_DIST, "dist/console", { recursive: true });
  },
});
