import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CommitRecord, readCommits, type SessionHint } from "../src/index.js";
import { lines, SINCE, TempRepo } from "./helpers.js";

const CLAUDE_SESSION = "7b0c2c1e-4f5a-4c8e-9d2b-3a1f0e6d5c4b";
const WEB_SESSION = "session_01DiUkqY2kzbUbDmW1w96rfi";
const AMP_THREAD = "T-5f0c2a9e-1b3d-4c7e-8a6f-2d9b0e4c1a73";

const repo = new TempRepo();
const sha: Record<string, string> = {};
let sessions: SessionHint[];
let commits: CommitRecord[];
const byLabel = (label: string) => {
  const commit = commits.find((c) => c.sha === sha[label]);
  if (!commit) throw new Error(`no commit ${label}`);
  return commit;
};

beforeAll(async () => {
  const c = (label: string, input: Parameters<TempRepo["commit"]>[0]) => {
    sha[label] = repo.commit(input);
  };
  c("before-window", {
    message: "Initial commit",
    at: "2026-09-20T09:00:00Z",
    files: { "README.md": lines(3), "docs/a.md": lines(20, "doc") },
  });
  c("claude-trailer", {
    message:
      "Add rate limiter\n\nToken bucket per key.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>\n",
    at: "2026-10-02T09:00:00Z",
    files: { "src/limit.ts": lines(10) },
  });
  c("codex-trailer", {
    message: "Parse config\n\nCo-authored-by: Codex <noreply@openai.com>\n",
    at: "2026-10-02T10:00:00Z",
    files: { "src/config.ts": lines(4) },
  });
  c("cursor-author", {
    message: "Update docs\n\nCo-authored-by: Alice Example <alice@example.com>\n",
    at: "2026-10-02T11:00:00Z",
    author: { name: "Cursor Agent", email: "cursoragent@cursor.com" },
    files: { "docs/limits.md": lines(2) },
  });
  c("cursor-made-with", {
    message: "Tidy limiter names\n\nMade-with: Cursor\n",
    at: "2026-10-02T11:30:00Z",
    files: { "src/limit.ts": lines(11) },
  });
  c("copilot-cli-trailer", {
    message:
      "Add health check\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\n",
    at: "2026-10-02T12:00:00Z",
    files: { "src/health.ts": lines(3) },
  });
  c("aider-trailer", {
    message:
      "aider: Add retry helper\n\nCo-authored-by: aider (openrouter/anthropic/claude-sonnet-4.5) <aider@aider.chat>\n",
    at: "2026-10-02T13:00:00Z",
    files: { "src/retry.ts": lines(5) },
  });
  c("amp-trailer", {
    message: `Add metrics\n\nAmp-Thread-ID: https://ampcode.com/threads/${AMP_THREAD}\nCo-authored-by: Amp <amp@ampcode.com>\n`,
    at: "2026-10-02T14:00:00Z",
    files: { "src/metrics.ts": lines(2) },
  });
  c("copilot-bot-author", {
    message: "Fix flaky test\n\nCo-authored-by: Alice Example <alice@example.com>\n",
    at: "2026-10-02T15:00:00Z",
    author: {
      name: "copilot-swe-agent[bot]",
      email: "198982749+Copilot@users.noreply.github.com",
    },
    files: { "test/session.test.ts": lines(6) },
  });
  c("devin-bot-author", {
    message: "Add audit CSV export",
    at: "2026-10-02T16:00:00Z",
    author: {
      name: "Devin AI",
      email: "158243242+devin-ai-integration[bot]@users.noreply.github.com",
    },
    files: { "src/audit.ts": lines(8) },
  });
  c("known-session", {
    message: `Add billing export\n\nSession: ${CLAUDE_SESSION}\n`,
    at: "2026-10-02T17:00:00Z",
    files: { "src/billing.ts": lines(12) },
  });
  c("web-session", {
    message: `Fix typo in errors\n\nClaude-Session: https://claude.ai/code/${WEB_SESSION}\n`,
    at: "2026-10-02T18:00:00Z",
    files: { "src/errors.ts": lines(2) },
  });
  c("lookalike", {
    message:
      "Keep return_to across login\n\nCo-authored-by: Claude Monet <claude.monet@example.com>\n",
    at: "2026-10-02T19:00:00Z",
    files: { "src/auth.ts": lines(4) },
  });
  c("plain", {
    message: "Bump version",
    at: "2026-10-02T20:00:00Z",
    files: { "package.json": "{}\n" },
  });
  // A Goose session edits src/cache.ts and src/warm.ts from 10:00 to 10:30.
  c("file-no-overlap", {
    message: "Unrelated edit",
    at: "2026-10-03T10:20:00Z",
    files: { "src/other.ts": lines(2) },
  });
  c("file-time-absolute", {
    message: "Warm on boot",
    at: "2026-10-03T10:25:00Z",
    files: { "src/warm.ts": lines(3) },
  });
  c("file-time", {
    message: "Warm cache",
    at: "2026-10-03T10:50:00Z",
    files: { "src/cache.ts": lines(5) },
  });
  c("file-too-late", {
    message: "Later cache tweak",
    at: "2026-10-03T11:15:00Z",
    files: { "src/cache.ts": lines(6) },
  });
  // Two sessions of different agents edited one file each of this commit, in the same window.
  c("file-tie", {
    message: "Shared change",
    at: "2026-10-04T09:10:00Z",
    files: { "src/a.ts": lines(1), "src/b.ts": lines(1) },
  });
  c("rename-and-binary", {
    message: "Move docs, add logo",
    at: "2026-10-04T12:00:00Z",
    rename: ["docs/a.md", "docs/b.md"],
    files: {
      "docs/b.md": `${lines(20, "doc")}one more\n`,
      "assets/logo.png": Buffer.from([0, 1, 2, 3, 0]),
    },
  });

  // Agent branches: one left unmerged, one merged into main, one that only exists on the remote.
  repo.git("checkout", "-q", "-b", "codex/fix-typo");
  c("codex-branch", {
    message: "Fix typo",
    at: "2026-10-05T09:00:00Z",
    files: { "src/typo.ts": lines(1) },
  });
  c("trailer-beats-branch", {
    message: "Retry on 503\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n",
    at: "2026-10-05T09:30:00Z",
    files: { "src/typo.ts": lines(2) },
  });
  repo.git("checkout", "-q", "main");
  repo.git("checkout", "-q", "-b", "cursor/old-docs");
  c("merged-branch", {
    message: "Docs pass",
    at: "2026-10-05T10:00:00Z",
    files: { "docs/c.md": lines(2) },
  });
  repo.git("checkout", "-q", "main");
  sha.merge = (() => {
    repo.git(
      "-c",
      "user.name=Alice Example",
      "-c",
      "user.email=alice@example.com",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "Merge branch cursor/old-docs",
      "cursor/old-docs",
    );
    return repo.git("rev-parse", "HEAD");
  })();
  repo.git("checkout", "-q", "-b", "scratch");
  c("remote-claude-branch", {
    message: "Web task",
    at: "2026-10-05T11:00:00Z",
    files: { "src/web.ts": lines(2) },
  });
  repo.git("update-ref", "refs/remotes/origin/claude/web-task", "HEAD");
  repo.git("checkout", "-q", "main");
  repo.git("branch", "-q", "-D", "scratch");

  sessions = [
    {
      sessionId: CLAUDE_SESSION,
      vendor: "claude_code",
      model: "claude-opus-4-5",
      start: "2026-10-02T16:00:00Z",
      end: "2026-10-02T16:50:00Z",
      cwd: repo.dir,
      files: [],
    },
    {
      sessionId: "goose-1",
      vendor: "goose",
      model: "gpt-5.5",
      start: "2026-10-03T10:00:00Z",
      end: "2026-10-03T10:30:00Z",
      cwd: repo.dir,
      files: ["src/cache.ts", join(repo.dir, "src", "warm.ts")],
    },
    {
      // Same files and window, but another repository.
      sessionId: "codex-elsewhere",
      vendor: "codex",
      start: "2026-10-03T10:00:00Z",
      end: "2026-10-03T10:30:00Z",
      cwd: "/home/dev/other-repo",
      files: ["src/cache.ts", "src/warm.ts"],
    },
    {
      sessionId: "tie-claude",
      vendor: "claude_code",
      start: "2026-10-04T09:00:00Z",
      end: "2026-10-04T09:05:00Z",
      cwd: repo.dir,
      files: ["src/a.ts"],
    },
    {
      sessionId: "tie-codex",
      vendor: "codex",
      start: "2026-10-04T09:00:00Z",
      end: "2026-10-04T09:05:00Z",
      cwd: join(repo.dir, "src"),
      files: ["b.ts"],
    },
  ];
  commits = await readCommits(repo.dir, { since: SINCE, sessions });
});

