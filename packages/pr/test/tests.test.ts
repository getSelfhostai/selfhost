import { describe, expect, it } from "vitest";
import { type ChangedFile, isTestFile, skipMarker, testChanges } from "../src/index.js";

describe("isTestFile", () => {
  it.each([
    "src/limiter.test.ts",
    "web/app.spec.jsx",
    "cypress/e2e/login.cy.ts",
    "src/__tests__/limiter.ts",
    "tests/test_limits.py",
    "pkg/limits/limits_test.py",
    "internal/limit/limit_test.go",
    "spec/models/user_spec.rb",
    "src/test/java/acme/LimiterTest.java",
    "Acme.Tests/LimiterTests.cs",
    "crates/core/tests/limits.rs",
    "test/helpers.ts",
    "e2e/checkout.ts",
  ])("counts %s", (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  it.each([
    "src/limiter.ts",
    "src/testing.ts",
    "docs/tests.md",
    "fixtures/test.json",
    "src/contest/run.py",
    "testdata/input.go",
  ])("leaves %s alone", (path) => {
    expect(isTestFile(path)).toBe(false);
  });
});

describe("skipMarker", () => {
  it.each([
    ['  it.skip("refills", () => {', "it.skip"],
    ["describe.only('limits', () => {", "describe.only"],
    ['test.skipIf(process.env.CI)("slow", () => {})', "test.skipIf"],
    ['  xit("refills", () => {', "xit"],
    ['fdescribe("limits", () => {', "fdescribe"],
    ['@pytest.mark.skip(reason="flaky")', "@pytest.mark.skip"],
    ["@unittest.skipIf(True, 'x')", "@unittest.skipIf"],
    ['    pytest.skip("no redis")', "pytest.skip"],
    ['\tt.Skip("flaky on CI")', "t.Skip"],
    ["#[ignore]", "#[ignore"],
    ["  @Disabled", "@Disabled"],
  ])("finds the marker in %s", (line, marker) => {
    expect(skipMarker(line)).toBe(marker);
  });

  it.each(["model.fit(x, y)", "query.skip(10)", 'it("skips nothing", () => {', "const xit = 1;"])(
    "finds none in %s",
    (line) => {
      expect(skipMarker(line)).toBeUndefined();
    },
  );
});

describe("testChanges", () => {
  const hunk = (removed: [number, string][], added: [number, string][]) => ({
    oldStart: 1,
    oldLines: removed.length,
    newStart: 1,
    newLines: added.length,
    removed: removed.map(([line, text]) => ({ line, text })),
    added: added.map(([line, text]) => ({ line, text })),
  });

  it("finds deleted test files, lost test declarations and new skips", () => {
    const files: ChangedFile[] = [
      {
        path: "test/old.test.ts",
        status: "removed",
        additions: 0,
        deletions: 9,
        hunks: [
          hunk(
            [
              [1, 'it("a", () => {'],
              [5, 'it("b", () => {'],
            ],
            [],
          ),
        ],
      },
      { path: "test/binary.test.ts", status: "removed", additions: 0, deletions: 0 },
      {
        path: "src/limiter.test.ts",
        status: "modified",
        additions: 2,
        deletions: 3,
        hunks: [
          hunk(
            [
              [12, '  it("refills", () => {'],
              [20, '  it("drains", () => {'],
              [30, '  it.skip("old skip", () => {'],
            ],
            [
              [12, '  it.skip("refills", () => {'],
              [29, '    it.skip("old skip", () => {'],
            ],
          ),
        ],
      },
      {
        path: "src/limiter.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        hunks: [hunk([], [[3, "const t = { skip: () => it.skip }"]])],
      },
    ];
    expect(testChanges(files)).toEqual([
      { kind: "deleted_test_file", path: "test/old.test.ts", detail: "2 tests" },
      { kind: "deleted_test_file", path: "test/binary.test.ts", detail: "" },
      { kind: "skipped_test", path: "src/limiter.test.ts", line: 12, detail: "it.skip" },
      {
        kind: "deleted_test",
        path: "src/limiter.test.ts",
        line: 20,
        detail: 'it("drains", () => {',
      },
    ]);
  });

  it("does not count a renamed test as deleted", () => {
    const files: ChangedFile[] = [
      {
        path: "tests/test_limits.py",
        status: "modified",
        additions: 1,
        deletions: 1,
        hunks: [hunk([[4, "def test_refill():"]], [[4, "def test_refill_rate():"]])],
      },
    ];
    expect(testChanges(files)).toEqual([]);
  });
});
