import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  type ApiCall,
  type CompileResult,
  compilePolicy,
  type OutputFile,
  type Platform,
  RULER_SOURCE,
} from "@selfhost/compile";
import { handWrittenRulesFiles, runRuler } from "@selfhost/compile/ruler";
import { applyContextPlan, CONTEXT_DIR } from "@selfhost/context";
import {
  COMPILE_VENDORS,
  type CompileVendor,
  type ContextAgent,
  type PolicyCoverage,
  type RuleCoverage,
} from "@selfhost/schema";
import type { Command } from "commander";
import { readConfigFile } from "../config-file.js";
import { layeredBuild } from "../context/commands.js";
import { rememberRepo } from "../context/layers.js";
import { plural, table } from "../format.js";
import { managedHookCommand } from "../hooks/hook-binary.js";
import { configPin } from "../hooks/trust.js";
import { repoDir } from "../scan/index.js";
import type { Fetch } from "../team/client.js";
import { checkTeam, loadPolicy, type PolicyIo } from "./commands.js";
import {
  describeManaged,
  installManaged,
  knownPath,
  type ManagedFile,
  type ManagedReport,
  managedFiles,
  trustManagedFile,
} from "./managed.js";

export interface PolicyCompileIo extends PolicyIo {
  platform: NodeJS.Platform;
  /** Finds a program on PATH, to warn when the hooks' `selfhost` is not there. */
  which?: (name: string) => string | undefined;
  /** HTTP for the GitHub API, used only with --apply. Default: the global fetch. */
  fetch?: Fetch;
  /** The agents found on this machine, for a first context compile (as context compile). */
  detect?: () => ContextAgent[];
}

export interface PolicyCompileOptions {
  config?: string;
  vendor?: string[];
  /** vendor@version, like codex@0.167.0. */
  target?: string[];
  team?: string;
  out?: string;
  apply?: boolean;
  json?: boolean;
  hookCommand?: string;
  githubOrg?: string;
  githubRepo?: string;
  /** Install the system files at the paths each vendor reads, where this user may write. */
  managed?: boolean;
  /** With managed: write under this folder instead of the real system paths. */
  root?: string;
  /** With managed: replace files selfhost did not write. */
  force?: boolean;
}

/** One file written to the output folder. */
export interface CompiledFile {
  vendor: CompileVendor | "rules";
  /** The copy in the output folder. */
  path: string;
  description: string;
  kind: OutputFile["install"]["kind"];
  /** Where it goes on this machine, or for dashboard files where to paste it. */
  target: string | null;
}

export interface CompiledCall {
  method: ApiCall["method"];
  /** With {owner} and {repo} filled in when --github-org was given. */
  path: string;
  description: string;
  status: "planned" | "done" | "skipped" | "failed";
  message: string | null;
}

/** `selfhost policy compile --json`. */
export interface PolicyCompileReport {
  schema: "selfhost.policy_compile/v1";
  config: string;
  team: string | null;
  out: string;
  coverage: PolicyCoverage;
  files: CompiledFile[];
  calls: CompiledCall[];
  /** null without --apply. */
  apply: {
    /** Rules files written through Ruler in the repository, or why not. */
    rules: { root: string | null; written: boolean; message: string };
    /** Commands an admin runs to install the system files; selfhost never runs them. */
    commands: string[];
    /** Steps outside this machine: device management and vendor dashboards. */
    steps: string[];
  } | null;
  /** With --managed: each system file at its path, and the admin commands for the rest. */
  managed: ManagedReport | null;
  /** What may keep the compiled files from working on this machine. */
  warnings: string[];
}

/** The note for compiled hooks that call `selfhost hook` when selfhost is not on PATH. */
export const NOT_ON_PATH_WARNING =
  "selfhost is not on PATH here, and the compiled hooks run selfhost hook: install it (npm install -g selfhostai) on every machine that gets these files, or pass --hook-command.";

const VENDOR_ALIASES: Record<string, CompileVendor> = {
  claude: "claude_code",
  "claude-code": "claude_code",
};

