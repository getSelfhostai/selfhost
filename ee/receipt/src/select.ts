import { posix } from "node:path";
import type { ReceiptRunner } from "@selfhost/schema";
import picomatch from "picomatch/posix.js";

/** A file the pull request touches, with GitHub's status for it. */
export interface ChangedFile {
  /** Path from the repository root, with / separators. */
  path: string;
  /** added, modified, removed, renamed, copied, changed or unchanged. */
  status: string;
  previousPath?: string;
}

/** Looks at files of the checkout by path from the repository root. */
export interface RepoProbe {
  /** The file's text; undefined when it is missing. */
  read(path: string): string | undefined;
  exists(path: string): boolean;
}

/** One command that runs some of the changed tests. */
export interface PlannedTestRun {
  files: string[];
  runner: ReceiptRunner;
  /** The shell command, run in cwd. */
  command: string;
  /** Folder from the repository root, "." for the root. */
  cwd: string;
  /** Folders whose node_modules/.bin go first on PATH, from the repository root. */
  bins: string[];
}

export interface TestPlan {
  runs: PlannedTestRun[];
  notRun: { path: string; reason: string }[];
}

export interface PlanOptions {
  /** [receipt] test_command: {file} runs it once per file, {files} once for all. */
  testCommand?: string;
  /** [receipt] tests: extra test file globs. */
  testGlobs?: string[];
  maxTests: number;
}

const JS = /\.[cm]?[jt]sx?$/;
const JS_TEST = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:(?:^|\/)__tests__\/.+\.[cm]?[jt]sx?$)/;
const PY_TEST = /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/;
const GO_TEST = /_test\.go$/;
/** Test files of runners the receipt does not run itself; listed as not run. */
const OTHER_TEST =
  /(?:_spec\.rb|_test\.rb|Tests?\.(?:java|kt|cs)|_test\.exs|\.(?:test|spec)\.php)$/;

const IGNORED = /(?:^|\/)(?:node_modules|vendor|dist|build)\//;

const globMatchers = new Map<string, (path: string) => boolean>();

function globMatches(glob: string, path: string): boolean {
  let matcher = globMatchers.get(glob);
  if (!matcher) {
    matcher = picomatch(glob, { dot: true });
    globMatchers.set(glob, matcher);
  }
  return matcher(path);
}

/** true for a test file by the usual names of each runner, or by a [receipt] tests glob. */
export function isTestFile(path: string, extraGlobs: readonly string[] = []): boolean {
  if (IGNORED.test(path)) return false;
  if (extraGlobs.some((glob) => globMatches(glob, path))) return true;
  return JS_TEST.test(path) || PY_TEST.test(path) || GO_TEST.test(path) || OTHER_TEST.test(path);
}

/** The test files the pull request adds or changes, in its order; deleted files are left out. */
export function changedTests(changed: ChangedFile[], extraGlobs: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const tests: string[] = [];
  for (const file of changed) {
    if (file.status === "removed" || seen.has(file.path)) continue;
    if (!isTestFile(file.path, extraGlobs)) continue;
    seen.add(file.path);
    tests.push(file.path);
  }
  return tests;
}

/** A word for the shell, quoted only when it needs to be. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The folders from `dir` up to the repository root, nearest first; "." is the root. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  let current = dir === "" ? "." : dir;
  for (;;) {
    out.push(current);
    if (current === ".") return out;
    const parent = posix.dirname(current);
    current = parent === current ? "." : parent;
  }
}

const at = (dir: string, file: string) => (dir === "." ? file : `${dir}/${file}`);

const relative = (from: string, path: string) =>
  from === "." ? path : posix.relative(from, path) || ".";

function readJson(probe: RepoProbe, path: string): Record<string, unknown> | undefined {
  const text = probe.read(path);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const CONFIG_EXTS = ["ts", "mts", "cts", "js", "mjs", "cjs"];

function hasConfig(probe: RepoProbe, dir: string, name: string, exts = CONFIG_EXTS): boolean {
  return exts.some((ext) => probe.exists(at(dir, `${name}.${ext}`)));
}

/** The JavaScript runner of the nearest package that sets one up, walking up from the file. */
function jsRunner(
  probe: RepoProbe,
  file: string,
): { runner: "vitest" | "jest" | "node"; dir: string } | undefined {
  for (const dir of ancestors(posix.dirname(file))) {
    const pkg = readJson(probe, at(dir, "package.json"));
    const vitestConfig = hasConfig(probe, dir, "vitest.config");
    const jestConfig = hasConfig(probe, dir, "jest.config", [...CONFIG_EXTS, "json"]);
    if (!pkg && !vitestConfig && !jestConfig) continue;
    const deps = {
      ...(pkg?.dependencies as Record<string, unknown> | undefined),
      ...(pkg?.devDependencies as Record<string, unknown> | undefined),
    };
    const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
    const test = typeof scripts.test === "string" ? scripts.test : "";
    if (vitestConfig || (!jestConfig && ("vitest" in deps || /\bvitest\b/.test(test)))) {
      return { runner: "vitest", dir };
    }
    if (jestConfig || "jest" in deps || pkg?.jest !== undefined || /\bjest\b/.test(test)) {
      return { runner: "jest", dir };
    }
    if (/\bnode\b[^&|;]*--test\b/.test(test)) return { runner: "node", dir };
  }
  return undefined;
}

