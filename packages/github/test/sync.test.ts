import { Octokit } from "@octokit/rest";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentLabel,
  checkExternalId,
  type DesiredState,
  isManagedLabel,
  MAX_CHECK_OUTPUT,
  type PullRequestRef,
  REVIEW_CHECK_NAME,
  readHeadChecks,
  riskLabel,
  syncComment,
  syncPullRequest,
} from "../src/index.js";
import { FAKE_INSTALLATION_TOKEN, FakeGitHub } from "../src/testing.js";

const REPO = "acme/acme-api";
const HEAD = "5786c5c9d81ca4218b7e44bf0007f5580f66c489";
const NEXT_HEAD = "e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4";
const MARKER = "<!-- selfhost:brief v1 -->";

const pr: PullRequestRef = {
  owner: "acme",
  repo: "acme-api",
  number: 101,
  headSha: HEAD,
  author: "alice",
};

const desired = (over: Partial<DesiredState> = {}): DesiredState => ({
  labels: { risk: "low", agent: "claude_code" },
  check: {
    title: "Low risk",
    summary: "Low risk, score 5 of 100.",
    text: "| Input | Points |",
    conclusion: "neutral",
  },
  reviewers: { users: ["bob"], teams: [] },
  brief: { body: `${MARKER}\n## Review brief\n\nAdds a token bucket per API key.`, marker: MARKER },
  ...over,
});

let github: FakeGitHub;
let octokit: Octokit;

beforeEach(() => {
  github = new FakeGitHub();
  github.addPull(REPO, 101, { author: "alice", labels: ["bug"] });
  octokit = new Octokit({ auth: FAKE_INSTALLATION_TOKEN, request: { fetch: github.fetch } });
});

describe("labels", () => {
  it("names risk and agent labels under a fixed prefix", () => {
    expect(riskLabel("high")).toBe("selfhost:risk-high");
    expect(agentLabel("claude_code")).toBe("selfhost:agent-claude-code");
    expect(agentLabel("  Open Code!  ")).toBe("selfhost:agent-open-code");
    expect(agentLabel("x".repeat(80))).toHaveLength(50);
    expect(isManagedLabel("SELFHOST:RISK-LOW")).toBe(true);
    expect(isManagedLabel("selfhost:keep")).toBe(false);
  });
});

