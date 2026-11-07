import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LedgerEvent, validateEventBatch } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CommitRecord,
  ghCliSource,
  type PullRecord,
  readPulls,
  toLedgerEvents,
} from "../src/index.js";
import { LOCAL_COMMITS, REPO, recordedGh, SINCE } from "./helpers.js";

let cacheDir: string;
let pulls: PullRecord[];
let events: LedgerEvent[];

const botCommit: CommitRecord = {
  sha: "88ee1cbce0f2a60ac5a3fc7bed75a8fcea7da2b4",
  authoredAt: "2026-10-12T10:05:00.000Z",
  authorEmail: "158243242+devin-ai-integration[bot]@users.noreply.github.com",
  subject: "Add audit log CSV export",
  files: ["src/audit.ts"],
  additions: 80,
  deletions: 2,
  agent: { vendor: "other" },
  signal: "bot_account",
};
const commits = [...LOCAL_COMMITS, botCommit];

beforeAll(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "selfhost-gh-cache-"));
  pulls = await readPulls(REPO, {
    since: SINCE,
    commits,
    source: ghCliSource({ run: recordedGh().run, cacheDir }),
  });
  events = toLedgerEvents(commits, pulls, { actorId: "dev@example.com", repo: REPO });
});

afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

const find = (kind: LedgerEvent["kind"], match: (e: LedgerEvent) => boolean) => {
  const found = events.find((e) => e.kind === kind && match(e));
  if (!found) throw new Error(`no ${kind}`);
  return found;
};
const forPull = (n: number) => (e: LedgerEvent) => e.links?.pr_url?.endsWith(`/pull/${n}`) === true;

describe("toLedgerEvents", () => {
  it("writes valid events with unique ids", () => {
    const result = validateEventBatch(events);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it("writes one commit.created per commit and one pr.opened per pull request", () => {
    const count = (kind: string) => events.filter((e) => e.kind === kind).length;
    expect(count("commit.created")).toBe(commits.length);
    expect(count("pr.opened")).toBe(pulls.length);
    expect(count("pr.merged")).toBe(pulls.filter((p) => p.state === "merged").length);
    expect(count("pr.closed")).toBe(pulls.filter((p) => p.state === "closed").length);
  });

  it("puts agent, model, signal and links on attributed records", () => {
    expect(
      find("commit.created", (e) => e.links?.commit_sha === LOCAL_COMMITS[0]?.sha),
    ).toMatchObject({
      source: "cli",
      ts: "2026-10-08T08:30:00.000Z",
      actor: { kind: "person", id: "alice@example.com" },
      repo: REPO,
      agent: { vendor: "claude_code" },
      model: "claude-opus-4-5",
      session_id: "7b0c2c1e-4f5a-4c8e-9d2b-3a1f0e6d5c4b",
      links: { pr_url: "https://github.com/acme/acme-api/pull/105" },
      data: { signal: "session_id", additions: 700, deletions: 120, files: 1 },
    });
    expect(find("pr.merged", forPull(105))).toMatchObject({
      source: "github",
      ts: "2026-10-08T21:00:00.000Z",
      actor: { kind: "person", id: "alice" },
      agent: { vendor: "claude_code" },
      model: "claude-opus-4-5",
      target: { type: "pr", value: "https://github.com/acme/acme-api/pull/105" },
      data: {
        signal: "session_id",
        number: 105,
        head_ref: "feature/billing-export",
        approvals: 1,
        review_comments: 0,
        unreviewed_merge: true,
      },
    });
    expect(find("pr.closed", forPull(103))).toMatchObject({
      ts: "2026-10-09T09:00:00.000Z",
      agent: { vendor: "codex" },
      data: { signal: "session_id" },
    });
  });

  it("marks commits pushed without a pull request and unattributed records", () => {
    const direct = find("commit.created", (e) => e.links?.commit_sha === LOCAL_COMMITS[2]?.sha);
    expect(direct.links).toEqual({ commit_sha: LOCAL_COMMITS[2]?.sha });
    expect(direct.agent).toBeUndefined();
    expect(direct.data).toMatchObject({ unattributed: true });
    const human = find("pr.opened", forPull(106));
    expect(human.agent).toBeUndefined();
    expect(human.model).toBeUndefined();
    expect(human.data).toMatchObject({ unattributed: true });
    expect(human.data?.signal).toBeUndefined();
  });

  it("makes bot accounts agent actors", () => {
    expect(find("commit.created", (e) => e.links?.commit_sha === botCommit.sha).actor).toEqual({
      kind: "agent",
      id: botCommit.authorEmail,
    });
    expect(find("pr.opened", forPull(102)).actor).toEqual({ kind: "agent", id: "github:Copilot" });
    expect(find("pr.opened", forPull(107)).actor).toEqual({
      kind: "agent",
      id: "github:devin-ai-integration[bot]",
    });
  });

  it("gives the same ids on a second run and different ids in another repository", () => {
    const again = toLedgerEvents(commits, pulls, { actorId: "dev@example.com", repo: REPO });
    expect(again.map((e) => e.id)).toEqual(events.map((e) => e.id));
    const other = toLedgerEvents(commits, pulls, { actorId: "dev@example.com", repo: "acme/fork" });
    const otherCommitIds = new Set(
      other.filter((e) => e.kind === "commit.created").map((e) => e.id),
    );
    expect(
      events.filter((e) => e.kind === "commit.created").some((e) => otherCommitIds.has(e.id)),
    ).toBe(false);
  });

  it("falls back to ctx.actorId for a deleted author", () => {
    const [ghost] = toLedgerEvents([], [{ ...(pulls[0] as PullRecord), author: "ghost" }], {
      actorId: "dev@example.com",
    });
    expect(ghost?.actor).toEqual({ kind: "person", id: "dev@example.com" });
    expect(ghost?.repo).toBeUndefined();
  });
});
