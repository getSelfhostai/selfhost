import type {
  AgentRef,
  AgentStats,
  AgentVendor,
  CommitRecord,
  PullRecord,
  SessionHint,
} from "./types.js";

const VENDOR_ORDER: readonly AgentVendor[] = [
  "claude_code",
  "codex",
  "opencode",
  "goose",
  "cursor",
  "copilot",
  "other",
];

const HOUR_MS = 60 * 60 * 1000;

function groupKey(agent: AgentRef | undefined): string {
  return agent ? `${agent.vendor}\n${agent.model ?? ""}` : "";
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function compare(a: AgentStats, b: AgentStats): number {
  if (a.agent === "unattributed") return 1;
  if (b.agent === "unattributed") return -1;
  const byVendor = VENDOR_ORDER.indexOf(a.agent.vendor) - VENDOR_ORDER.indexOf(b.agent.vendor);
  if (byVendor !== 0) return byVendor;
  return (a.agent.model ?? "").localeCompare(b.agent.model ?? "");
}

/**
 * Per agent and model: commits and their share, pull requests merged and closed, time to merge,
 * review comments per pull request and unreviewed merges. Records with no agent are counted
 * under "unattributed", never spread across agents. Sorted by vendor, then model, with
 * unattributed last.
 */
export function attributionStats(
  commits: CommitRecord[],
  pulls: PullRecord[],
): { byAgent: AgentStats[] } {
  const groups = new Map<
    string,
    { agent: AgentRef | undefined; commits: number; pulls: PullRecord[] }
  >();
  const group = (agent: AgentRef | undefined) => {
    const key = groupKey(agent);
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        agent: agent && { vendor: agent.vendor, ...(agent.model ? { model: agent.model } : {}) },
        commits: 0,
        pulls: [],
      };
      groups.set(key, entry);
    }
    return entry;
  };
  for (const commit of commits) group(commit.agent).commits++;
  for (const pull of pulls) group(pull.agent).pulls.push(pull);

  const byAgent = [...groups.values()].map((entry): AgentStats => {
    const merged = entry.pulls.filter((p) => p.state === "merged");
    const closed = entry.pulls.filter((p) => p.state === "closed").length;
    const hoursToMerge = merged
      .filter((p) => p.mergedAt)
      .map((p) => (Date.parse(p.mergedAt as string) - Date.parse(p.createdAt)) / HOUR_MS);
    const medianHours = median(hoursToMerge);
    const decided = merged.length + closed;
    const prs = entry.pulls.length;
    return {
      agent: entry.agent ?? "unattributed",
      commits: entry.commits,
      commitShare: commits.length ? entry.commits / commits.length : 0,
      prs,
      merged: merged.length,
      closed,
      mergedRate: decided ? merged.length / decided : 0,
      ...(medianHours === undefined ? {} : { medianHoursToMerge: medianHours }),
      reviewCommentsPerPr: prs ? entry.pulls.reduce((n, p) => n + p.reviewComments, 0) / prs : 0,
      unreviewedMerges: entry.pulls.filter((p) => p.unreviewedMerge).length,
    };
  });
  return { byAgent: byAgent.sort(compare) };
}

/** Ids of sessions no commit was attributed to, in input order. */
export function sessionsWithoutCommits(sessions: SessionHint[], commits: CommitRecord[]): string[] {
  const used = new Set(commits.map((c) => c.sessionId).filter(Boolean));
  return [...new Set(sessions.map((s) => s.sessionId))].filter((id) => !used.has(id));
}
