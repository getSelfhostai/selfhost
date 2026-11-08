import { basename } from "node:path";
import { type CommitRecord, readCommits, type SessionHint } from "@selfhost/attribution";
import type { ProvenanceReport, VendorLineStat } from "@selfhost/schema";
import { lineAuthors } from "./attribute.js";
import { type Git, mainlineRef, readMainline, systemGit } from "./git.js";
import { DEFAULT_SETTINGS } from "./modules.js";
import { provenanceReport } from "./stats.js";
import { type BlameCache, groupLandings, trackLanding } from "./track.js";
import type { MergedPull, ProvenanceSettings, RunCommit, TrackedLanding } from "./types.js";

const DAY_MS = 86_400_000;

/** Commits authored this long before the window can still land in it, from older branches. */
const BRANCH_AGE_DAYS = 90;

/** Landings tracked at once; each runs a few git blames. */
const CONCURRENCY = 4;

export interface ReadProvenanceOptions {
  /** Merges at or after this time. */
  since: Date;
  /** Merges before this time, and the latest change read. Default: now. */
  until?: Date;
  /** The main branch. Default: origin/HEAD, else origin/main, origin/master, main, master, HEAD. */
  branch?: string;
  settings?: Partial<ProvenanceSettings>;
  /** owner/name, for the report. Default: the folder name. */
  repo?: string;
  /** Ledger sessions that edited files, for the file and time match. */
  sessions?: SessionHint[];
  /** Commits ledger sessions recorded. */
  runs?: RunCommit[];
  /** Merged pull requests with their agent, from GitHub or the ledger. */
  pulls?: MergedPull[];
  /** Commits already read with readCommits from far enough back; read here when absent. */
  commits?: CommitRecord[];
  /** Vendor-reported lines; optional, never needed. */
  vendorStats?: VendorLineStat[];
  /** Runs git. Default: the system git in the repository. */
  git?: Git;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Landings in the window, each with what later mainline commits did to its lines. */
export async function trackRepository(
  git: Git,
  ref: string,
  opts: { since: Date; until: Date; settings: ProvenanceSettings },
): Promise<TrackedLanding[]> {
  const mainline = (await readMainline(git, ref, opts.since)).filter(
    (commit) => Date.parse(commit.committedAt) < opts.until.getTime(),
  );
  const landings = groupLandings(mainline);
  const cache: BlameCache = new Map();
  let offset = 0;
  const starts = landings.map((landing) => {
    const start = offset;
    offset += landing.commits.length;
    return start;
  });
  return mapLimit(landings, CONCURRENCY, (landing, index) =>
    trackLanding(git, landing, mainline.slice((starts[index] ?? 0) + landing.commits.length), {
      settings: opts.settings,
      until: opts.until,
      cache,
    }),
  );
}

/**
 * Line-level provenance for one repository: every non-blank line merged to the main branch in
 * the window, who wrote it (agent, model and person, joined through the commit it came from to
 * the run that made it), and whether a later commit reverted or reworked it within
 * `windowDays` of the merge. Reads git only; the caller passes what it read from the ledger.
 */
export async function readProvenance(
  repoDir: string,
  opts: ReadProvenanceOptions,
): Promise<ProvenanceReport> {
  const until = opts.until ?? new Date();
  const settings: ProvenanceSettings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const root = (await systemGit(repoDir)(["rev-parse", "--show-toplevel"])).trim();
  const git = opts.git ?? systemGit(root);
  const ref = await mainlineRef(git, opts.branch);
  const head = (await git(["rev-parse", `${ref}^{commit}`])).trim();
  const landings = await trackRepository(git, ref, { since: opts.since, until, settings });
  const commits =
    opts.commits ??
    (await readCommits(root, {
      since: new Date(opts.since.getTime() - BRANCH_AGE_DAYS * DAY_MS),
      sessions: opts.sessions ?? [],
    }));
  return provenanceReport({
    repo: opts.repo ?? basename(root),
    from: opts.since,
    to: until,
    branch: ref,
    head,
    settings,
    landings,
    author: lineAuthors({
      commits,
      ...(opts.runs ? { runs: opts.runs } : {}),
      ...(opts.pulls ? { pulls: opts.pulls } : {}),
      ...(opts.vendorStats ? { vendorStats: opts.vendorStats } : {}),
    }),
    ...(opts.vendorStats ? { vendorStats: opts.vendorStats } : {}),
  });
}
