import { defineConfig } from "vitest/config";

// The Ruler tests run Ruler itself in temp folders; give them room on slow CI runners.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
