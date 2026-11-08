import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  checkCommand,
  type Fetch,
  type InstallResult,
  type PackageResult,
  packageHits,
} from "@selfhost/package-guard";
import type { PolicyHit } from "@selfhost/policy";
import {
  formatConfigError,
  parseConfig,
  type ResolvedSelfhostConfig,
  validateConfig,
} from "@selfhost/schema";
import type { Command } from "commander";
import { findConfig, policyText } from "./find-config.js";
import { table } from "./format.js";

export interface PackagesIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  setExitCode: (code: number) => void;
  now?: Date;
  /** ~/.selfhost/config.json: lookups are cached beside it, in cache/packages. */
  configPath: string;
  /** Registry HTTP. Default: the global fetch. */
  fetch?: Fetch;
}

export interface PackagesCheckOptions {
  config?: string;
  json?: boolean;
  /** Milliseconds to wait on the registries. */
  timeout?: string;
}

export const PACKAGES_CHECK_SCHEMA = "selfhost.packages_check/v1";

/** `selfhost packages check --json`. */
export interface PackagesCheckReport {
  schema: typeof PACKAGES_CHECK_SCHEMA;
  command: string;
  /** The selfhost.toml used; null when there is none and the defaults apply. */
  config: string | null;
  mode: ResolvedSelfhostConfig["packages"]["mode"];
  installs: InstallResult[];
  hits: PolicyHit[];
}

/** A manual check is not waiting on an agent, so it gives the registries longer than a hook. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** The policy in force here, or the defaults when there is no selfhost.toml. */
function policy(
  options: PackagesCheckOptions,
  io: PackagesIo,
): { path?: string; config: ResolvedSelfhostConfig } {
  const location = findConfig(io.cwd, options.config, io.env, io.configPath);
  if (!location) {
    const defaults = validateConfig({ version: 1 });
    if (!defaults.ok) throw new Error("The default selfhost.toml does not validate");
    return { config: defaults.config };
  }
  if (!existsSync(location.path)) throw new Error(`${location.path} does not exist`);
  const result = parseConfig(policyText(location).text);
  if (!result.ok) {
    const file = relative(io.cwd, location.path) || location.path;
    const lines = result.errors.map((error) => `  ${formatConfigError(error, file)}`);
    throw new Error([`${file} is invalid. Run selfhost policy check.`, ...lines].join("\n"));
  }
  return { path: location.path, config: result.config };
}

function packageLine(pkg: PackageResult): string[] {
  const name = `${pkg.name}${pkg.version ? ` ${pkg.version}` : ""}`;
  const why = [
    ...pkg.findings.map((finding) => `${finding.rule_id}: ${finding.message}`),
    ...(pkg.unchecked.length > 0 ? [`not checked: ${pkg.unchecked.join("; ")}`] : []),
    ...(pkg.note ? [pkg.note] : []),
  ];
  return [`  ${pkg.status}`, name, why.join(" ")];
}

/**
 * `selfhost packages check "<command>"`: the package guard on one shell command, as the
 * pre-tool hook runs it. Exits 1 when a package would be blocked, whatever the mode.
 */
export async function packagesCheckCommand(
  command: string,
  options: PackagesCheckOptions,
  io: PackagesIo,
): Promise<void> {
  const timeout = options.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(options.timeout);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(`--timeout: expected a whole number of milliseconds, got "${options.timeout}"`);
  }
  const { path, config } = policy(options, io);
  const now = io.now;
  const report = await checkCommand(command, config, {
    fetch: io.fetch ?? ((url, init) => fetch(url, init)),
    now: () => now ?? new Date(),
    cacheDir: join(dirname(io.configPath), "cache", "packages"),
    budgetMs: timeout,
    env: io.env,
  });
  const hits = packageHits(report, config);
  if (hits.some((hit) => hit.verdict === "block")) io.setExitCode(1);
  if (options.json) {
    const json: PackagesCheckReport = {
      schema: PACKAGES_CHECK_SCHEMA,
      command,
      config: path ?? null,
      mode: config.packages.mode,
      installs: report.installs,
      hits,
    };
    io.write(JSON.stringify(json, null, 2));
    return;
  }
  if (config.packages.mode === "off") {
    io.write("[packages] mode is off: the guard checks nothing.");
    return;
  }
  if (report.installs.length === 0) {
    io.write("No package installs in this command.");
    return;
  }
  for (const install of report.installs) {
    io.write(install.command);
    for (const finding of install.findings) io.write(`  ${finding.rule_id}: ${finding.message}`);
    table(
      [
        ...install.packages.map(packageLine),
        ...install.skipped.map((skipped) => ["  skipped", skipped.arg, skipped.reason]),
      ],
      io.write,
    );
  }
  io.write(
    config.packages.mode === "enforce"
      ? "[packages] mode is enforce: hooks stop blocked installs and ask about flagged ones."
      : "[packages] mode is observe: hooks record these verdicts and stop nothing.",
  );
}

export function registerPackages(
  program: Command,
  io: () => PackagesIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  program
    .command("packages")
    .description("check the packages agents install against their registries")
    .command("check")
    .description(
      "check every npm, pip, cargo and go install in a shell command against selfhost.toml [packages] and the registries",
    )
    .argument("<command>", 'the shell command, quoted, like "npm i left-pad"')
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--timeout <ms>", "how long to wait on the registries", String(DEFAULT_TIMEOUT_MS))
    .option("--json", "print JSON")
    .action(async (command: string, options: PackagesCheckOptions) => {
      try {
        await packagesCheckCommand(command, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
