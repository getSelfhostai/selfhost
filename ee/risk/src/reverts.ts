import type { AgentRef, CommitRecord } from "@selfhost/attribution";
import type { RevertHistory } from "./types.js";

/** How far back revert rates look. */
export const REVERT_WINDOW_DAYS = 90;

/** The line `git revert` writes; it survives squash merges because the body is kept. */
const REVERTS_LINE = /This reverts commit ([0-9a-f]{7,40})/gi;

/** Commit SHAs (full or abbreviated, lowercase) that these commit messages revert. */
export function revertedShas(messages: string[]): string[] {
  const shas = new Set<string>();
  for (const message of messages) {
    for (const match of message.matchAll(REVERTS_LINE)) {
      if (match[1]) shas.add(match[1].toLowerCase());
    }
  }
  return [...shas].sort();
}

function isRevert(commit: CommitRecord): boolean {
  return /^Revert "/.test(commit.subject);
}

/**
 * How many of the agent's commits were reverted later. With a model, only that model's commits
 * count; without one, every commit by the vendor. Revert commits themselves and `exclude` (the
 * pull request's own commits) are left out.
 */
export function revertHistory(
  commits: CommitRecord[],
  reverted: string[],
  agent: AgentRef,
  opts: { exclude?: ReadonlySet<string>; days?: number } = {},
): RevertHistory {
  const own = commits.filter(
    (commit) =>
      commit.agent?.vendor === agent.vendor &&
      (agent.model === undefined || commit.agent.model === agent.model) &&
      !isRevert(commit) &&
      !opts.exclude?.has(commit.sha),
  );
  const isReverted = (sha: string) => {
    const lower = sha.toLowerCase();
    return reverted.some((short) => lower.startsWith(short));
  };
  return {
    agent: { vendor: agent.vendor, ...(agent.model ? { model: agent.model } : {}) },
    commits: own.length,
    reverted: own.filter((commit) => isReverted(commit.sha)).length,
    days: opts.days ?? REVERT_WINDOW_DAYS,
  };
}
