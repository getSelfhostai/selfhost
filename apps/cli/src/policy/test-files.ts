import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { mcpServerOf, normalizePath, type PolicyHit, type ToolCall } from "@selfhost/policy";
import {
  CONFIG_FILE_NAME,
  type DecisionMode,
  type FieldError,
  formatConfigError,
  type PolicyDecision,
  parseConfig,
  parsePolicyTestFile,
  type ResolvedPolicyTestCase,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import { findConfig } from "../find-config.js";
import { plural } from "../format.js";
import { type CallDecision, checkCall, decide, describeDecision } from "./decide.js";

/** Test files are named like the file they test: strict.test.toml tests strict.toml. */
const TEST_FILE_SUFFIX = ".test.toml";
/** The test file `selfhost policy test` runs when given no paths, next to selfhost.toml. */
const DEFAULT_TEST_FILE = CONFIG_FILE_NAME.replace(/\.toml$/, TEST_FILE_SUFFIX);

export interface PolicyTestFilesIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  configPath?: string;
}

export interface PolicyTestFilesOptions {
  /** selfhost.toml every file is run against, instead of the one each file names. */
  config?: string;
  json?: boolean;
}

/** A problem with a test file or the selfhost.toml it tests; its cases did not run. */
export interface PolicyTestFileError {
  path: string;
  field: string;
  line: number | null;
  message: string;
}

export interface PolicyTestCaseResult {
  name: string;
  line: number | null;
  passed: boolean;
  call: ToolCall;
  team: string | null;
  expected: { decision: PolicyDecision; mode: DecisionMode | null; rules: string[] | null };
  actual: CallDecision;
  hits: PolicyHit[];
  /** Why the case failed; empty when it passed. */
  problems: string[];
}

export interface PolicyTestFileReport {
  path: string;
  /** The selfhost.toml the cases ran against; null when none was found. */
  config: string | null;
  errors: PolicyTestFileError[];
  passed: number;
  failed: number;
  cases: PolicyTestCaseResult[];
}

/** `selfhost policy test <paths...> --json`. */
export interface PolicyTestsReport {
  schema: "selfhost.policy_tests/v1";
  passed: number;
  failed: number;
  /** Files whose cases could not run: an invalid test file or selfhost.toml. */
  invalid_files: number;
  files: PolicyTestFileReport[];
}

const shown = (cwd: string, path: string) => relative(cwd, path) || path;

/** Each path as given, or every *.test.toml directly inside a folder, sorted. */
export function collectTestFiles(paths: readonly string[], cwd: string): string[] {
  return paths.flatMap((path) => {
    const full = resolve(cwd, path);
    if (!existsSync(full)) throw new Error(`${path} does not exist`);
    if (!statSync(full).isDirectory()) return [full];
    const found = readdirSync(full)
      .filter((name) => name.endsWith(TEST_FILE_SUFFIX))
      .sort()
      .map((name) => join(full, name));
    if (found.length === 0) throw new Error(`${path} has no *${TEST_FILE_SUFFIX} files`);
    return found;
  });
}

/** selfhost.test.toml next to the selfhost.toml found from here, when given no paths. */
export function defaultTestFile(io: PolicyTestFilesIo): string {
  const location = findConfig(io.cwd, undefined, io.env, io.configPath);
  const where = location ? dirname(location.path) : io.cwd;
  const path = join(where, DEFAULT_TEST_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `No test files given and no ${shown(io.cwd, path)}. Pass test files or folders, or --tool for one call.`,
    );
  }
  return path;
}

/**
 * The selfhost.toml a test file runs against: --config, then the file's own `config` (relative
 * to it), then the file named like it without .test, then the nearest selfhost.toml.
 */
function configFor(
  testPath: string,
  own: string | undefined,
  options: PolicyTestFilesOptions,
  io: PolicyTestFilesIo,
): string | undefined {
  if (options.config !== undefined) return resolve(io.cwd, options.config);
  if (own !== undefined) return resolve(dirname(testPath), own);
  const name = basename(testPath);
  if (name.endsWith(TEST_FILE_SUFFIX)) {
    const sibling = join(dirname(testPath), `${name.slice(0, -TEST_FILE_SUFFIX.length)}.toml`);
    if (existsSync(sibling)) return sibling;
  }
  return findConfig(dirname(testPath), undefined, io.env, io.configPath)?.path;
}

function fileErrors(path: string, errors: FieldError[]): PolicyTestFileError[] {
  return errors.map(({ field, line, message }) => ({ path, field, line: line ?? null, message }));
}

function toolCall(testCase: ResolvedPolicyTestCase): ToolCall {
  const mcpServer = mcpServerOf(testCase.tool);
  return {
    ...(testCase.agent ? { agent: testCase.agent } : {}),
    tool: testCase.tool,
    ...(testCase.command !== undefined ? { command: testCase.command } : {}),
    ...(testCase.path !== undefined ? { path: normalizePath(testCase.path) } : {}),
    ...(testCase.url !== undefined ? { url: testCase.url } : {}),
    ...(mcpServer !== undefined ? { mcpServer } : {}),
    ...(testCase.model !== undefined ? { model: testCase.model } : {}),
  };
}

/** A case whose team is not in the policy did not run. */
const TEAM_PROBLEM = "team:";

const ruleList = (rules: readonly string[]) =>
  rules.length === 0 ? "no rules" : `rules ${rules.join(", ")}`;

