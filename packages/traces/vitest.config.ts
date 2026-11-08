import { defineConfig } from "vitest/config";

// Tests start an embedded Postgres and a local OTLP receiver; give setup room on slow CI runners.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