afterAll(() => repo.remove());

describe("readCommits", () => {
  it("reads commits since the date on every branch, newest first, without merges", () => {
    const shas = commits.map((c) => c.sha);
    expect(shas).not.toContain(sha["before-window"]);
    expect(shas).not.toContain(sha.merge);
    expect(shas).toContain(sha["codex-branch"]);
    expect(shas).toContain(sha["remote-claude-branch"]);
    expect(commits).toHaveLength(Object.keys(sha).length - 2);
    const times = commits.map((c) => c.authoredAt);
    expect(times).toEqual([...times].sort().reverse());
  });

  it("counts lines and files from numstat, with renames under the new path", () => {
    expect(byLabel("claude-trailer")).toMatchObject({
      authoredAt: "2026-10-02T09:00:00.000Z",
      authorEmail: "alice@example.com",
      subject: "Add rate limiter",
      files: ["src/limit.ts"],
      additions: 10,
      deletions: 0,
    });
    const moved = byLabel("rename-and-binary");
    expect([...moved.files].sort()).toEqual(["assets/logo.png", "docs/b.md"]);
    expect(moved).toMatchObject({ additions: 1, deletions: 0 });
  });

  it.each([
    ["claude-trailer", { vendor: "claude_code", model: "claude-opus-4-5" }],
    ["codex-trailer", { vendor: "codex" }],
    ["cursor-made-with", { vendor: "cursor" }],
    ["copilot-cli-trailer", { vendor: "copilot" }],
    ["aider-trailer", { vendor: "other", model: "openrouter/anthropic/claude-sonnet-4.5" }],
    ["amp-trailer", { vendor: "other" }],
  ])("attributes %s from its co-author trailer", (label, agent) => {
    expect(byLabel(label)).toMatchObject({ agent, signal: "co_author_trailer" });
    expect(byLabel(label).agent).toEqual(agent);
  });

  it("keeps the session link next to a trailer", () => {
    expect(byLabel("amp-trailer").sessionId).toBe(AMP_THREAD);
  });

  it("attributes known session ids and vendor session links", () => {
    expect(byLabel("known-session")).toMatchObject({
      agent: { vendor: "claude_code", model: "claude-opus-4-5" },
      signal: "session_id",
      sessionId: CLAUDE_SESSION,
    });
    expect(byLabel("web-session")).toMatchObject({
      agent: { vendor: "claude_code" },
      signal: "session_id",
      sessionId: WEB_SESSION,
    });
  });

  it("attributes commits authored by agent accounts", () => {
    expect(byLabel("copilot-bot-author")).toMatchObject({
      agent: { vendor: "copilot" },
      signal: "bot_account",
    });
    expect(byLabel("devin-bot-author")).toMatchObject({
      agent: { vendor: "other" },
      signal: "bot_account",
    });
    expect(byLabel("cursor-author")).toMatchObject({
      agent: { vendor: "cursor" },
      signal: "bot_account",
    });
  });

  it("uses branch prefixes only for commits no other branch reaches", () => {
    expect(byLabel("codex-branch")).toMatchObject({
      agent: { vendor: "codex" },
      signal: "branch_prefix",
    });
    expect(byLabel("remote-claude-branch")).toMatchObject({
      agent: { vendor: "claude_code" },
      signal: "branch_prefix",
    });
    expect(byLabel("merged-branch").agent).toBeUndefined();
  });

  it("prefers the stronger signal", () => {
    expect(byLabel("trailer-beats-branch")).toMatchObject({
      agent: { vendor: "claude_code" },
      signal: "co_author_trailer",
    });
  });

  it("matches files and time against sessions in this repository", () => {
    for (const label of ["file-time", "file-time-absolute"]) {
      expect(byLabel(label)).toMatchObject({
        agent: { vendor: "goose", model: "gpt-5.5" },
        signal: "file_time_match",
        sessionId: "goose-1",
      });
    }
  });

  it.each(["plain", "lookalike", "file-no-overlap", "file-too-late", "file-tie", "merged-branch"])(
    "leaves %s unattributed",
    (label) => {
      const commit = byLabel(label);
      expect(commit.agent).toBeUndefined();
      expect(commit.signal).toBeUndefined();
      expect(commit.sessionId).toBeUndefined();
    },
  );

  it("reads an empty window or repository and fails outside a repository", async () => {
    expect(await readCommits(repo.dir, { since: new Date("2027-01-01T00:00:00Z") })).toEqual([]);
    const empty = new TempRepo();
    expect(await readCommits(empty.dir, { since: SINCE, sessions })).toEqual([]);
    empty.remove();
    await expect(readCommits("/", { since: SINCE })).rejects.toThrow(/git rev-parse failed/);
  });
});
