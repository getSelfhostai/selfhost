import { existsSync } from "node:fs";
import type { Fetch } from "@selfhost/package-guard";
import { describe, expect, it } from "vitest";
import { type PackagesCheckReport, packagesCheckCommand } from "../src/packages.js";
import { run, tempDir } from "./run.js";

/** A repository folder, so the selfhost.toml search stops at it. */
function repo(toml?: string) {
  const dir = tempDir("packages");
  dir.write(".git/HEAD", "ref: refs/heads/main\n");
  if (toml !== undefined) dir.write("selfhost.toml", toml);
  return dir;
}

/** Registries that know no package at all, and an osv.dev with no advisories. */
const nothingExists: Fetch = async (url) => ({
  status: url.startsWith("https://api.osv.dev/") ? 200 : 404,
  text: async () => (url.startsWith("https://api.osv.dev/") ? '{"results":[{}]}' : "Not Found"),
});

function io(dir: ReturnType<typeof repo>, fetch: Fetch) {
  const out: string[] = [];
  let code = 0;
  return {
    out,
    code: () => code,
    io: {
      env: {},
      cwd: dir.root,
      write: (line: string) => out.push(line),
      setExitCode: (value: number) => {
        code = value;
      },
      now: new Date("2026-11-08T06:00:00Z"),
      configPath: dir.path("home", "config.json"),
      fetch,
    },
  };
}

describe("selfhost packages check", () => {
  it("says so when the command installs nothing, without a lookup", async () => {
    const dir = repo();
    const result = await run(["packages", "check", "npm test && git status"], { cwd: dir.root });
    expect(result).toEqual({ code: 0, out: "No package installs in this command.", err: "" });
  });

  it("checks nothing with [packages] mode off", async () => {
    const dir = repo('version = 1\n[packages]\nmode = "off"\n');
    const result = await run(["packages", "check", "npm i left-pad"], { cwd: dir.root });
    expect(result.out).toBe("[packages] mode is off: the guard checks nothing.");
    expect(result.code).toBe(0);
  });

  it("prints each package with its verdict and exits 1 when one is blocked", async () => {
    const dir = repo('version = 1\n[packages]\nmode = "enforce"\n');
    const t = io(dir, nothingExists);
    await packagesCheckCommand("cd web && npm i made-up-pkg github:acme/tool", {}, t.io);
    expect(t.out).toEqual([
      "npm i made-up-pkg github:acme/tool",
      "  blocked  made-up-pkg       packages.not_found: npm has no package named made-up-pkg. Check the name: attackers register the names agents invent.",
      "  skipped  github:acme/tool  installs from a git repository, not the registry",
      "[packages] mode is enforce: hooks stop blocked installs and ask about flagged ones.",
    ]);
    expect(t.code()).toBe(1);
    expect(existsSync(dir.path("home", "cache", "packages"))).toBe(true);
  });

  it("prints JSON with the installs, the hits and the policy file", async () => {
    const dir = repo('version = 1\n[packages]\nallow = ["@acme/*"]\n');
    const t = io(dir, nothingExists);
    await packagesCheckCommand("pnpm add @acme/ui made-up-pkg", { json: true }, t.io);
    const report = JSON.parse(t.out.join("\n")) as PackagesCheckReport;
    expect(report).toMatchObject({
      schema: "selfhost.packages_check/v1",
      command: "pnpm add @acme/ui made-up-pkg",
      config: dir.path("selfhost.toml"),
      mode: "observe",
      hits: [{ rule_id: "packages.not_found", mode: "observe", verdict: "block" }],
    });
    expect(report.installs[0]?.packages.map((p) => [p.name, p.status])).toEqual([
      ["@acme/ui", "allowed"],
      ["made-up-pkg", "blocked"],
    ]);
    expect(t.code()).toBe(1);
  });

  it("rejects a timeout that is not a number of milliseconds", async () => {
    const dir = repo();
    const result = await run(["packages", "check", "npm i x", "--timeout", "soon", "--json"], {
      cwd: dir.root,
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({
      schema: "selfhost.error/v1",
      error: '--timeout: expected a whole number of milliseconds, got "soon"',
    });
  });

  it("names the problem in an invalid selfhost.toml", async () => {
    const dir = repo('version = 1\n[packages]\ninstall_scripts = "warn"\n');
    const result = await run(["packages", "check", "npm i x"], { cwd: dir.root });
    expect(result.code).toBe(1);
    expect(result.err).toContain("selfhost.toml:3: packages.install_scripts");
  });
});