const PY_ROOTS = ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini", "setup.py"];

function pythonRoot(probe: RepoProbe, file: string): string {
  for (const dir of ancestors(posix.dirname(file))) {
    if (PY_ROOTS.some((name) => probe.exists(at(dir, name)))) return dir;
  }
  return ".";
}

function python(probe: RepoProbe, dir: string): string {
  for (const venv of [at(dir, ".venv/bin/python"), ".venv/bin/python"]) {
    if (probe.exists(venv)) return relative(dir, venv);
  }
  return "python3";
}

function goModule(probe: RepoProbe, file: string): string | undefined {
  return ancestors(posix.dirname(file)).find((dir) => probe.exists(at(dir, "go.mod")));
}

const bins = (dir: string) => (dir === "." ? ["."] : [dir, "."]);

function customRuns(files: string[], command: string): PlannedTestRun[] {
  const run = (cmd: string, which: string[]): PlannedTestRun => ({
    files: which,
    runner: "custom",
    command: cmd,
    cwd: ".",
    bins: ["."],
  });
  if (command.includes("{files}")) {
    return [run(command.replaceAll("{files}", files.map(shellQuote).join(" ")), files)];
  }
  if (command.includes("{file}")) {
    return files.map((file) => run(command.replaceAll("{file}", shellQuote(file)), [file]));
  }
  return [run(command, files)];
}

/**
 * How to run the tests the pull request adds or changes: with `testCommand` when it is set,
 * else each file with the runner its folder uses. JavaScript files run with the vitest, jest
 * or `node --test` setup of the nearest package.json (or vitest/jest config) above them, one
 * file per run; Python files with pytest from the nearest project root; Go files with go test,
 * once per package. Files with no runner, and runs over `maxTests`, are listed as not run.
 */
export function planTests(
  changed: ChangedFile[],
  probe: RepoProbe,
  options: PlanOptions,
): TestPlan {
  const files = changedTests(changed, options.testGlobs);
  const plan: TestPlan = { runs: [], notRun: [] };
  const runs: PlannedTestRun[] = [];
  if (options.testCommand) {
    runs.push(...customRuns(files, options.testCommand));
  } else {
    const goPackages = new Map<string, PlannedTestRun>();
    for (const file of files) {
      if (JS.test(file)) {
        const found = jsRunner(probe, file);
        if (!found) {
          plan.notRun.push({
            path: file,
            reason:
              "No vitest, jest or node --test setup in a package.json above it; set [receipt] test_command.",
          });
          continue;
        }
        const rel = shellQuote(relative(found.dir, file));
        const command =
          found.runner === "vitest"
            ? `vitest run ${rel}`
            : found.runner === "jest"
              ? `jest --runTestsByPath ${rel}`
              : `node --test ${rel}`;
        runs.push({
          files: [file],
          runner: found.runner,
          command,
          cwd: found.dir,
          bins: bins(found.dir),
        });
      } else if (file.endsWith(".py")) {
        const dir = pythonRoot(probe, file);
        runs.push({
          files: [file],
          runner: "pytest",
          command: `${shellQuote(python(probe, dir))} -m pytest ${shellQuote(relative(dir, file))}`,
          cwd: dir,
          bins: [],
        });
      } else if (file.endsWith(".go")) {
        const module = goModule(probe, file);
        if (module === undefined) {
          plan.notRun.push({ path: file, reason: "No go.mod above it." });
          continue;
        }
        const pkg = relative(module, posix.dirname(file));
        const existing = goPackages.get(`${module}:${pkg}`);
        if (existing) {
          existing.files.push(file);
          continue;
        }
        const run: PlannedTestRun = {
          files: [file],
          runner: "go",
          command: `go test ${shellQuote(pkg === "." ? "." : `./${pkg}`)}`,
          cwd: module,
          bins: [],
        };
        goPackages.set(`${module}:${pkg}`, run);
        runs.push(run);
      } else {
        plan.notRun.push({
          path: file,
          reason: "No built-in runner for this kind of test; set [receipt] test_command.",
        });
      }
    }
  }
  plan.runs = runs.slice(0, options.maxTests);
  for (const run of runs.slice(options.maxTests)) {
    for (const path of run.files) {
      plan.notRun.push({
        path,
        reason: `Over [receipt] max_tests (${options.maxTests} runs).`,
      });
    }
  }
  return plan;
}
