import { blameSince, type Git } from "./git.js";
import { moduleOf } from "./modules.js";
import { pullNumber, revertsLanding } from "./revert.js";
import type {
  BlameLine,
  LandedLine,
  Landing,
  LineFate,
  MainlineCommit,
  ProvenanceSettings,
  TrackedLanding,
  TrackedLine,
} from "./types.js";

const DAY_MS = 86_400_000;

/**
 * Lockfiles hold no written code; their lines are left out. The same list as LOCKFILES in
 * `@selfhost/pr`, which a test keeps equal.
 */
export const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.sum",
  "Cargo.lock",
]);

const isLockfile = (path: string) => LOCKFILES.has(path.slice(path.lastIndexOf("/") + 1));

/**
 * A later commit that removes every line of a landing still there, and adds back no more than
 * this share of that count to the same files, takes the landing out wholesale: a revert, even
 * when its message does not say so.
 */
export const WHOLESALE_ADDED_SHARE = 0.1;

/**
 * Mainline commits grouped by how they landed: a merge or a lone commit on its own, and
 * consecutive non-merge commits with the same committer and commit time (a rebase merge, or
 * one push of commits rebased together) as one landing. Oldest first.
 */
export function groupLandings(commits: MainlineCommit[]): Landing[] {
  const landings: Landing[] = [];
  let current: MainlineCommit[] = [];
  const flush = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    const pr = current.map(pullNumber).find((n) => n !== undefined);
    landings.push({
      commits: current,
      ...(first.parents[0] ? { bottom: first.parents[0] } : {}),
      mergedAt: last.committedAt,
      ...(pr !== undefined ? { pr } : {}),
    });
    current = [];
  };
  for (const commit of commits) {
    const previous = current[current.length - 1];
    const together =
      previous !== undefined &&
      previous.parents.length === 1 &&
      commit.parents.length === 1 &&
      commit.parents[0] === previous.sha &&
      previous.committerEmail === commit.committerEmail &&
      previous.committedAt === commit.committedAt;
    if (!together) flush();
    current.push(commit);
  }
  flush();
  return landings;
}

/** Blame results within one read, by range and path. */
export type BlameCache = Map<string, Promise<BlameLine[]>>;

function blame(
  git: Git,
  cache: BlameCache,
  bottom: string | undefined,
  top: string,
  path: string,
): Promise<BlameLine[]> {
  const key = `${bottom ?? ""}\n${top}\n${path}`;
  let lines = cache.get(key);
  if (!lines) {
    lines = blameSince(git, bottom, top, path);
    cache.set(key, lines);
  }
  return lines;
}

const lineKey = (line: Pick<BlameLine, "origin" | "path" | "line">) =>
  `${line.origin}:${line.path}:${line.line}`;

/** Paths after `commit`'s renames. */
function renamed(paths: Map<string, string>, commit: MainlineCommit): void {
  for (const file of commit.files) {
    if (!file.previousPath) continue;
    for (const [landed, now] of paths) if (now === file.previousPath) paths.set(landed, file.path);
  }
}

/** Repository paths the landing added lines to (lockfiles left out), as at its last commit. */
function landedPaths(landing: Landing): string[] {
  const paths = new Map<string, string>();
  for (const commit of landing.commits) {
    renamed(paths, commit);
    for (const file of commit.files) {
      if (!file.binary && file.additions > 0 && !isLockfile(file.path)) {
        paths.set(file.path, file.path);
      }
    }
  }
  return [...new Set(paths.values())].sort();
}

/** How many times each key is present. */
function countKeys(lines: Iterable<BlameLine>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(lineKey(line), (counts.get(lineKey(line)) ?? 0) + 1);
  return counts;
}

/** Keys of `before` that `after` holds fewer of, with how many fewer. */
function lost(before: Map<string, number>, after: Map<string, number>): Map<string, number> {
  const gone = new Map<string, number>();
  for (const [key, count] of before) {
    const missing = count - Math.min(count, after.get(key) ?? 0);
    if (missing > 0) gone.set(key, missing);
  }
  return gone;
}

function total(counts: Map<string, number>): number {
  let sum = 0;
  for (const count of counts.values()) sum += count;
  return sum;
}

/** What a later commit did to the landing's lines. */
export interface LossStep {
  commit: MainlineCommit;
  /** Keys it changed or removed, with how many lines each. */
  lost: Map<string, number>;
  /** Lines of the landing still there just before it. */
  aliveBefore: number;
  /** Lines it added to the files that held the landing's lines. */
  addedToFiles: number;
}

/**
 * Whether a step reverted the landing's lines rather than reworked them: the commit says it
 * reverts the landing, or it removed every line still there and added back no more than
 * WHOLESALE_ADDED_SHARE as many to those files.
 */
export function isRevertStep(step: LossStep, landing: Landing, origins: Iterable<string>): boolean {
  if (revertsLanding(step.commit, landing, origins)) return true;
  const removed = total(step.lost);
  return (
    removed > 0 &&
    removed === step.aliveBefore &&
    step.addedToFiles <= removed * WHOLESALE_ADDED_SHARE
  );
}

/**
 * Gives each landed line its fate from the steps that changed lines, in order: reverted when
 * the step was a revert, else reworked. Pure.
 */
