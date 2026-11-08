import { defineConfig } from "vitest/config";

// Tests start the sample app and run its tests in child processes; give them room on slow CI
// runners.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
