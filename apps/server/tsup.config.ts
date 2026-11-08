import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

/** The built web console, served at / (see src/console.ts). Turbo builds it first. */
const CONSOLE_DIST = join(import.meta.dirname, "..", "console", "dist");

export default defineConfig({
  entry: ["src/main.ts", "src/migrate.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  clean: true,
  // Workspace packages export TypeScript source, so they are bundled in.
  noExternal: [/^@selfhost\//],
  // Bundled CommonJS dependencies (yaml, through the policy compiler) call require, which an
  // ES module does not have.
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
