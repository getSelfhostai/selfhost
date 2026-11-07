import { defineConfig } from "vitest/config";

// Tests build a git repository in a temp dir; give setup room on slow CI runners.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
