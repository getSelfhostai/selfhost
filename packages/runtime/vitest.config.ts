import { defineConfig } from "vitest/config";

// Adapter conformance tests talk to provider sandboxes; give them room on slow runners.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
