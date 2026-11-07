import type { ChangedFile, DiffLine } from "./types.js";

const CODE =
  "(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|kts|scala|groovy|cs|php|swift|exs?|dart|c|cc|cpp)";

/** Test files by name, across the common languages and their runners. */
const TEST_FILES: readonly RegExp[] = [
  /(?:^|\/)__tests__\//,
  /\.(?:test|spec|cy)\.[cm]?[jt]sx?$/,
  /(?:^|\/)test_[^/]*\.py$/,
  /_test\.(?:py|go|exs|dart)$/,
  /_(?:spec|test)\.rb$/,
  /(?:Test|Tests|Spec|IT)\.(?:java|kt|kts|scala|groovy|cs|php|swift)$/,
  new RegExp(`(?:^|/)(?:tests?|specs?|e2e)/(?:.+/)?[^/]+\\.${CODE}$`),
];

export function isTestFile(path: string): boolean {
  return TEST_FILES.some((pattern) => pattern.test(path));
}

/** Lines that turn a test off, or focus one so the rest of its file does not run. */
const SKIP_MARKERS: readonly RegExp[] = [
  /\b(?:describe|context|suite|it|test|specify)\.(?:skip(?:If)?|only)\b/,
  /(?:^|[^\w.$])[xf](?:it|describe|test|context|specify)\s*\(/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/,
  /\bpytest\.skip\s*\(/,
  /\bself\.skipTest\s*\(/,
  /\bt\.Skip(?:f|Now)?\s*\(/,
  /#\[ignore\b/,
  /@(?:Disabled|Ignore)\b/,
];

/** Lines that declare one test. */
const TEST_DECLARATIONS: readonly RegExp[] = [
  /^\s*(?:it|test|specify)(?:\.\w+)*\s*\(/,
  /^\s*(?:it|test|specify)\s+["']/,
  /^\s*(?:async\s+)?def\s+test\w*\s*\(/,
  /^\s*func\s+(?:Test|Benchmark|Fuzz)\w*\s*\(/,
  /^\s*#\[(?:\w+::)?test\b/,
  /^\s*@(?:Test|ParameterizedTest)\b/,
];

const isDeclaration = (line: string) => TEST_DECLARATIONS.some((pattern) => pattern.test(line));

/** A test's name: its first quoted string, else its function name, else the whole line. */
function declarationName(line: string): string {
  const quoted = /(["'`])(.*?)\1/.exec(line)?.[2];
  if (quoted !== undefined) return quoted;
  return /\b(?:def|func|fn)\s+(\w+)/.exec(line)?.[1] ?? line.trim();
}

/** The skip marker on a line, without trailing parentheses or spaces. */
export function skipMarker(line: string): string | undefined {
  for (const pattern of SKIP_MARKERS) {
    const match = pattern.exec(line);
    if (match) return match[0].replace(/^[^\w@#.]+/, "").replace(/[\s(]+$/, "");
  }
  return undefined;
}

export type TestChangeKind = "deleted_test_file" | "deleted_test" | "skipped_test";

/** A test the change removed or turned off. */
export interface TestChange {
  kind: TestChangeKind;
  path: string;
  /** The line: on the old side for a deleted test, on the new side for a skipped one. */
  line?: number;
  /** The skip marker, the removed declaration, or how many tests a deleted file held ("" when unknown). */
  detail: string;
}

const trimmed = (lines: DiffLine[]) => new Set(lines.map((l) => l.text.trim()));

/**
 * Tests the change deleted or skipped, from the diff of test files alone: deleted test files,
 * test declarations a file lost (more removed than added, and no longer declared under the same
 * name), and added lines that skip a test or focus one. A line moved or reindented unchanged
 * does not count. Files without hunks are read by status only.
 */
export function testChanges(files: ChangedFile[]): TestChange[] {
  const changes: TestChange[] = [];
  for (const file of files) {
    const removed = file.hunks?.flatMap((hunk) => hunk.removed) ?? [];
    const added = file.hunks?.flatMap((hunk) => hunk.added) ?? [];
    const test =
      isTestFile(file.path) || (file.previousPath !== undefined && isTestFile(file.previousPath));
    if (!test) continue;
    if (file.status === "removed") {
      const count = file.hunks ? removed.filter((l) => isDeclaration(l.text)).length : undefined;
      changes.push({
        kind: "deleted_test_file",
        path: file.path,
        detail: count === undefined ? "" : tests(count),
      });
      continue;
    }
    const before = trimmed(removed);
    for (const line of added) {
      const marker = skipMarker(line.text);
      if (marker && !before.has(line.text.trim())) {
        changes.push({ kind: "skipped_test", path: file.path, line: line.line, detail: marker });
      }
    }
    const lost = removed.filter((l) => isDeclaration(l.text));
    const gained = added.filter((l) => isDeclaration(l.text));
    if (lost.length <= gained.length) continue;
    const kept = new Set(gained.map((l) => declarationName(l.text)));
    const gone = lost.filter((l) => !kept.has(declarationName(l.text)));
    for (const line of gone.slice(0, lost.length - gained.length)) {
      changes.push({
        kind: "deleted_test",
        path: file.path,
        line: line.line,
        detail: line.text.trim(),
      });
    }
  }
  return changes;
}

const tests = (n: number) => `${n} test${n === 1 ? "" : "s"}`;