describe("syncPullRequest", () => {
  it("applies everything once, then writes nothing on a second run", async () => {
    const first = await syncPullRequest(octokit, pr, desired());
    expect(first.writes).toEqual([
      { action: "add_labels", labels: ["selfhost:risk-low", "selfhost:agent-claude-code"] },
      { action: "create_check", externalId: checkExternalId(pr) },
      { action: "create_comment" },
      { action: "request_reviewers", users: ["bob"], teams: [] },
    ]);
    const state = github.pull(REPO, 101);
    expect(state.labels).toEqual(["bug", "selfhost:risk-low", "selfhost:agent-claude-code"]);
    expect(state.requestedUsers).toEqual(["bob"]);
    expect(state.comments).toHaveLength(1);
    expect(github.checkRuns).toMatchObject([
      {
        name: REVIEW_CHECK_NAME,
        head_sha: HEAD,
        external_id: "selfhost:acme/acme-api#101@5786c5c9d81ca4218b7e44bf0007f5580f66c489",
        status: "completed",
        conclusion: "neutral",
        output: { title: "Low risk", summary: "Low risk, score 5 of 100." },
      },
    ]);

    const writesBefore = github.writes.length;
    const second = await syncPullRequest(octokit, pr, desired());
    expect(second).toEqual({ writes: [], refused: [] });
    expect(github.writes).toHaveLength(writesBefore);
    expect(github.unknown).toEqual([]);
  });

  it("swaps the risk label when the level changes and leaves other labels alone", async () => {
    await syncPullRequest(octokit, pr, desired());
    github.pull(REPO, 101).labels.push("selfhost:keep");
    const { writes } = await syncPullRequest(
      octokit,
      pr,
      desired({ labels: { risk: "high", agent: "claude_code" } }),
    );
    expect(writes.filter((w) => w.action.includes("label"))).toEqual([
      { action: "remove_label", label: "selfhost:risk-low" },
      { action: "add_labels", labels: ["selfhost:risk-high"] },
    ]);
    expect(github.pull(REPO, 101).labels).toEqual([
      "bug",
      "selfhost:agent-claude-code",
      "selfhost:keep",
      "selfhost:risk-high",
    ]);
  });

  it("removes a risk label when no risk is given, and ignores label case", async () => {
    github.pull(REPO, 101).labels.push("SELFHOST:AGENT-CLAUDE-CODE", "selfhost:risk-medium");
    const { writes } = await syncPullRequest(octokit, pr, { labels: { agent: "claude_code" } });
    expect(writes).toEqual([{ action: "remove_label", label: "selfhost:risk-medium" }]);
  });

  it("treats a label someone removed in between as removed", async () => {
    github.pull(REPO, 101).labels.push("selfhost:risk-low");
    github.failNext("DELETE", /labels\/selfhost:risk-low$/, 404);
    const { writes } = await syncPullRequest(octokit, pr, { labels: { risk: "high" } });
    expect(writes).toEqual([
      { action: "remove_label", label: "selfhost:risk-low" },
      { action: "add_labels", labels: ["selfhost:risk-high"] },
    ]);
  });

  it("upserts one check run per head commit", async () => {
    await syncPullRequest(octokit, pr, desired());
    const changed = desired({
      check: { title: "High risk", summary: "High.", text: "Table", conclusion: "failure" },
    });
    const update = await syncPullRequest(octokit, pr, changed);
    expect(update.writes).toEqual([{ action: "update_check", id: github.checkRuns[0]?.id }]);
    expect(github.checkRuns).toHaveLength(1);
    expect(github.checkRuns[0]).toMatchObject({ conclusion: "failure", output: { text: "Table" } });

    const pushed = { ...pr, headSha: NEXT_HEAD };
    const next = await syncPullRequest(octokit, pushed, changed);
    expect(next.writes).toContainEqual({
      action: "create_check",
      externalId: checkExternalId(pushed),
    });
    expect(github.checkRuns.map((run) => run.head_sha)).toEqual([HEAD, NEXT_HEAD]);
    expect((await syncPullRequest(octokit, pushed, changed)).writes).toEqual([]);
  });

  it("does not take over another app's run with the same name", async () => {
    github.checkRuns.push({
      id: 1,
      name: REVIEW_CHECK_NAME,
      head_sha: HEAD,
      external_id: "other",
      status: "completed",
      conclusion: "success",
      output: { title: "x", summary: "y", text: null },
    });
    const { writes } = await syncPullRequest(octokit, pr, { labels: {}, check: desired().check });
    expect(writes).toEqual([{ action: "create_check", externalId: checkExternalId(pr) }]);
  });

  it("cuts check output to GitHub's limit and stays idempotent", async () => {
    const long = { title: "Big", summary: "s".repeat(70_000), conclusion: "neutral" as const };
    await syncPullRequest(octokit, pr, { labels: {}, check: long });
    expect(github.checkRuns[0]?.output.summary).toHaveLength(MAX_CHECK_OUTPUT);
    expect((await syncPullRequest(octokit, pr, { labels: {}, check: long })).writes).toEqual([]);
  });

  it("requests a review only from people not already requested or already reviewing", async () => {
    const state = github.pull(REPO, 101);
    state.requestedUsers.push("bob");
    state.reviews.push({ login: "carol", state: "APPROVED" });
    state.requestedTeams.push("platform");
    const { writes } = await syncPullRequest(octokit, pr, {
      labels: {},
      reviewers: { users: ["Bob", "carol", "alice", "dave"], teams: ["Platform", "infra"] },
    });
    // alice opened it, so GitHub would refuse her.
    expect(writes).toEqual([{ action: "request_reviewers", users: ["dave"], teams: ["infra"] }]);
  });

  it("reports a request GitHub refuses and still applies the rest", async () => {
    github = new FakeGitHub({ collaborators: ["bob"] });
    github.addPull(REPO, 101, { author: "alice" });
    octokit = new Octokit({ auth: FAKE_INSTALLATION_TOKEN, request: { fetch: github.fetch } });
    const result = await syncPullRequest(octokit, pr, {
      ...desired(),
      reviewers: { users: ["mallory"], teams: [] },
    });
    expect(result.refused).toEqual([
      { users: ["mallory"], teams: [], message: expect.stringContaining("collaborators") },
    ]);
    expect(result.writes.map((w) => w.action)).toEqual([
      "add_labels",
      "create_check",
      "create_comment",
    ]);
  });

  it("fails on other GitHub errors", async () => {
    github.failNext("POST", /\/check-runs$/, 403);
    await expect(syncPullRequest(octokit, pr, desired())).rejects.toMatchObject({ status: 403 });
  });

  it("edits the brief comment in place by its marker", async () => {
    const state = github.pull(REPO, 101);
    state.comments.push({
      id: 1,
      body: `Quoting ${MARKER} here`,
      user: { login: "bob", type: "User" },
    });
    await syncPullRequest(octokit, pr, desired());
    const mine = state.comments.find((c) => c.user.type === "Bot");
    const { writes } = await syncPullRequest(
      octokit,
      pr,
      desired({ brief: { body: `${MARKER}\n## Review brief\n\nNow with tests.`, marker: MARKER } }),
    );
    expect(writes).toEqual([{ action: "update_comment", id: mine?.id }]);
    expect(state.comments).toHaveLength(2);
    expect(mine?.body).toContain("Now with tests.");
    expect(state.comments[0]?.body).toBe(`Quoting ${MARKER} here`);
  });

  it("puts the marker first when the body lacks it, and finds that comment again", async () => {
    const brief = { body: "## Review brief", marker: MARKER };
    await syncPullRequest(octokit, pr, { labels: {}, brief });
    expect(github.pull(REPO, 101).comments[0]?.body).toBe(`${MARKER}\n## Review brief`);
    expect((await syncPullRequest(octokit, pr, { labels: {}, brief })).writes).toEqual([]);
  });

  it("reads and writes only what desired names", async () => {
    await syncPullRequest(octokit, pr, { labels: {} });
    expect(github.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /repos/acme/acme-api/issues/101/labels",
    ]);
  });
});

