import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { policySource } from "../src/index.js";

const TOML = "version = 1\n";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-policy-"));
  dirs.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Alice Example",
      GIT_AUTHOR_EMAIL: "alice@example.com",
      GIT_COMMITTER_NAME: "Alice Example",
      GIT_COMMITTER_EMAIL: "alice@example.com",
    },
  }).trim();
}

function repo(): string {
  const dir = tempDir();
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

function commit(dir: string, files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
    git(dir, "add", name);
  }
  git(dir, "commit", "-q", "-m", "change");
  return git(dir, "rev-parse", "HEAD");
}

beforeAll(() => {
  // No global or system git config, so signing or hooks on this machine do not leak in.
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("policySource", () => {
  it("names the last commit that changed the file", async () => {
    const dir = repo();
    const sha = commit(dir, { "selfhost.toml": TOML });
    commit(dir, { "README.md": "readme\n" });
    expect(await policySource(join(dir, "selfhost.toml"))).toEqual({
      path: join(dir, "selfhost.toml"),
      hash: sha256(TOML),
      commit: sha,
      dirty: false,
    });
  });

  it("finds the file from a subfolder of the repository", async () => {
    const dir = repo();
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "selfhost.toml"), TOML);
    git(dir, "add", "config/selfhost.toml");
    git(dir, "commit", "-q", "-m", "add policy");
    const source = await policySource(join(dir, "config", "selfhost.toml"));
    expect(source.commit).toBe(git(dir, "rev-parse", "HEAD"));
    expect(source.dirty).toBe(false);
  });

  it("marks uncommitted changes, staged or not, as dirty", async () => {
    const dir = repo();
    const sha = commit(dir, { "selfhost.toml": TOML });
    const changed = `${TOML}[ledger]\nretention_days = 30\n`;
    writeFileSync(join(dir, "selfhost.toml"), changed);
    expect(await policySource(join(dir, "selfhost.toml"))).toMatchObject({
      hash: sha256(changed),
      commit: sha,
      dirty: true,
    });
    git(dir, "add", "selfhost.toml");
    expect((await policySource(join(dir, "selfhost.toml"))).dirty).toBe(true);
  });

  it("has no commit for an untracked file", async () => {
    const dir = repo();
    commit(dir, { "README.md": "readme\n" });
    writeFileSync(join(dir, "selfhost.toml"), TOML);
    expect(await policySource(join(dir, "selfhost.toml"))).toEqual({
      path: join(dir, "selfhost.toml"),
      hash: sha256(TOML),
      dirty: true,
    });
  });

  it("has no commit outside a git repository", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "selfhost.toml"), TOML);
    const source = await policySource(join(dir, "selfhost.toml"));
    expect(source.commit).toBeUndefined();
    expect(source.hash).toBe(sha256(TOML));
  });

  it("fails when the file does not exist", async () => {
    await expect(policySource(join(tempDir(), "selfhost.toml"))).rejects.toThrow(/ENOENT/);
  });
});
