import { defineConfig } from "vitest/config";

// Registry tests replay recorded responses; a few wait on a time budget on purpose.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
