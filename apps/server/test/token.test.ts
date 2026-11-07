import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadApiToken } from "../src/token.js";

describe("loadApiToken", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "selfhost-token-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses SELFHOST_TOKEN when set and writes nothing", () => {
    const dataDir = join(dir, "data");
    expect(loadApiToken(dataDir, { SELFHOST_TOKEN: " from-env " })).toEqual({
      token: "from-env",
      created: false,
    });
    expect(() => statSync(dataDir)).toThrow();
  });

  it("generates a token on first start, saves it with mode 0600 and reuses it", () => {
    const dataDir = join(dir, "data");
    const first = loadApiToken(dataDir, {});
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^selfhost_[A-Za-z0-9_-]{43}$/);
    expect(first.path).toBe(join(dataDir, "token"));
    expect(readFileSync(join(dataDir, "token"), "utf8").trim()).toBe(first.token);
    if (process.platform !== "win32") {
      expect(statSync(join(dataDir, "token")).mode & 0o777).toBe(0o600);
    }
    expect(loadApiToken(dataDir, {})).toEqual({ ...first, created: false });
  });

  it("replaces an empty token file", () => {
    writeFileSync(join(dir, "token"), "\n", { mode: 0o644 });
    const result = loadApiToken(dir, {});
    expect(result.created).toBe(true);
    expect(readFileSync(join(dir, "token"), "utf8").trim()).toBe(result.token);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps an in-memory token for memory data dirs", () => {
    const result = loadApiToken("memory://", {});
    expect(result.created).toBe(true);
    expect(result.path).toBeUndefined();
  });
});
