import { defineConfig } from "vitest/config";

// The compile runs Ruler in temp folders; give it room on slow CI runners.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
