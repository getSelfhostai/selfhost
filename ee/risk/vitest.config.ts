import { defineConfig } from "vitest/config";

// Tests build git repositories in temp dirs and start an embedded Postgres; give setup room on
// slow CI runners.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
