import { describe, expect, it } from "vitest";
import { isTestFile, type StartResult } from "../src/index.js";
import { harness } from "./harness.js";

function done(result: StartResult) {
  if ("refused" in result) throw new Error(result.refused);
  return result.done;
}

const toml = (background: string) =>
  `version = 1\n[runtime]\ndefault = "e2b"\n[background]\n${background}\n`;

describe("tests-first gate", () => {
  it("in enforce, opens no pull request when the new test already passes on the base", async () => {
    const h = harness({ toml: toml('tests_first = "enforce"'), basePasses: true });
    const final = await done(await h.runner.start(h.request()));
    expect(final.state).toBe("failed");
    expect(final.reason).toMatch(
      /^No pull request: Tests first failed: The changed tests \(1\) already pass on the base/,
    );
    expect(final.gate).toMatchObject({
      mode: "enforce",
      result: "failed",
      blocked: true,
      command: "pnpm test",
      command_from: "package.json",
    });
    expect(final.gate?.tests_changed).toEqual(["src/login.test.ts"]);
    expect(h.pulls).toEqual([]);
    expect(h.states(final.id)).not.toContain("pushing");
  });

  it("in observe, opens the pull request with a neutral check", async () => {
    const h = harness({ basePasses: true });
    const final = await done(await h.runner.start(h.request()));
    expect(final.state).toBe("succeeded");
    expect(final.gate).toMatchObject({ mode: "observe", result: "failed", blocked: false });
    expect(h.checks[0]).toMatchObject({ conclusion: "neutral", title: "Tests first: failed" });
    const opened = h.events.find((e) => e.kind === "pr.opened");
    expect(opened?.data).toMatchObject({ tests: "failed", number: 7 });
  });

  it("fails with the failing test output when the head's tests fail", async () => {
    const h = harness({ toml: toml('tests_first = "enforce"'), headPasses: false });
    const final = await done(await h.runner.start(h.request()));
    expect(final.state).toBe("failed");
    expect(final.gate?.output).toContain("1 failed: login rejects empty");
    expect(final.gate?.checks.find((c) => c.name === "tests_pass")).toMatchObject({ ok: false });
    const recorded = h.events.find((e) => e.kind === "run.gate");
    expect(recorded?.data?.gate).not.toHaveProperty("output");
  });

  it("needs a changed test", async () => {
    const h = harness({ toml: toml('tests_first = "enforce"'), files: ["src/login.ts"] });
    const final = await done(await h.runner.start(h.request()));
    expect(final.gate?.checks.find((c) => c.name === "tests_first")).toMatchObject({
      ok: false,
      detail: "The run added or changed no test",
    });
  });

  it("names a package the diff adds that its registry does not have", async () => {
    const h = harness({
      toml: toml('tests_first = "enforce"'),
      files: ["package.json", "src/login.ts", "src/login.test.ts"],
      fetch: async () => new Response("{}", { status: 404 }),
    });
    const final = await done(await h.runner.start(h.request()));
    expect(final.state).toBe("failed");
    expect(final.gate?.checks.find((c) => c.name === "dependencies")).toMatchObject({
      ok: false,
      detail: "Not in their registry: made-up-pkg (npm)",
    });
    expect(final.reason).toContain("made-up-pkg");
  });

  it("holds the diff to pr_size_cap", async () => {
    const h = harness({
      toml: toml('tests_first = "enforce"\npr_size_cap = 100'),
      numstat: "90\t30\tsrc/login.ts\n5\t0\tsrc/login.test.ts",
    });
    const final = await done(await h.runner.start(h.request()));
    expect(final.state).toBe("failed");
    expect(final.reason).toContain("125 changed lines, over the cap of 100");
  });

  it("is skipped when off", async () => {
    const h = harness({ toml: toml('tests_first = "off"'), basePasses: true });
    const final = await done(await h.runner.start(h.request()));
    expect(final.state).toBe("succeeded");
    expect(final.gate?.result).toBe("skipped");
    expect(h.checks).toEqual([]);
  });

  it("uses the configured test command", async () => {
    const h = harness({
      toml: toml('test_command = "make check"'),
      exec: (command, options) =>
        command === "make check"
          ? options.cwd?.startsWith("/tmp/selfhost-base-")
            ? { exitCode: 2 }
            : { exitCode: 0 }
          : undefined,
    });
    const final = await done(await h.runner.start(h.request()));
    expect(final.gate).toMatchObject({
      result: "passed",
      command: "make check",
      command_from: "config",
    });
  });

  it("recognizes test files", () => {
    for (const path of [
      "src/a.test.ts",
      "tests/test_login.py",
      "pkg/a_test.go",
      "__tests__/x.js",
      "spec/a_spec.rb",
    ]) {
      expect(isTestFile(path)).toBe(true);
    }
    for (const path of ["src/a.ts", "README.md", "testdata.json"])
      expect(isTestFile(path)).toBe(false);
  });
});
