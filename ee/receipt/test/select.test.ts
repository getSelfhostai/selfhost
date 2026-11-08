import { describe, expect, it } from "vitest";
import {
  type ChangedFile,
  changedTests,
  isTestFile,
  planTests,
  type RepoProbe,
  shellQuote,
} from "../src/select.js";

function probe(files: Record<string, string>): RepoProbe {
  return {
    read: (path) => files[path],
    exists: (path) => path in files,
  };
}

const changed = (...paths: string[]): ChangedFile[] =>
  paths.map((path) => ({ path, status: "modified" }));

describe("isTestFile", () => {
  it.each([
    "src/a.test.ts",
    "src/a.spec.tsx",
    "lib/b.test.mjs",
    "src/__tests__/c.js",
    "tests/test_api.py",
    "pkg/api_test.py",
    "internal/store/store_test.go",
    "spec/models/user_spec.rb",
    "src/test/java/AppTest.java",
  ])("counts %s", (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  it.each([
    "src/a.ts",
    "src/testing.ts",
    "src/latest.py",
    "node_modules/x/a.test.js",
    "dist/a.test.js",
    "README.md",
  ])("skips %s", (path) => {
    expect(isTestFile(path)).toBe(false);
  });

  it("counts files under a [receipt] tests glob", () => {
    expect(isTestFile("e2e/login.ts")).toBe(false);
    expect(isTestFile("e2e/login.ts", ["e2e/**/*.ts"])).toBe(true);
  });
});

describe("changedTests", () => {
  it("leaves out removed files and keeps the pull request's order", () => {
    expect(
      changedTests([
        { path: "b.test.ts", status: "added" },
        { path: "a.test.ts", status: "removed" },
        { path: "src/x.ts", status: "modified" },
        { path: "c_test.go", status: "renamed", previousPath: "old_test.go" },
      ]),
    ).toEqual(["b.test.ts", "c_test.go"]);
  });
});

describe("planTests", () => {
  const options = { maxTests: 20 };

  it("runs a vitest file from the package that declares vitest", () => {
    const repo = probe({
      "package.json": JSON.stringify({ devDependencies: { turbo: "2" } }),
      "packages/web/package.json": JSON.stringify({ devDependencies: { vitest: "4" } }),
    });
    const plan = planTests(changed("packages/web/src/a b.test.ts"), repo, options);
    expect(plan.runs).toEqual([
      {
        files: ["packages/web/src/a b.test.ts"],
        runner: "vitest",
        command: "vitest run 'src/a b.test.ts'",
        cwd: "packages/web",
        bins: ["packages/web", "."],
      },
    ]);
  });

  it("walks up to the root when only the root sets up the runner", () => {
    const repo = probe({
      "package.json": JSON.stringify({ scripts: { test: "jest --ci" } }),
      "apps/api/package.json": JSON.stringify({ name: "api" }),
    });
    const plan = planTests(changed("apps/api/user.spec.js"), repo, options);
    expect(plan.runs[0]).toMatchObject({
      runner: "jest",
      command: "jest --runTestsByPath apps/api/user.spec.js",
      cwd: ".",
    });
  });

  it("prefers the runner whose config file is next to the package", () => {
    const repo = probe({
      "package.json": JSON.stringify({ devDependencies: { vitest: "4", jest: "30" } }),
      "jest.config.js": "module.exports = {}",
    });
    expect(planTests(changed("a.test.js"), repo, options).runs[0]?.runner).toBe("jest");
  });

  it("uses node --test when the test script does", () => {
    const repo = probe({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
    expect(planTests(changed("src/greet.test.mjs"), repo, options).runs[0]).toMatchObject({
      runner: "node",
      command: "node --test src/greet.test.mjs",
    });
  });

  it("runs pytest from the nearest project root, with its virtualenv", () => {
    const repo = probe({ "api/pyproject.toml": "", "api/.venv/bin/python": "" });
    expect(planTests(changed("api/tests/test_users.py"), repo, options).runs[0]).toEqual({
      files: ["api/tests/test_users.py"],
      runner: "pytest",
      command: ".venv/bin/python -m pytest tests/test_users.py",
      cwd: "api",
      bins: [],
    });
    expect(planTests(changed("test_root.py"), probe({}), options).runs[0]?.command).toBe(
      "python3 -m pytest test_root.py",
    );
  });

  it("runs go test once per package", () => {
    const repo = probe({ "svc/go.mod": "module example.com/svc" });
    const plan = planTests(
      changed("svc/store/a_test.go", "svc/store/b_test.go", "svc/main_test.go"),
      repo,
      options,
    );
    expect(plan.runs.map((run) => [run.command, run.cwd, run.files])).toEqual([
      ["go test ./store", "svc", ["svc/store/a_test.go", "svc/store/b_test.go"]],
      ["go test .", "svc", ["svc/main_test.go"]],
    ]);
  });

  it("lists test files it has no runner for as not run", () => {
    const plan = planTests(
      changed("x.test.ts", "spec/a_spec.rb", "lone_test.go"),
      probe({}),
      options,
    );
    expect(plan.runs).toEqual([]);
    expect(plan.notRun.map((item) => item.path)).toEqual([
      "x.test.ts",
      "spec/a_spec.rb",
      "lone_test.go",
    ]);
    expect(plan.notRun[0]?.reason).toContain("[receipt] test_command");
  });

  it("runs [receipt] test_command once per file with {file}, once for all with {files}", () => {
    const files = changed("a.test.ts", "spec/b c_spec.rb");
    expect(
      planTests(files, probe({}), { ...options, testCommand: "npm test -- {file}" }).runs.map(
        (run) => run.command,
      ),
    ).toEqual(["npm test -- a.test.ts", "npm test -- 'spec/b c_spec.rb'"]);
    const all = planTests(files, probe({}), { ...options, testCommand: "make test T='{files}'" });
    expect(all.runs).toHaveLength(1);
    expect(all.runs[0]).toMatchObject({
      runner: "custom",
      files: ["a.test.ts", "spec/b c_spec.rb"],
    });
  });

  it("lists runs over max_tests as not run", () => {
    const repo = probe({ "package.json": JSON.stringify({ devDependencies: { vitest: "4" } }) });
    const plan = planTests(changed("a.test.ts", "b.test.ts", "c.test.ts"), repo, { maxTests: 2 });
    expect(plan.runs.map((run) => run.files[0])).toEqual(["a.test.ts", "b.test.ts"]);
    expect(plan.notRun).toEqual([
      { path: "c.test.ts", reason: "Over [receipt] max_tests (2 runs)." },
    ]);
  });
});

describe("shellQuote", () => {
  it("quotes only what the shell would split or expand", () => {
    expect(shellQuote("src/a.test.ts")).toBe("src/a.test.ts");
    expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
  });
});