function compare(expected: PolicyTestCaseResult["expected"], actual: CallDecision): string[] {
  const problems: string[] = [];
  if (expected.decision !== actual.decision) {
    problems.push(`decision: expected ${expected.decision}, got ${describeDecision(actual)}`);
  } else if (expected.mode !== null && expected.mode !== actual.mode) {
    problems.push(`mode: expected ${expected.mode}, got ${actual.mode ?? "none"}`);
  }
  if (expected.rules !== null) {
    const missing = expected.rules.filter((rule) => !actual.rules.includes(rule));
    const extra = actual.rules.filter((rule) => !expected.rules?.includes(rule));
    if (missing.length > 0) problems.push(`rules: expected ${missing.join(", ")} to fire`);
    if (extra.length > 0) problems.push(`rules: ${extra.join(", ")} also fired`);
  }
  return problems;
}

async function runCase(
  config: ResolvedSelfhostConfig,
  testCase: ResolvedPolicyTestCase,
  line: number | undefined,
): Promise<PolicyTestCaseResult> {
  const call = toolCall(testCase);
  const team = testCase.team ?? null;
  const expected = {
    decision: testCase.decision,
    mode: testCase.mode ?? null,
    rules: testCase.rules ?? null,
  };
  const base = { name: testCase.name, line: line ?? null, call, team, expected };
  if (team !== null && !Object.hasOwn(config.teams, team)) {
    const actual: CallDecision = { decision: "allow", mode: null, rules: [] };
    const problems = [`${TEAM_PROBLEM} "${team}" has no [teams.${team}] table in the policy`];
    return { ...base, passed: false, actual, hits: [], problems };
  }
  const hits = await checkCall(config, call, team === null ? {} : { team });
  const actual = decide(hits);
  const problems = compare(expected, actual);
  return { ...base, passed: problems.length === 0, actual, hits, problems };
}

async function runFile(
  path: string,
  options: PolicyTestFilesOptions,
  io: PolicyTestFilesIo,
): Promise<PolicyTestFileReport> {
  const report: PolicyTestFileReport = {
    path,
    config: null,
    errors: [],
    passed: 0,
    failed: 0,
    cases: [],
  };
  const parsed = parsePolicyTestFile(readFileSync(path, "utf8"));
  if (!parsed.ok) {
    report.errors = fileErrors(path, parsed.errors);
    return report;
  }
  const configPath = configFor(path, parsed.file.config, options, io);
  if (configPath === undefined) {
    report.errors = fileErrors(path, [
      {
        field: "config",
        message: `No ${CONFIG_FILE_NAME} found for this file. Set config, or pass --config.`,
      },
    ]);
    return report;
  }
  report.config = configPath;
  if (!existsSync(configPath)) {
    report.errors = fileErrors(path, [
      { field: "config", message: `${shown(io.cwd, configPath)} does not exist` },
    ]);
    return report;
  }
  const policy = parseConfig(readFileSync(configPath, "utf8"));
  if (!policy.ok) {
    report.errors = fileErrors(configPath, policy.errors);
    return report;
  }
  for (const [index, testCase] of parsed.file.cases.entries()) {
    const result = await runCase(policy.config, testCase, parsed.lines[index]);
    report.cases.push(result);
    if (result.passed) report.passed += 1;
    else report.failed += 1;
  }
  return report;
}

function expectedText(expected: PolicyTestCaseResult["expected"]): string {
  const decision =
    expected.mode === null ? expected.decision : `${expected.decision} (${expected.mode})`;
  return expected.rules === null ? decision : `${decision}, ${ruleList(expected.rules)}`;
}

function printFile(file: PolicyTestFileReport, io: PolicyTestFilesIo): void {
  const path = shown(io.cwd, file.path);
  if (file.errors.length > 0) {
    io.write(`${path}: not run, ${plural(file.errors.length, "error")}`);
    for (const { path: where, field, line, message } of file.errors) {
      const error = line === null ? { field, message } : { field, message, line };
      io.write(`  ${formatConfigError(error, shown(io.cwd, where))}`);
    }
    return;
  }
  const against = file.config === null ? "" : ` (${shown(io.cwd, file.config)})`;
  const failed = file.failed > 0 ? `, ${file.failed} failed` : "";
  io.write(`${path}${against}: ${file.passed} passed${failed}`);
  for (const result of file.cases.filter((entry) => !entry.passed)) {
    const where = result.line === null ? path : `${path}:${result.line}`;
    io.write(`  FAIL ${result.name} (${where})`);
    if (result.problems[0]?.startsWith(TEAM_PROBLEM)) {
      io.write(`    ${result.problems[0]}`);
      continue;
    }
    io.write(`    expected ${expectedText(result.expected)}`);
    io.write(`    got      ${describeDecision(result.actual)}, ${ruleList(result.actual.rules)}`);
  }
}

/**
 * Runs every case in the test files against the selfhost.toml each one tests and returns the
 * exit code: 1 when a case fails or a file cannot run.
 */
export async function runPolicyTestFiles(
  files: readonly string[],
  options: PolicyTestFilesOptions,
  io: PolicyTestFilesIo,
): Promise<{ code: number; report: PolicyTestsReport }> {
  const report: PolicyTestsReport = {
    schema: "selfhost.policy_tests/v1",
    passed: 0,
    failed: 0,
    invalid_files: 0,
    files: [],
  };
  for (const path of files) {
    const file = await runFile(path, options, io);
    report.files.push(file);
    report.passed += file.passed;
    report.failed += file.failed;
    if (file.errors.length > 0) report.invalid_files += 1;
  }
  const code = report.failed > 0 || report.invalid_files > 0 ? 1 : 0;
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return { code, report };
  }
  for (const file of report.files) printFile(file, io);
  const total = report.passed + report.failed;
  const invalid =
    report.invalid_files > 0 ? `, ${plural(report.invalid_files, "file")} not run` : "";
  io.write(
    `${code === 0 ? "PASS" : "FAIL"}: ${report.passed} of ${plural(total, "case")} passed in ` +
      `${plural(report.files.length, "file")}${invalid}.`,
  );
  return { code, report };
}