export function parseVendor(value: string): CompileVendor {
  const name = value.trim().toLowerCase();
  const vendor =
    VENDOR_ALIASES[name] ??
    COMPILE_VENDORS.find((candidate) => candidate === name.replaceAll("-", "_"));
  if (!vendor) {
    throw new Error(`--vendor: expected claude, codex, cursor or copilot, got "${value}"`);
  }
  return vendor;
}

function parseTargets(values: string[]): Partial<Record<CompileVendor, string>> {
  const versions: Partial<Record<CompileVendor, string>> = {};
  for (const value of values) {
    const at = value.lastIndexOf("@");
    if (at <= 0 || at === value.length - 1) {
      throw new Error(`--target: expected vendor@version, like codex@0.167.0, got "${value}"`);
    }
    versions[parseVendor(value.slice(0, at))] = value.slice(at + 1);
  }
  return versions;
}

const isPlatform = (platform: string): platform is Platform =>
  platform === "darwin" || platform === "linux" || platform === "win32";

/** Where a file goes on this platform; `~` stays as written for files every user gets. */
function installTarget(file: OutputFile, platform: string): string | null {
  const { install } = file;
  if (install.kind === "dashboard") return install.where;
  if (install.kind === "repo") return install.path;
  return (isPlatform(platform) ? install.paths[platform] : undefined) ?? null;
}

/** The files a Ruler run for these agents writes: rules files, their backups, ignore lists. */
const RULER_WRITES = [
  "AGENTS.md",
  "CLAUDE.md",
  "AGENTS.md.bak",
  "CLAUDE.md.bak",
  ".gitignore",
  join(".git", "info", "exclude"),
];

function rulerSnapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of RULER_WRITES) {
    const path = join(root, name);
    if (existsSync(path)) files.set(name, readFileSync(path, "utf8"));
  }
  return files;
}

