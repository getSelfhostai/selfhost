import { defineConfig } from "vitest/config";

// Tests here start an embedded Postgres, often several per test (init, import, team join);
// give them room on slow CI runners and busy laptops.
export default defineConfig({
  test: {
    setupFiles: ["../../fixtures/test-setup/isolated-home.ts"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
