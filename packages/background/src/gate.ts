import { checkCommand, type Fetch } from "@selfhost/package-guard";
import { isManifest, newDependencies } from "@selfhost/pr";
import type { Sandbox } from "@selfhost/runtime";
import {
  type GateCheck,
  type GateMode,
  PACKAGE_RULE_IDS,
  type ResolvedSelfhostConfig,
  type RunGate,
} from "@selfhost/schema";
import { sh } from "./agents.js";

/** Most characters of failing test output kept on the gate. */
const MAX_OUTPUT = 4000;

/** Files that look like tests, in the layouts of the common test runners. */
const TEST_FILE = [
  /(^|\/)(test|tests|__tests__|spec|specs)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.go$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
  /_spec\.rb$/,
  /Test\.(java|kt)$/,
];

export const isTestFile = (path: string) => TEST_FILE.some((pattern) => pattern.test(path));

export interface GateOptions {
  mode: GateMode;
  /** [background] test_command, else detected. */
  testCommand?: string;
  /** [runtime] setup, run in the base checkout before its tests. */
  setup?: string;
  /** [background] pr_size_cap; 0 for none. */
  sizeCap: number;
  /** The team's config, for [packages] (registries, allow list, mode). */
  config: ResolvedSelfhostConfig;
  /** HTTP for the registry lookups. Without it, added packages are not looked up. */
  fetch?: Fetch;
  now: () => Date;
  /** Most milliseconds one test command may take. */
  testTimeoutMs?: number;
}

export interface GateInput {
  sandbox: Sandbox;
  /** The checkout. */
  dir: string;
  baseSha: string;
  runId: string;
}

type CommandFrom = NonNullable<RunGate["command_from"]>;

const tail = (text: string) => (text.length > MAX_OUTPUT ? `...${text.slice(-MAX_OUTPUT)}` : text);

async function read(sandbox: Sandbox, dir: string, command: string): Promise<string | undefined> {
  const result = await sandbox.exec(command, { cwd: dir });
  return result.exitCode === 0 ? result.stdout : undefined;
}

/**
 * The repo's test command: [background] test_command, else the test script in package.json
 * (run with the lockfile's package manager), pytest for a Python project, cargo test, go test,
 * or the first test step in a GitHub Actions workflow.
 */
