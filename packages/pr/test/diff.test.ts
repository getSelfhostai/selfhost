import { describe, expect, it } from "vitest";
import { firstChangedLine, parseDiff, parseHunks } from "../src/index.js";

describe("parseHunks", () => {
  it("numbers added lines on the new side and removed lines on the old side", () => {
    const patch = [
      "@@ -10,4 +10,5 @@ export function limit() {",
      "   const a = 1;",
      "-  const b = 2;",
      "+  const b = 3;",
      "+  const c = 4;",
      "   return a;",
      " }",
      "@@ -40 +41,0 @@",
      "-old();",
      "\\ No newline at end of file",
    ].join("\n");
    expect(parseHunks(patch)).toEqual([
      {
        oldStart: 10,
        oldLines: 4,
        newStart: 10,
        newLines: 5,
        removed: [{ line: 11, text: "  const b = 2;" }],
        added: [
          { line: 11, text: "  const b = 3;" },
          { line: 12, text: "  const c = 4;" },
        ],
      },
      {
        oldStart: 40,
        oldLines: 1,
        newStart: 41,
        newLines: 0,
        removed: [{ line: 40, text: "old();" }],
        added: [],
      },
    ]);
  });

  it("keeps a removed line that looks like a file header inside a hunk", () => {
    const [hunk] = parseHunks("@@ -1,2 +1,1 @@\n--- a/x\n keep\n");
    expect(hunk?.removed).toEqual([{ line: 1, text: "-- a/x" }]);
    expect(hunk && firstChangedLine(hunk)).toEqual({
      side: "old",
      line: { line: 1, text: "-- a/x" },
    });
  });
});

describe("parseDiff", () => {
  it("reads every file of git diff output with its status, paths and hunks", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -3,0 +4,2 @@ import x",
      "+limiter();",
      "+--- not a header",
      "diff --git a/test/old.test.ts b/test/old.test.ts",
      "deleted file mode 100644",
      "index 3333333..0000000",
      "--- a/test/old.test.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      '-it("works", () => {});',
      "-",
      "diff --git a/docs/a.md b/docs/b.md",
      "similarity index 100%",
      "rename from docs/a.md",
      "rename to docs/b.md",
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "index 0000000..4444444",
      "Binary files /dev/null and b/logo.png differ",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      'diff --git "a/odd\\tname.txt" "b/odd\\tname.txt"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/odd\\tname.txt"',
      "@@ -0,0 +1 @@",
      "+hi",
      "",
    ].join("\n");
    expect(parseDiff(diff)).toEqual([
      {
        path: "src/app.ts",
        status: "modified",
        hunks: [
          {
            oldStart: 3,
            oldLines: 0,
            newStart: 4,
            newLines: 2,
            removed: [],
            added: [
              { line: 4, text: "limiter();" },
              { line: 5, text: "--- not a header" },
            ],
          },
        ],
      },
      {
        path: "test/old.test.ts",
        status: "removed",
        hunks: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 0,
            newLines: 0,
            removed: [
              { line: 1, text: 'it("works", () => {});' },
              { line: 2, text: "" },
            ],
            added: [],
          },
        ],
      },
      { path: "docs/b.md", previousPath: "docs/a.md", status: "renamed", hunks: [] },
      { path: "logo.png", status: "added" },
      { path: "run.sh", status: "modified", hunks: [] },
      {
        path: "odd\tname.txt",
        status: "added",
        hunks: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            removed: [],
            added: [{ line: 1, text: "hi" }],
          },
        ],
      },
    ]);
  });
});