describe("syncComment", () => {
  const RECEIPT = "<!-- selfhost:receipt v1 -->";

  it("posts a marked comment once, edits it when it changes, and returns its URL", async () => {
    const first = await syncComment(octokit, pr, { body: `${RECEIPT}\nPassed.`, marker: RECEIPT });
    expect(first).toEqual({
      id: first.id,
      url: `https://github.com/${REPO}/pull/101#issuecomment-${first.id}`,
      write: { action: "create_comment" },
    });
    const same = await syncComment(octokit, pr, { body: `${RECEIPT}\nPassed.`, marker: RECEIPT });
    expect(same).toEqual({ id: first.id, url: first.url });
    const changed = await syncComment(octokit, pr, {
      body: `${RECEIPT}\nFailed.`,
      marker: RECEIPT,
    });
    expect(changed.write).toEqual({ action: "update_comment", id: first.id });
    expect(github.pull(REPO, 101).comments.map((c) => c.body)).toEqual([`${RECEIPT}\nFailed.`]);
  });

  it("keeps the brief and the receipt in separate comments", async () => {
    await syncPullRequest(octokit, pr, { labels: {}, brief: desired().brief });
    await syncComment(octokit, pr, { body: `${RECEIPT}\nPassed.`, marker: RECEIPT });
    await syncPullRequest(octokit, pr, { labels: {}, brief: desired().brief });
    expect(github.pull(REPO, 101).comments).toHaveLength(2);
  });
});

describe("approve", () => {
  const APPROVE = "<!-- selfhost:auto-approve v1 -->";
  const approve = { body: `${APPROVE}\nApproved: docs only.`, marker: APPROVE };

  it("approves the head commit once, and again only after a push", async () => {
    const first = await syncPullRequest(octokit, pr, { labels: {}, approve });
    expect(first.writes).toEqual([{ action: "approve", commitId: HEAD }]);
    const posted = github.writes.find((request) => request.path.endsWith("/reviews"));
    expect(posted).toMatchObject({
      method: "POST",
      path: `/repos/${REPO}/pulls/101/reviews`,
      body: { event: "APPROVE", commit_id: HEAD, body: approve.body },
    });
    expect(github.pull(REPO, 101).reviews).toEqual([
      {
        login: "selfhost[bot]",
        type: "Bot",
        state: "APPROVED",
        body: approve.body,
        commit_id: HEAD,
      },
    ]);
    expect((await syncPullRequest(octokit, pr, { labels: {}, approve })).writes).toEqual([]);
    const pushed = await syncPullRequest(
      octokit,
      { ...pr, headSha: NEXT_HEAD },
      {
        labels: {},
        approve,
      },
    );
    expect(pushed.writes).toEqual([{ action: "approve", commitId: NEXT_HEAD }]);
  });

  it("does not count a person's approval or another bot's as its own", async () => {
    github
      .pull(REPO, 101)
      .reviews.push(
        { login: "bob", state: "APPROVED", commit_id: HEAD, body: APPROVE },
        { login: "other[bot]", type: "Bot", state: "APPROVED", commit_id: HEAD, body: "LGTM" },
      );
    expect((await syncPullRequest(octokit, pr, { labels: {}, approve })).writes).toEqual([
      { action: "approve", commitId: HEAD },
    ]);
  });

  it("never approves when desired leaves it out", async () => {
    await syncPullRequest(octokit, pr, desired());
    expect(github.writes.some((request) => request.path.endsWith("/reviews"))).toBe(false);
  });
});

describe("readHeadChecks", () => {
  it("reads check runs and commit statuses, leaving out selfhost's own", async () => {
    const run = (id: number, name: string, status: string, conclusion: string | null) => ({
      id,
      name,
      head_sha: HEAD,
      external_id: null,
      status,
      conclusion,
      output: { title: null, summary: null, text: null },
    });
    github.checkRuns.push(
      run(1, "ci / test", "completed", "success"),
      run(2, "ci / lint", "completed", "neutral"),
      run(3, "ci / e2e", "in_progress", null),
      run(4, "ci / deploy-preview", "completed", "failure"),
      run(5, REVIEW_CHECK_NAME, "completed", "neutral"),
    );
    github.statuses.set(HEAD, [
      { context: "netlify", state: "success" },
      { context: "selfhost/receipt", state: "pending" },
    ]);
    expect(await readHeadChecks(octokit, pr)).toEqual([
      { name: "ci / test", state: "passed" },
      { name: "ci / lint", state: "passed" },
      { name: "ci / e2e", state: "pending" },
      { name: "ci / deploy-preview", state: "failed" },
      { name: "netlify", state: "passed" },
    ]);
  });
});
