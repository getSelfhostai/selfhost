import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghCliSource, type PullRecord, readPulls } from "../src/index.js";
import { LOCAL_COMMITS, REPO, recordedGh, SINCE } from "./helpers.js";

let cacheDir: string;
let pulls: PullRecord[];
let calls: string[];
const pr = (n: number) => {
  const found = pulls.find((p) => p.number === n);
  if (!found) throw new Error(`no pull ${n}`);
  return found;
};

beforeAll(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "selfhost-gh-cache-"));
  const gh = recordedGh();
  calls = gh.calls;
  pulls = await readPulls(REPO, {
    since: SINCE,
    commits: LOCAL_COMMITS,
    source: ghCliSource({ run: gh.run, cacheDir }),
  });
});

afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

describe("readPulls", () => {
  it("keeps pull requests opened, merged or closed in the window, in list order", () => {
    expect(pulls.map((p) => p.number)).toEqual([104, 111, 108, 107, 106, 103, 105, 102, 101, 109]);
    expect(calls[0]).toBe(
      "repos/acme/acme-api/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1",
    );
    expect(calls.some((c) => c.includes("/pulls/110"))).toBe(false);
  });

  it("reads state, times, size, commits and review counts", () => {
    expect(pr(101)).toEqual({
      number: 101,
      url: "https://github.com/acme/acme-api/pull/101",
      state: "merged",
      createdAt: "2026-10-05T09:00:00.000Z",
      mergedAt: "2026-10-05T15:00:00.000Z",
      closedAt: "2026-10-05T15:00:00.000Z",
      author: "alice",
      headRef: "claude/add-rate-limit",
      additions: 90,
      deletions: 30,
      commits: [
        "4aecb7e7824bd03b38804b1f8df5e841c7ab8ade",
        "5786c5c9d81ca4218b7e44bf0007f5580f66c489",
      ],
      approvals: 1,
      reviewComments: 2,
      issueComments: 1,
      agent: { vendor: "claude_code", model: "claude-sonnet-4-5" },
      signal: "co_author_trailer",
      unreviewedMerge: false,
    });
    expect(pr(104)).toMatchObject({ state: "open", approvals: 0, reviewComments: 0 });
    expect(pr(104).mergedAt).toBeUndefined();
    expect(pr(104).closedAt).toBeUndefined();
    expect(pr(103)).toMatchObject({ state: "closed", closedAt: "2026-10-09T09:00:00.000Z" });
  });

  it.each([
    [101, { vendor: "claude_code", model: "claude-sonnet-4-5" }, "co_author_trailer"],
    [102, { vendor: "copilot" }, "bot_account"],
    [103, { vendor: "codex" }, "session_id"],
    [104, { vendor: "cursor" }, "branch_prefix"],
    [105, { vendor: "claude_code", model: "claude-opus-4-5" }, "session_id"],
    [107, { vendor: "other" }, "bot_account"],
    [108, { vendor: "goose", model: "gpt-5.5" }, "file_time_match"],
    [109, { vendor: "codex" }, "co_author_trailer"],
  ])("links #%i to its agent and the signal that matched", (number, agent, signal) => {
    expect(pr(number).agent).toEqual(agent);
    expect(pr(number).signal).toBe(signal);
  });

  it("leaves human and conflicting pull requests unattributed", () => {
    for (const number of [106, 111]) {
      expect(pr(number).agent).toBeUndefined();
      expect(pr(number).signal).toBeUndefined();
    }
  });

  it("counts approvals from people before the merge, latest review per person", () => {
    // 102: approved after the merge. 103: approved, then changes requested. 107: a bot approved.
    expect([101, 102, 103, 105, 106, 107, 109].map((n) => pr(n).approvals)).toEqual([
      1, 0, 0, 1, 1, 0, 1,
    ]);
    // 101 has a cursor[bot] review comment that does not count.
    expect([101, 105, 106, 109].map((n) => pr(n).reviewComments)).toEqual([2, 0, 3, 1]);
  });

  it("flags merges with no human approval, or approved large diffs with no comments", () => {
    const flagged = pulls.filter((p) => p.unreviewedMerge).map((p) => p.number);
    expect(flagged.sort()).toEqual([102, 105, 107]);
  });

  it("takes the large diff threshold from the caller", async () => {
    const gh = recordedGh();
    const relaxed = await readPulls(REPO, {
      since: SINCE,
      commits: LOCAL_COMMITS,
      source: ghCliSource({ run: gh.run, cacheDir }),
      largeDiffLines: 1000,
    });
    expect(
      relaxed
        .filter((p) => p.unreviewedMerge)
        .map((p) => p.number)
        .sort(),
    ).toEqual([102, 107]);
  });

  it("does not need local commits", async () => {
    const gh = recordedGh();
    const remoteOnly = await readPulls(REPO, {
      since: SINCE,
      commits: [],
      source: ghCliSource({ run: gh.run, cacheDir }),
    });
    const byNumber = new Map(remoteOnly.map((p) => [p.number, p]));
    // Without the local session match, 105 has only a bare id nobody knows: unattributed.
    expect(byNumber.get(105)?.agent).toBeUndefined();
    expect(byNumber.get(108)?.agent).toBeUndefined();
    expect(byNumber.get(101)?.agent).toEqual({ vendor: "claude_code", model: "claude-sonnet-4-5" });
  });
});