export function assignFates(
  landing: Landing,
  lines: LandedLine[],
  steps: LossStep[],
): TrackedLine[] {
  const origins = [...new Set(lines.map((line) => line.origin))];
  const byKey = new Map<string, TrackedLine[]>();
  const tracked = lines.map((line): TrackedLine => ({ ...line, fate: "kept" }));
  for (const line of tracked) {
    const list = byKey.get(line.key) ?? [];
    list.push(line);
    byKey.set(line.key, list);
  }
  for (const step of steps) {
    const fate: LineFate = isRevertStep(step, landing, origins) ? "reverted" : "reworked";
    for (const [key, count] of step.lost) {
      const kept = (byKey.get(key) ?? []).filter((line) => line.fate === "kept");
      for (const line of kept.slice(0, count)) {
        line.fate = fate;
        line.by = step.commit.sha;
      }
    }
  }
  return tracked;
}

export interface TrackOptions {
  settings: Pick<ProvenanceSettings, "modules" | "moduleDepth" | "windowDays">;
  /** Changes after this time are not read yet. */
  until: Date;
  cache?: BlameCache;
}

/**
 * Every non-blank line a landing brought to the main branch (from `git blame` over the commits
 * after its bottom), and which of them later mainline commits within the window changed or
 * removed. `later` are the mainline commits after the landing, oldest first. Renames are
 * followed from each commit's own diff, and blame follows moves and copies, so a line keeps its
 * identity while it is unchanged.
 */
export async function trackLanding(
  git: Git,
  landing: Landing,
  later: MainlineCommit[],
  opts: TrackOptions,
): Promise<TrackedLanding> {
  const cache = opts.cache ?? new Map();
  const last = landing.commits[landing.commits.length - 1] as MainlineCommit;
  const windowEnd = Date.parse(landing.mergedAt) + opts.settings.windowDays * DAY_MS;
  const open = windowEnd > opts.until.getTime();

  const lines: LandedLine[] = [];
  const alive = new Map<string, Map<string, number>>();
  for (const path of landedPaths(landing)) {
    const blamed = (await blame(git, cache, landing.bottom, last.sha, path)).filter(
      (line) => !line.blank,
    );
    if (blamed.length === 0) continue;
    const module = moduleOf(path, opts.settings);
    for (const line of blamed) {
      lines.push({ key: lineKey(line), origin: line.origin, path, module });
    }
    alive.set(path, countKeys(blamed));
  }

  const end = Math.min(windowEnd, opts.until.getTime());
  const followers = later.filter((commit) => Date.parse(commit.committedAt) <= end);
  const origins = new Set(lines.map((line) => line.origin));
  const revertedBy = followers
    .filter((commit) => revertsLanding(commit, landing, origins))
    .map((commit) => commit.sha);
  if (lines.length === 0 || followers.length === 0) {
    return { landing, lines: assignFates(landing, lines, []), open, revertedBy };
  }

  const merged = (files: Map<string, Map<string, number>>) => {
    const all = new Map<string, number>();
    for (const counts of files.values()) {
      for (const [key, count] of counts) all.set(key, (all.get(key) ?? 0) + count);
    }
    return all;
  };
  const keys = new Set(lines.map((line) => line.key));
  // Blame at a later commit also names the lines added since; only the landing's own count.
  const surviving = async (top: string, paths: Map<string, string>, only?: Set<string>) => {
    const files = new Map<string, Map<string, number>>();
    for (const [landed, now] of paths) {
      if (only && !only.has(landed)) continue;
      const blamed = await blame(git, cache, landing.bottom, top, now);
      files.set(landed, countKeys(blamed.filter((line) => keys.has(lineKey(line)))));
    }
    return files;
  };

  // The end of the window first: when every line is still there, nothing in between matters.
  const finalPaths = new Map([...alive.keys()].map((path) => [path, path] as const));
  for (const commit of followers) renamed(finalPaths, commit);
  const lastFollower = followers[followers.length - 1] as MainlineCommit;
  const atEnd = merged(await surviving(lastFollower.sha, finalPaths));
  if (lost(merged(alive), atEnd).size === 0) {
    return { landing, lines: assignFates(landing, lines, []), open, revertedBy };
  }

  // Some lines changed: find the commit that changed each.
  const steps: LossStep[] = [];
  const paths = new Map([...alive.keys()].map((path) => [path, path] as const));
  let before = merged(alive);
  for (const commit of followers) {
    const was = new Map(paths);
    renamed(paths, commit);
    const changed = new Set(commit.files.flatMap((f) => [f.path, f.previousPath ?? f.path]));
    const touched = new Set(
      [...paths].filter(([landed, now]) => changed.has(now) || changed.has(was.get(landed) ?? now)),
    );
    if (touched.size === 0) continue;
    const touchedLanded = new Set([...touched].map(([landed]) => landed));
    for (const [landed, counts] of await surviving(commit.sha, paths, touchedLanded)) {
      alive.set(landed, counts);
    }
    const after = merged(alive);
    const gone = lost(before, after);
    if (gone.size > 0) {
      const nowPaths = new Set([...touched].map(([, now]) => now));
      steps.push({
        commit,
        lost: gone,
        aliveBefore: total(before),
        addedToFiles: commit.files
          .filter((file) => nowPaths.has(file.path))
          .reduce((sum, file) => sum + file.additions, 0),
      });
    }
    before = after;
    if (total(before) === 0) break;
  }
  return { landing, lines: assignFates(landing, lines, steps), open, revertedBy };
}
