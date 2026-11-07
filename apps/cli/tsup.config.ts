import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  clean: true,
  // Workspace packages export TypeScript source, so they are bundled in.
  noExternal: [/^@selfhost\//],
  // Their CommonJS dependencies (yaml, picomatch) call require, which ESM output lacks.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
