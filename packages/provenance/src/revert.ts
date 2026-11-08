import type { Landing, MainlineCommit } from "./types.js";

/** The line `git revert` writes; GitHub keeps it in the body of a squash merge. */
const REVERTS_COMMIT = /This reverts commit ([0-9a-f]{7,40})/gi;
/** The body of a pull request made with GitHub's Revert button. */
const REVERTS_PULL = /^Reverts [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#(\d+)\s*$/gim;
/** `Revert "<subject>"`, with the revert's own ` (#N)` when it was squash merged. */
const REVERT_SUBJECT = /^Revert "(.*)"(?: \(#\d+\))?$/;
const MERGE_SUBJECT = /^Merge pull request #(\d+) /;
const SQUASH_SUBJECT = /\(#(\d+)\)$/;

/** The pull request a mainline commit merged, from GitHub's merge or squash subject. */
export function pullNumber(
  commit: Pick<MainlineCommit, "subject" | "parents">,
): number | undefined {
  const match =
    commit.parents.length > 1
      ? MERGE_SUBJECT.exec(commit.subject)
      : SQUASH_SUBJECT.exec(commit.subject.trim());
  return match ? Number(match[1]) : undefined;
}

/** The commits and pull requests a commit message says it reverts. */
export function revertTargets(message: string): {
  shas: string[];
  pulls: number[];
  subject?: string;
} {
  const shas = [...message.matchAll(REVERTS_COMMIT)].map((m) => (m[1] ?? "").toLowerCase());
  const pulls = [...message.matchAll(REVERTS_PULL)].map((m) => Number(m[1]));
  const subject = REVERT_SUBJECT.exec(message.split("\n")[0]?.trim() ?? "")?.[1];
  return { shas, pulls, ...(subject !== undefined ? { subject } : {}) };
}

const shaMatches = (full: string, short: string) =>
  short.length >= 7 && full.toLowerCase().startsWith(short);

/**
 * Whether `commit` says it reverts `landing`: it names one of the landing's commits, or a commit
 * the landing's lines came from, in a `This reverts commit` line; it names the landing's pull
 * request in a `Reverts owner/name#N` line; or its subject is `Revert "<the landing's subject>"`.
 */
export function revertsLanding(
  commit: Pick<MainlineCommit, "message" | "subject">,
  landing: Landing,
  origins: Iterable<string> = [],
): boolean {
  const targets = revertTargets(commit.message || commit.subject);
  const shas = [...landing.commits.map((c) => c.sha), ...origins];
  if (targets.shas.some((short) => shas.some((full) => shaMatches(full, short)))) return true;
  if (landing.pr !== undefined && targets.pulls.includes(landing.pr)) return true;
  if (targets.subject !== undefined) {
    const subjects = new Set(landing.commits.map((c) => c.subject.trim()));
    if (subjects.has(targets.subject.trim())) return true;
  }
  return false;
}
