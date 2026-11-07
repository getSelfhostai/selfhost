import { describe, expect, it } from "vitest";
import {
  type AgentRef,
  attributionStats,
  type CommitRecord,
  type PullRecord,
  type SessionHint,
  sessionsWithoutCommits,
} from "../src/index.js";

let n = 0;

function commit(agent?: AgentRef, sessionId?: string): CommitRecord {
  n++;
  return {
    sha: n.toString(16).padStart(40, "0"),
    authoredAt: "2026-10-02T09:00:00.000Z",
    authorEmail: "alice@example.com",
    subject: `Commit ${n}`,
    files: ["src/a.ts"],
    additions: 1,
    deletions: 0,
    ...(agent ? { agent, signal: "co_author_trailer" as const } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function pull(
  state: PullRecord["state"],
  opts: { agent?: AgentRef; hours?: number; comments?: number; unreviewed?: boolean } = {},
): PullRecord {
  n++;
  const createdAt = "2026-10-05T00:00:00.000Z";
  const end =
    opts.hours === undefined
      ? undefined
      : new Date(Date.parse(createdAt) + opts.hours * 3_600_000).toISOString();
  return {
    number: n,
    url: `https://github.com/acme/acme-api/pull/${n}`,
    state,
    createdAt,
    ...(state === "merged" && end ? { mergedAt: end, closedAt: end } : {}),
    ...(state === "closed" && end ? { closedAt: end } : {}),
    author: "alice",
    headRef: "main",
    additions: 10,
    deletions: 0,
    commits: [],
    approvals: 1,
    reviewComments: opts.comments ?? 0,
    issueComments: 0,
    ...(opts.agent ? { agent: opts.agent, signal: "branch_prefix" as const } : {}),
    unreviewedMerge: opts.unreviewed ?? false,
  };
}

const opus: AgentRef = { vendor: "claude_code", model: "claude-opus-4-5" };
const sonnet: AgentRef = { vendor: "claude_code", model: "claude-sonnet-4-5" };
const codex: AgentRef = { vendor: "codex" };

describe("attributionStats", () => {
  const commits = [commit(opus), commit(opus), commit(sonnet), commit(codex), commit(), commit()];
  const pulls = [
    pull("merged", { agent: opus, hours: 2, comments: 3 }),
    pull("merged", { agent: opus, hours: 10, comments: 1, unreviewed: true }),
    pull("merged", { agent: opus, hours: 4 }),
    pull("closed", { agent: opus, hours: 1, comments: 2 }),
    pull("open", { agent: opus }),
    pull("closed", { agent: codex, hours: 5 }),
    pull("merged", { hours: 30, comments: 4 }),
  ];
  const { byAgent } = attributionStats(commits, pulls);

  it("groups by agent and model, unattributed last", () => {
    expect(byAgent.map((s) => s.agent)).toEqual([opus, sonnet, codex, "unattributed"]);
  });

  it("reports commit share, merged vs closed, time to merge and review comments", () => {
    expect(byAgent[0]).toEqual({
      agent: opus,
      commits: 2,
      commitShare: 2 / 6,
      prs: 5,
      merged: 3,
      closed: 1,
      mergedRate: 0.75,
      medianHoursToMerge: 4,
      reviewCommentsPerPr: 6 / 5,
      unreviewedMerges: 1,
    });
    expect(byAgent[1]).toEqual({
      agent: sonnet,
      commits: 1,
      commitShare: 1 / 6,
      prs: 0,
      merged: 0,
      closed: 0,
      mergedRate: 0,
      reviewCommentsPerPr: 0,
      unreviewedMerges: 0,
    });
    expect(byAgent[2]).toMatchObject({ prs: 1, merged: 0, closed: 1, mergedRate: 0 });
    expect(byAgent[2]?.medianHoursToMerge).toBeUndefined();
    expect(byAgent[3]).toMatchObject({
      agent: "unattributed",
      commits: 2,
      prs: 1,
      mergedRate: 1,
      medianHoursToMerge: 30,
      reviewCommentsPerPr: 4,
    });
  });

  it("averages the middle pair for an even count and handles no input", () => {
    const even = attributionStats(
      [],
      [pull("merged", { agent: codex, hours: 2 }), pull("merged", { agent: codex, hours: 6 })],
    );
    expect(even.byAgent[0]?.medianHoursToMerge).toBe(4);
    expect(even.byAgent[0]?.commitShare).toBe(0);
    expect(attributionStats([], [])).toEqual({ byAgent: [] });
  });
});

describe("sessionsWithoutCommits", () => {
  it("lists sessions no commit came from, once each, in order", () => {
    const hint = (sessionId: string): SessionHint => ({
      sessionId,
      vendor: "claude_code",
      start: "2026-10-02T08:00:00Z",
      end: "2026-10-02T09:00:00Z",
      files: [],
    });
    const sessions = [hint("s1"), hint("s2"), hint("s3"), hint("s2")];
    expect(sessionsWithoutCommits(sessions, [commit(opus, "s1"), commit()])).toEqual(["s2", "s3"]);
  });
});
