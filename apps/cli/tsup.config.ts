import { defineConfig } from "tsup";

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
});