/** A path quoted for sh, or for PowerShell on Windows. */
function quote(path: string, platform: string): string {
  return platform === "win32"
    ? `'${path.replaceAll("'", "''")}'`
    : `'${path.replaceAll("'", `'\\''`)}'`;
}

/** The admin command that installs one system file. selfhost prints it and never runs it. */
function installCommand(source: string, target: string, mode: string, platform: string): string {
  if (platform === "win32") {
    const dir = target.slice(0, target.lastIndexOf("\\"));
    return `New-Item -ItemType Directory -Force -Path ${quote(dir, platform)} | Out-Null; Copy-Item -Force ${quote(source, platform)} ${quote(target, platform)}`;
  }
  return `sudo mkdir -p ${quote(dirname(target), platform)} && sudo install -o root -m ${mode} ${quote(source, platform)} ${quote(target, platform)}`;
}

function writeOut(out: string, result: CompileResult): Map<OutputFile, string> {
  const written = new Map<OutputFile, string>();
  // Only selfhost's own folders, so files from an earlier compile that no longer apply go.
  for (const name of [...COMPILE_VENDORS, "rules"]) {
    rmSync(join(out, name), { recursive: true, force: true });
  }
  const put = (file: OutputFile, folder: string) => {
    const path = join(out, folder, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content, {
      mode: file.install.kind === "system" && file.install.mode === "0755" ? 0o755 : 0o644,
    });
    written.set(file, path);
  };
  for (const vendor of result.vendors) {
    for (const file of vendor.files) put(file, vendor.vendor);
    if (vendor.calls.length > 0) {
      const path = join(out, vendor.vendor, "api-calls.json");
      writeFileSync(path, `${JSON.stringify(vendor.calls, null, 2)}\n`);
    }
  }
  if (result.rules) put(result.rules, "rules");
  writeFileSync(join(out, "coverage.json"), `${JSON.stringify(result.coverage, null, 2)}\n`);
  return written;
}

const CELL: Record<RuleCoverage["status"], string> = {
  compiled: "compiled",
  partial: "partial",
  not_expressible: "none",
  not_applicable: "n/a",
};

function printCoverage(coverage: PolicyCoverage, write: (line: string) => void): void {
  const vendors = coverage.vendors.map((vendor) => vendor.vendor);
  const byRule = new Map<string, RuleCoverage[]>();
  for (const entry of coverage.rules) {
    byRule.set(entry.rule_id, [...(byRule.get(entry.rule_id) ?? []), entry]);
  }
  const rows = [...byRule.entries()].map(([rule, entries]) => [
    rule,
    entries[0]?.mode ?? "",
    ...vendors.map((vendor) => {
      const entry = entries.find((candidate) => candidate.vendor === vendor);
      if (!entry) return "";
      return `${CELL[entry.status]}${entry.hook === "none" ? "" : "+hook"}`;
    }),
  ]);
  table([["rule", "mode", ...vendors], ...rows], write);
  write("");
  write(
    "compiled: the vendor's own settings cover every call the rule matches. partial: some. none: the vendor can't express it. +hook: the selfhost hook checks what the settings miss (observe rules: records hits).",
  );
  const gaps = coverage.rules.filter(
    (entry) => entry.status === "partial" || entry.status === "not_expressible",
  );
  if (gaps.length > 0) {
    write("");
    write("Gaps:");
    for (const entry of gaps) write(`  ${entry.vendor} ${entry.rule_id}: ${entry.detail}`);
  }
  const notes = coverage.vendors.filter((vendor) => vendor.notes.length > 0);
  if (notes.length > 0) {
    write("");
    write("Vendor notes:");
    for (const vendor of notes)
      for (const note of vendor.notes) write(`  ${vendor.vendor}: ${note}`);
  }
}

function githubToken(env: NodeJS.ProcessEnv): string | undefined {
  return env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || undefined;
}

const GITHUB_API = "https://api.github.com";
const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2026-03-10",
};

/** Makes one call. The token goes in a header only and is never printed. */
async function makeCall(
  call: ApiCall,
  path: string,
  token: string,
  fetch: Fetch,
): Promise<{ ok: boolean; message: string }> {
  const headers = { ...GITHUB_HEADERS, authorization: `Bearer ${token}` };
  let sha: string | undefined;
  if (call.needsSha) {
    const current = await fetch(`${GITHUB_API}${path}`, { method: "GET", headers });
    if (current.ok) {
      const body = (await current.json()) as { sha?: unknown };
      if (typeof body.sha === "string") sha = body.sha;
    } else if (current.status !== 404) {
      return { ok: false, message: `GET ${path} answered ${current.status}` };
    }
  }
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: call.method,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ ...call.body, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) return { ok: false, message: `${call.method} ${path} answered ${res.status}` };
  return { ok: true, message: `${call.method} ${path} answered ${res.status}` };
}

type ApplyReport = NonNullable<PolicyCompileReport["apply"]>;

/** The admin commands and manual steps that put each file where it goes on this platform. */
function installSteps(
  written: Map<OutputFile, string>,
  platform: string,
): Pick<ApplyReport, "commands" | "steps"> {
  const commands: string[] = [];
  const steps: string[] = [];
  for (const [file, source] of written) {
    const target = installTarget(file, platform);
    if (target === null) continue;
    if (file.install.kind === "system") {
      commands.push(installCommand(source, target, file.install.mode, platform));
    } else if (file.install.kind === "mdm") {
      steps.push(`Deliver ${source} to ${target} on each machine with device management.`);
    } else if (file.install.kind === "dashboard") {
      steps.push(`Paste ${source} into ${target}.`);
    }
  }
  return { commands, steps };
}

/** Puts the policy text in .ruler/ and runs Ruler, unless it would replace hand-written files. */
async function writeRules(
  root: string | undefined,
  result: CompileResult,
  vendors: CompileVendor[],
  io: Pick<PolicyCompileIo, "configPath" | "detect">,
): Promise<ApplyReport["rules"]> {
  if (!result.rules) {
    return {
      root: root ?? null,
      written: false,
      message: "No rule is on, so there is no rules text.",
    };
  }
  if (!root) {
    return {
      root: null,
      written: false,
      message: "Not in a git repository, so no rules files were written.",
    };
  }
  if (existsSync(join(root, CONTEXT_DIR))) {
    return writeRulesWithContext(root, result.rules.content, io);
  }
  const handWritten = handWrittenRulesFiles(root);
  if (handWritten.length > 0) {
    return {
      root,
      written: false,
      message: `Ruler would replace ${handWritten.join(" and ")}, which it did not write. Move their text into .ruler/ (npx @intellectronica/ruler init), then compile again.`,
    };
  }
  const before = rulerSnapshot(root);
  const source = join(root, RULER_SOURCE);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, result.rules.content);
  await runRuler(root, vendors);
  const after = rulerSnapshot(root);
  const changed = [...after.keys()].filter((name) => after.get(name) !== before.get(name));
  return {
    root,
    written: true,
    message: `Wrote ${RULER_SOURCE}; Ruler then wrote ${changed.length > 0 ? changed.join(", ") : "nothing new"}.`,
  };
}

/**
 * In a repository with .selfhost/context, `selfhost context compile` owns the rules files and
 * puts .ruler/ in them: the policy text goes to .ruler/ and the context compile writes the
 * files, so neither compile undoes the other. It is the same compile, with the same layers and
 * agents, so selfhost context check passes afterwards.
 */
async function writeRulesWithContext(
  root: string,
  text: string,
  io: Pick<PolicyCompileIo, "configPath" | "detect">,
): Promise<ApplyReport["rules"]> {
  const source = join(root, RULER_SOURCE);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, text);
  const { built, local } = await layeredBuild(
    root,
    { layers: io.configPath !== undefined },
    { configPath: io.configPath ?? "", ...(io.detect ? { detect: io.detect } : {}) },
  );
  if (!built.ok) {
    return {
      root,
      written: false,
      message: `Wrote ${RULER_SOURCE}, but ${CONTEXT_DIR} has problems, so no rules file was written. Run selfhost context compile to see them.`,
    };
  }
  if (built.plan.conflicts.length > 0) {
    return {
      root,
      written: false,
      message: `Wrote ${RULER_SOURCE}; selfhost context compile would replace files it did not write, so nothing else was written. Run it to see which.`,
    };
  }
  applyContextPlan(root, built.plan);
  if (io.configPath && local.layers.some((layer) => layer.kind !== "personal")) {
    rememberRepo(io.configPath, root);
  }
  const changed = built.plan.files
    .filter((file) => file.action !== "unchanged")
    .map((file) => file.path);
  return {
    root,
    written: true,
    message: `Wrote ${RULER_SOURCE}; selfhost context compile then wrote ${changed.length > 0 ? changed.join(", ") : "nothing new"}.`,
  };
}

/** Makes the GitHub calls when an org and a token are given, and records each outcome. */
async function makeCalls(
  entries: CompiledCall[],
  calls: { call: ApiCall; path: string }[],
  owner: string | undefined,
  token: string | undefined,
  fetcher: Fetch = (url, init) => fetch(url, init),
): Promise<void> {
  for (const [index, { call, path }] of calls.entries()) {
    const entry = entries[index];
    if (!entry) continue;
    if (owner === undefined) {
      entry.status = "skipped";
      entry.message =
        "Pass --github-org with the enterprise organization that owns .github-private.";
    } else if (!token) {
      entry.status = "skipped";
      entry.message = "Set GITHUB_TOKEN to a token that can write the repository.";
    } else {
      const done = await makeCall(call, path, token, fetcher);
      entry.status = done.ok ? "done" : "failed";
      entry.message = done.message;
    }
  }
}

/**
 * Compiles selfhost.toml into each vendor's native controls, writes them to the output folder
 * and prints the coverage of every rule per vendor. With `apply`, it writes the rules files
 * through Ruler in the repository, makes the GitHub API calls when a token and an org are
 * given, and prints the admin commands that install the system files: it never runs them.
 */
export async function policyCompile(
  options: PolicyCompileOptions,
  io: PolicyCompileIo,
): Promise<PolicyCompileReport> {
  const { location, config } = loadPolicy(io.cwd, options.config, io);
  checkTeam(config, options.team, location.path);
  const vendors = options.vendor?.length
    ? [...new Set(options.vendor.map(parseVendor))]
    : undefined;
  // Root-owned managed settings run selfhost by the absolute path it has now, not through PATH,
  // which the person (and so an agent running as them) can change.
  const binary =
    options.managed && options.hookCommand === undefined
      ? managedHookCommand(io.which, io.platform)
      : undefined;
  const result = compilePolicy(config, {
    vendors,
    versions: parseTargets(options.target ?? []),
    team: options.team,
    hookCommand: options.hookCommand ?? binary?.command,
  });
  const root = repoDir(undefined, io.cwd);
  const out = resolve(io.cwd, options.out ?? join(root ?? io.cwd, ".selfhost", "compiled"));
  const written = writeOut(out, result);
  const compiled = result.vendors.map((vendor) => vendor.vendor);
  if (result.rules)
    await runRuler(join(out, "rules"), compiled, { gitignore: false, backup: false });

  const files: CompiledFile[] = [...written].map(([file, path]) => {
    const vendor =
      result.vendors.find((output) => output.files.includes(file))?.vendor ?? ("rules" as const);
    return {
      vendor,
      path,
      description: file.description,
      kind: file.install.kind,
      target: installTarget(file, io.platform),
    };
  });
  const owner = options.githubOrg;
  const repo = options.githubRepo ?? ".github-private";
  const calls = result.vendors.flatMap((vendor) =>
    vendor.calls.map((call) => ({
      call,
      path:
        owner === undefined
          ? call.path
          : call.path
              .replace("{owner}", encodeURIComponent(owner))
              .replace("{repo}", encodeURIComponent(repo)),
    })),
  );
  const report: PolicyCompileReport = {
    schema: "selfhost.policy_compile/v1",
    config: location.path,
    team: options.team ?? null,
    out,
    coverage: result.coverage,
    files,
    calls: calls.map(({ call, path }) => ({
      method: call.method,
      path,
      description: call.description,
      status: "planned",
      message: null,
    })),
    apply: null,
    managed: null,
    warnings:
      options.hookCommand === undefined && io.which && !io.which("selfhost")
        ? [NOT_ON_PATH_WARNING]
        : [],
  };

  if (options.managed) {
    const compiled = managedFiles(result, io.platform);
    // On a laptop in a team, the server's grant-signing keys pinned in config.json go into the
    // root-owned trust file with the rest, so an agent cannot swap them. Staged in the output
    // folder like the others.
    const pin = io.configPath ? configPin(readConfigFile(io.configPath)) : undefined;
    const trust = pin && trustManagedFile(io.platform, pin.server, pin.keys);
    const files: ManagedFile[] = trust ? [...compiled, trust] : compiled;
    report.managed = installManaged(files, {
      platform: io.platform,
      ...(options.root === undefined ? {} : { root: resolve(io.cwd, options.root) }),
      staging: out,
      known: io.configPath ? knownPath(io.configPath) : join(out, "managed-known.json"),
      write: true,
      force: options.force === true,
      sources: new Map(compiled.map((file) => [file, join(out, file.vendor, file.name)])),
    });
  }

  if (options.apply) {
    report.apply = {
      rules: await writeRules(root, result, compiled, io),
      ...installSteps(written, io.platform),
      // --managed installed what it could and says what is left.
      ...(report.managed ? { commands: report.managed.commands } : {}),
    };
    await makeCalls(report.calls, calls, owner, githubToken(io.env), io.fetch);
  }

  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
  } else {
    print(report, io);
  }
  if (report.calls.some((call) => call.status === "failed")) io.setExitCode(1);
  if (report.managed?.files.some((file) => file.status === "failed")) io.setExitCode(1);
  return report;
}

function print(report: PolicyCompileReport, io: PolicyCompileIo): void {
  const shown = (path: string) => {
    const rel = relative(io.cwd, path);
    return rel === "" || rel.startsWith("..") ? path : rel;
  };
  const vendors = report.coverage.vendors.map((vendor) => `${vendor.vendor} ${vendor.version}`);
  for (const warning of report.warnings) io.write(`Note: ${warning}`);
  io.write(
    `Compiled ${shown(report.config)}${report.team ? ` for team ${report.team}` : ""} for ${vendors.join(", ")} into ${shown(report.out)}.`,
  );
  io.write("");
  printCoverage(report.coverage, io.write);
  io.write("");
  io.write(`Wrote ${plural(report.files.length, "file")}:`);
  table(
    report.files.map((file) => [
      `  ${shown(file.path)}`,
      file.kind === "system"
        ? `install at ${file.target ?? "(not on this platform)"}`
        : file.kind === "mdm"
          ? `device management delivers it to ${file.target}`
          : file.kind === "dashboard"
            ? `paste into ${file.target}`
            : `goes in the repository at ${file.target}`,
    ]),
    io.write,
  );
  if (report.calls.length > 0) {
    io.write("");
    io.write("GitHub API calls:");
    for (const call of report.calls) {
      io.write(
        `  ${call.method} ${call.path} (${call.status}${call.message ? `: ${call.message}` : ""})`,
      );
    }
  }
  if (report.managed) {
    io.write("");
    const lines = describeManaged(report.managed);
    if (lines.length === 0)
      io.write("No managed settings file goes to a system path on this platform.");
    for (const line of lines) io.write(line);
  }
  const apply = report.apply;
  if (!apply) {
    if (report.managed) return;
    io.write("");
    io.write(
      "Nothing was installed. Run again with --managed to install the managed settings here, or --apply to write the rules files and print the install commands.",
    );
    return;
  }
  io.write("");
  io.write(`Rules files: ${apply.rules.message}`);
  if (apply.commands.length > 0 && !report.managed) {
    io.write("");
    io.write("Install the system files as an admin (selfhost does not run these):");
    for (const command of apply.commands) io.write(`  ${command}`);
  }
  if (apply.steps.length > 0) {
    io.write("");
    io.write("Then:");
    for (const step of apply.steps) io.write(`  ${step}`);
  }
}

/** Adds `policy compile`, creating the `policy` group if it is not there. */
export function registerPolicyCompile(
  program: Command,
  io: () => PolicyCompileIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const policy =
    program.commands.find((c) => c.name() === "policy") ??
    program.command("policy").description("check and observe the rules in selfhost.toml");

  policy
    .command("compile")
    .description(
      "compile selfhost.toml into each agent's own settings and print what each vendor covers per rule",
    )
    .option("--vendor <name...>", "claude, codex, cursor or copilot (default: all)")
    .option(
      "--target <vendor@version...>",
      "vendor config version to write for, like codex@0.167.0",
    )
    .option("--out <dir>", "output folder (default: .selfhost/compiled in the repository)")
    .option(
      "--apply",
      "write the rules files through Ruler, make the GitHub calls, and print the admin install commands",
    )
    .option(
      "--managed",
      "install the managed settings at the system paths each vendor reads, where you may write; prints the admin command for the rest",
    )
    .option("--root <dir>", "with --managed: write under this folder instead of / (images, checks)")
    .option("--force", "with --managed: replace managed files selfhost did not write")
    .option("--team <name>", "apply this team's overrides")
    .option("--hook-command <command>", "command the hooks run; {agent} is the agent id")
    .option(
      "--github-org <org>",
      "enterprise organization that owns the Copilot settings repository",
    )
    .option("--github-repo <name>", "repository for Copilot managed settings", ".github-private")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--json", "print JSON")
    .action(async (options: PolicyCompileOptions) => {
      try {
        await policyCompile(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
