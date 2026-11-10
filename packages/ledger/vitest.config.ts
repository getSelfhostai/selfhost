import { defineConfig } from "vitest/config";

// Tests here start an embedded Postgres; give setup room on slow CI runners.
export default defineConfig({
  test: {
    setupFiles: ["../../fixtures/test-setup/isolated-home.ts"],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
