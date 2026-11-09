import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../src/exec.js";

describe("isolatedEnv", () => {
  it("creates the config folders it points the CLIs at, as Codex refuses a missing CODEX_HOME", () => {
    const env = isolatedEnv();
    for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
      expect(existsSync(env[name] ?? ""), name).toBe(true);
    }
  });
});
