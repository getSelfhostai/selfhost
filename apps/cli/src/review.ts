import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  isPostgresUrl,
  type Ledger,
  MEMORY_DATA_DIR,
  openLedger,
  resolveDataDir,
} from "@selfhost/ledger";
import {
  formatConfigError,
  parseConfig,
  type ResolvedSelfhostConfig,
  validateConfig,
} from "@selfhost/schema";
import type { Command } from "commander";
import { loadRisk } from "./ee.js";
import { findConfig } from "./find-config.js";
import { repoDir } from "./scan/index.js";

export interface ReviewIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  now?: Date;
}

export interface ReviewRiskCommandOptions {
  base?: string;
  head?: string;
  tests?: string;
  repo?: string;
  config?: string;
  database?: string;
  dataDir?: string;
  json?: boolean;
}

/** selfhost.toml as `doctor` finds it, or the defaults when there is none. */
export function loadConfig(
  dir: string,
  flag: string | undefined,
  io: ReviewIo,
): { path?: string; config: ResolvedSelfhostConfig } {
  const location = findConfig(dir, flag, io.env);
  if (!location) {
    const defaults = validateConfig({ version: 1 });
    if (!defaults.ok) throw new Error("The default selfhost.toml does not validate");
    return { config: defaults.config };
  }
  if (!existsSync(location.path)) throw new Error(`${location.path} does not exist`);
  const result = parseConfig(readFileSync(location.path, "utf8"));
  if (!result.ok) {
    const file = relative(io.cwd, location.path) || location.path;
    const lines = result.errors.map((error) => `  ${formatConfigError(error, file)}`);
    throw new Error([`${file} is invalid. Run selfhost policy check.`, ...lines].join("\n"));
  }
  return { path: location.path, config: result.config };
}

/** The ledger when there is one to read: a Postgres url, or an embedded folder that exists. */
export async function existingLedger(
  options: Pick<ReviewRiskCommandOptions, "database" | "dataDir">,
  io: ReviewIo,
): Promise<Ledger | undefined> {
  const url = options.database ?? io.env.DATABASE_URL;
  if (url && isPostgresUrl(url)) return openLedger({ url });
  const dir = resolveDataDir(options.dataDir, io.env);
  if (dir !== MEMORY_DATA_DIR && !existsSync(dir)) return undefined;
  return openLedger({ dataDir: dir });
}

export async function reviewRiskCommand(
  pr: string | undefined,
  options: ReviewRiskCommandOptions,
  io: ReviewIo,
): Promise<void> {
  const repo = repoDir(options.repo, io.cwd);
  if (!repo) throw new Error("Not in a git repository. Run it inside one, or pass --repo.");
  const { path, config } = loadConfig(repo, options.config, io);
  const risk = await loadRisk();
  const ledger = await existingLedger(options, io);
  try {
    const report = await risk.reviewRisk({
      repoDir: repo,
      pr,
      base: options.base,
      head: options.head,
      tests: options.tests,
      config,
      configPath: path,
      ledger,
      now: io.now,
    });
    if (options.json) io.write(JSON.stringify(report, null, 2));
    else for (const line of risk.formatRiskReport(report)) io.write(line);
  } finally {
    await ledger?.close();
  }
}

export function registerReview(
  program: Command,
  io: () => ReviewIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const review =
    program.commands.find((command) => command.name() === "review") ??
    program.command("review").description("score and route agent pull requests");

  review
    .command("risk")
    .description(
      "score an agent pull request low, medium or high and print its label and check result",
    )
    .argument("[pr]", "pull request number, read through gh")
    .option("--base <ref>", "score the local commits since this ref instead of a pull request")
    .option("--head <ref>", "last commit to score with --base (default: HEAD)")
    .option("--tests <status>", "test result from the sandbox or CI: passed, failed or not-run")
    .option("--repo <dir>", "git repository (default: the one here)")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option("--json", "print JSON")
    .action(async (pr: string | undefined, options: ReviewRiskCommandOptions) => {
      try {
        await reviewRiskCommand(pr, options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
