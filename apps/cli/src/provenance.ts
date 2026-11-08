import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ghCliSource, readCommits, readPulls } from "@selfhost/attribution";
import type { Ledger } from "@selfhost/ledger";
import { ledgerEvents, sessionHints } from "@selfhost/pr";
import {
  type MergedPull,
  mergedPulls,
  readProvenance,
  runCommits,
  settingsFromConfig,
} from "@selfhost/provenance";
import {
  createValidator,
  type LedgerEvent,
  type ProvenanceReport,
  type VendorLineStat,
  VendorLineStatsSchema,
} from "@selfhost/schema";
import type { Command } from "commander";
import { parseSince } from "./import.js";
import { provenanceText } from "./provenance-text.js";
import { existingLedger, loadConfig } from "./review.js";
import { githubRepoFromRemote } from "./scan/git-attribution.js";
import { repoDir } from "./scan/index.js";

const DAY_MS = 86_400_000;

/** Commits authored this long before the window can still land in it, from older branches. */
const BRANCH_AGE_DAYS = 90;

export interface ProvenanceIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  now?: Date;
  /** Reads merged pull requests from GitHub; default: the developer's own gh, when signed in. */
  pulls?: (repo: string, opts: Parameters<typeof readPulls>[1]) => Promise<MergedPull[]>;
}

export interface ProvenanceCommandOptions {
  since?: string;
  until?: string;
  repo?: string;
  branch?: string;
  config?: string;
  database?: string;
  dataDir?: string;
  vendorStats?: string;
  /** false with --no-github. */
  github?: boolean;
  json?: boolean;
}

const vendorStatsFile = createValidator(VendorLineStatsSchema);

/** `--vendor-stats`: `{ "stats": [...] }` or the bare array. */
export function readVendorStats(path: string): VendorLineStat[] {
  if (!existsSync(path)) throw new Error(`--vendor-stats: ${path} does not exist`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`--vendor-stats: ${path} is not JSON`);
  }
  const result = vendorStatsFile.validate(Array.isArray(parsed) ? { stats: parsed } : parsed);
  if (!result.ok) {
    const [first] = result.errors;
    throw new Error(`--vendor-stats: ${first?.field}: ${first?.message}`);
  }
  return result.value.stats;
}

function originRepo(dir: string): string | undefined {
  try {
    const url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return githubRepoFromRemote(url);
  } catch {
    return undefined;
  }
}

/** The developer's own gh, when it is signed in; GitHub's merged pull requests with their agent. */
async function ghPulls(repo: string, opts: Parameters<typeof readPulls>[1]): Promise<MergedPull[]> {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
  } catch {
    return [];
  }
  const pulls = await readPulls(repo, opts);
  return pulls
    .filter((pull) => pull.state === "merged")
    .map((pull) => ({
      number: pull.number,
      ...(pull.agent ? { agent: pull.agent } : {}),
      person: pull.author,
      additions: pull.additions,
      ...(pull.mergedAt ? { mergedAt: pull.mergedAt } : {}),
    }));
}

/**
 * What the ledger knows that joins commits to runs, from `from` on: commits sessions recorded,
 * merged pull requests, and sessions that edited files (readCommits keeps those in the repo).
 */
async function ledgerInputs(ledger: Ledger, from: Date, to: Date, repo?: string) {
  const events: LedgerEvent[] = [];
  for (const kind of ["commit.created", "pr.merged"]) {
    for await (const event of ledgerEvents(ledger, { kind, from: from.toISOString() })) {
      events.push(event);
    }
  }
  return {
    runs: runCommits(events),
    // Pull request numbers mean nothing without the repository they belong to.
    pulls: repo ? mergedPulls(events, repo) : [],
    sessions: await sessionHints(ledger, from, to, new Map()),
  };
}

/**
 * `selfhost provenance`: lines merged to the main branch by agent, model, person and module,
 * and how many were reverted or reworked within `[review] revert_window_days` of merge. Reads
 * git, the ledger when there is one, and GitHub through the developer's own gh unless
 * --no-github. Nothing leaves the machine.
 */
export async function provenanceCommand(
  options: ProvenanceCommandOptions,
  io: ProvenanceIo,
): Promise<ProvenanceReport> {
  const now = io.now ?? new Date();
  const until = options.until ? (parseSince(options.until, now) ?? now) : now;
  const since = parseSince(options.since ?? "30d", until) ?? until;
  if (since >= until) throw new Error("--since: expected a time before --until");
  const dir = repoDir(options.repo, io.cwd);
  if (!dir) throw new Error("Not in a git repository. Run it inside one, or pass --repo.");
  const { config } = loadConfig(dir, options.config, io);
  const vendorStats = options.vendorStats
    ? readVendorStats(resolve(io.cwd, options.vendorStats))
    : undefined;
  const repo = originRepo(dir);
  const branchSince = new Date(since.getTime() - BRANCH_AGE_DAYS * DAY_MS);

  const ledger = await existingLedger(options, io);
  try {
    const joined = ledger
      ? await ledgerInputs(ledger, branchSince, until, repo)
      : { runs: [], pulls: [], sessions: [] };
    const commits = await readCommits(dir, { since: branchSince, sessions: joined.sessions });
    let pulls = joined.pulls;
    if (repo && options.github !== false) {
      const read = io.pulls ?? ghPulls;
      try {
        const fromGitHub = await read(repo, { since, commits, source: ghCliSource() });
        const known = new Set(fromGitHub.map((pull) => pull.number));
        pulls = [...fromGitHub, ...pulls.filter((pull) => !known.has(pull.number))];
      } catch {
        // GitHub is optional: git and the ledger give every number.
      }
    }
    const report = await readProvenance(dir, {
      since,
      until,
      settings: settingsFromConfig(config),
      ...(options.branch ? { branch: options.branch } : {}),
      ...(repo ? { repo } : {}),
      commits,
      runs: joined.runs,
      pulls,
      ...(vendorStats ? { vendorStats } : {}),
    });
    if (options.json) io.write(JSON.stringify(report, null, 2));
    else for (const line of provenanceText(report)) io.write(line);
    return report;
  } finally {
    await ledger?.close();
  }
}

export function registerProvenance(
  program: Command,
  io: () => ProvenanceIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  program
    .command("provenance")
    .description(
      "lines merged by agent, model, person and module, and how much was reverted or reworked within days of merge",
    )
    .option("--since <when>", "merges since, like 30d, 12h or a date", "30d")
    .option("--until <when>", "merges and changes up to, like 2d or a date (default: now)")
    .option("--repo <dir>", "git repository (default: the one here)")
    .option("--branch <ref>", "main branch (default: origin/HEAD, else main or master)")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option(
      "--vendor-stats <file>",
      "JSON of vendor-reported lines (Cursor AI Code Tracking, Claude Code Analytics), shown next to the git numbers",
    )
    .option("--no-github", "do not read pull requests through gh")
    .option("--json", "print JSON")
    .action(async (options: ProvenanceCommandOptions) => {
      try {
        await provenanceCommand(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