export async function detectTestCommand(
  sandbox: Sandbox,
  dir: string,
  configured: string | undefined,
): Promise<{ command: string; from: CommandFrom } | undefined> {
  if (configured) return { command: configured, from: "config" };
  const files = new Set(
    ((await read(sandbox, dir, "ls -1A")) ?? "").split("\n").map((name) => name.trim()),
  );
  if (files.has("package.json")) {
    try {
      const pkg = JSON.parse((await read(sandbox, dir, "cat package.json")) ?? "{}");
      if (typeof pkg?.scripts?.test === "string" && !/no test specified/.test(pkg.scripts.test)) {
        const manager = files.has("pnpm-lock.yaml")
          ? "pnpm"
          : files.has("yarn.lock")
            ? "yarn"
            : files.has("bun.lockb") || files.has("bun.lock")
              ? "bun"
              : "npm";
        return { command: `${manager} test`, from: "package.json" };
      }
    } catch {
      // An unreadable package.json names no test command.
    }
  }
  if (files.has("pyproject.toml") || files.has("pytest.ini") || files.has("setup.cfg")) {
    return { command: "python -m pytest", from: "pyproject" };
  }
  if (files.has("Cargo.toml")) return { command: "cargo test", from: "cargo" };
  if (files.has("go.mod")) return { command: "go test ./...", from: "go" };
  const workflows = await read(
    sandbox,
    dir,
    "cat .github/workflows/*.yml .github/workflows/*.yaml 2>/dev/null",
  );
  const step = /^\s*-?\s*run:\s*(.*\btest\b.*)$/m.exec(workflows ?? "");
  if (step?.[1]) return { command: step[1].trim().replace(/^["']|["']$/g, ""), from: "ci" };
  return undefined;
}

const ECOSYSTEM_INSTALL: { pattern: RegExp; install: string }[] = [
  { pattern: /(^|\/)package\.json$/, install: "npm install" },
  { pattern: /(^|\/)(requirements[^/]*\.txt|pyproject\.toml)$/, install: "pip install" },
  { pattern: /(^|\/)Cargo\.toml$/, install: "cargo add" },
  { pattern: /(^|\/)go\.mod$/, install: "go get" },
];

/** Packages the diff adds to a manifest that their registry says do not exist. */
async function missingPackages(
  input: GateInput,
  changed: string[],
  options: GateOptions,
): Promise<{ checked: number; missing: string[] } | undefined> {
  const manifests = changed.filter((path) => isManifest(path));
  if (manifests.length === 0) return { checked: 0, missing: [] };
  const changes = [];
  for (const path of manifests) {
    const before = await read(input.sandbox, input.dir, `git show ${input.baseSha}:${sh(path)}`);
    const after = await read(input.sandbox, input.dir, `cat ${sh(path)}`);
    changes.push({
      path,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    });
  }
  const added = newDependencies(changes);
  if (added.length === 0) return { checked: 0, missing: [] };
  if (!options.fetch) return undefined;
  const missing: string[] = [];
  for (const { pattern, install } of ECOSYSTEM_INSTALL) {
    const names = added.filter((dep) => pattern.test(dep.manifest)).map((dep) => dep.name);
    if (names.length === 0) continue;
    // Looked up whatever [packages] mode says: the gate checks every package the diff adds.
    const config = {
      ...options.config,
      packages: { ...options.config.packages, mode: "enforce" as const },
    };
    const report = await checkCommand(`${install} ${names.map(sh).join(" ")}`, config, {
      fetch: options.fetch,
      now: options.now,
    });
    for (const install of report.installs) {
      for (const pkg of install.packages) {
        if (pkg.findings.some((finding) => finding.rule_id === PACKAGE_RULE_IDS.not_found)) {
          missing.push(`${pkg.name} (${install.ecosystem})`);
        }
      }
    }
  }
  return { checked: added.length, missing };
}

/**
 * The tests-first gate, run in the sandbox after the agent finished and its work is committed:
 *
 * - tests_first: the run added or changed a test file, and the test command fails on the base
 *   with those test files and passes on the head;
 * - tests_pass: the test command passes on the head;
 * - dependencies: every package the diff adds to a manifest exists in its registry;
 * - size: the diff is at most [background] pr_size_cap changed lines.
 *
 * In observe it reports; in enforce a failure means no pull request. Off skips it.
 */
export async function runGate(input: GateInput, options: GateOptions): Promise<RunGate> {
  const { sandbox, dir, baseSha } = input;
  const skipped = (summary: string): RunGate => ({
    mode: options.mode,
    result: "skipped",
    command: null,
    tests_changed: [],
    checks: [],
    summary,
    blocked: false,
  });
  if (options.mode === "off")
    return skipped("The tests-first gate is off ([background] tests_first).");

  const changed = ((await read(sandbox, dir, `git diff --name-only ${baseSha} HEAD`)) ?? "")
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
  // Tests the head still has: a deleted test file cannot be run against the base.
  const kept = (
    (await read(sandbox, dir, `git diff --name-only --diff-filter=d ${baseSha} HEAD`)) ?? ""
  )
    .split("\n")
    .map((path) => path.trim());
  const testsChanged = changed.filter((path) => isTestFile(path) && kept.includes(path));
  const checks: GateCheck[] = [];
  let output: string | undefined;

  const found = await detectTestCommand(sandbox, dir, options.testCommand);
  const timeoutMs = options.testTimeoutMs ?? 20 * 60_000;
  if (!found) {
    checks.push({
      name: "tests_pass",
      ok: false,
      detail: "No test command: set [background] test_command in selfhost.toml",
    });
  } else {
    const head = await sandbox.exec(found.command, { cwd: dir, timeoutMs });
    const headOk = head.exitCode === 0 && !head.timedOut;
    if (!headOk) output = tail(`${head.stdout}${head.stderr}`);
    checks.push({
      name: "tests_pass",
      ok: headOk,
      detail: headOk
        ? `${found.command} passes on the head`
        : `${found.command} ${head.timedOut ? "timed out" : `exited ${head.exitCode}`} on the head`,
    });
    if (testsChanged.length === 0) {
      checks.push({ name: "tests_first", ok: false, detail: "The run added or changed no test" });
    } else {
      const baseDir = `/tmp/selfhost-base-${input.runId.replace(/[^A-Za-z0-9_-]/g, "")}`;
      const prepared = await sandbox.exec(
        [
          `git worktree add --detach ${sh(baseDir)} ${baseSha}`,
          ...testsChanged.map(
            (path) =>
              `mkdir -p "$(dirname ${sh(`${baseDir}/${path}`)})" && git show HEAD:${sh(path)} > ${sh(`${baseDir}/${path}`)}`,
          ),
        ].join(" && "),
        { cwd: dir },
      );
      if (prepared.exitCode !== 0) {
        checks.push({
          name: "tests_first",
          ok: false,
          detail: "Could not check out the base to run the new tests against it",
        });
      } else {
        if (options.setup) await sandbox.exec(options.setup, { cwd: baseDir, timeoutMs });
        const base = await sandbox.exec(found.command, { cwd: baseDir, timeoutMs });
        await sandbox.exec(`git worktree remove --force ${sh(baseDir)}`, { cwd: dir });
        const failedOnBase = base.exitCode !== 0;
        const ok = failedOnBase && headOk;
        checks.push({
          name: "tests_first",
          ok,
          detail: !failedOnBase
            ? `The changed tests (${testsChanged.length}) already pass on the base, so they do not test the change`
            : headOk
              ? `The changed tests (${testsChanged.length}) fail on the base and pass on the head`
              : "The changed tests fail on the base, but the head fails too",
        });
      }
    }
  }

  const packages = await missingPackages(input, changed, options);
  checks.push(
    packages === undefined
      ? {
          name: "dependencies",
          ok: true,
          detail: "Added packages were not looked up (no registry access)",
        }
      : packages.missing.length > 0
        ? {
            name: "dependencies",
            ok: false,
            detail: `Not in their registry: ${packages.missing.join(", ")}`,
          }
        : {
            name: "dependencies",
            ok: true,
            detail:
              packages.checked === 0
                ? "No packages added"
                : `${packages.checked} added packages exist in their registries`,
          },
  );

  const numstat = (await read(sandbox, dir, `git diff --numstat ${baseSha} HEAD`)) ?? "";
  const size = numstat
    .split("\n")
    .map((row) => row.split("\t"))
    .reduce((sum, [added, removed]) => sum + (Number(added) || 0) + (Number(removed) || 0), 0);
  if (options.sizeCap > 0) {
    const ok = size <= options.sizeCap;
    checks.push({
      name: "size",
      ok,
      detail: ok
        ? `${size} changed lines, under the cap of ${options.sizeCap}`
        : `${size} changed lines, over the cap of ${options.sizeCap} ([background] pr_size_cap)`,
    });
  }

  const failed = checks.filter((check) => !check.ok);
  const result = failed.length === 0 ? "passed" : "failed";
  return {
    mode: options.mode,
    result,
    command: found?.command ?? null,
    ...(found ? { command_from: found.from } : {}),
    tests_changed: testsChanged,
    checks,
    summary:
      result === "passed"
        ? "Tests first: a new test fails on the base and passes here; packages exist; size is in bounds."
        : `Tests first failed: ${failed.map((check) => check.detail).join("; ")}.`,
    ...(output ? { output } : {}),
    blocked: result === "failed" && options.mode === "enforce",
  };
}
