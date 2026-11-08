import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { readProvenance } from "../src/index.js";
import { ALICE, day, FixtureRepo, GITHUB, lines, SINCE, text, UNTIL } from "./helpers.js";

const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.remove();
});

function fresh(): FixtureRepo {
  const repo = new FixtureRepo();
  repos.push(repo);
  repo.commit({ message: "Initial", at: day(0), files: { "README.md": "acme\n" } });
  return repo;
}

const RUN = (sha: string) => ({
  sha,
  agent: { vendor: "claude_code" as const, model: "claude-sonnet-4-5" },
  sessionId: "sess-flags",
});

describe("reverts and rework through GitHub's merge styles", () => {
  it("counts a squash-merged revert pull request as a revert, even when it adds other lines", async () => {
    const repo = fresh();
    const flags = repo.commit({
      message: "Add flags (#12)",
      at: day(1),
      committer: GITHUB,
      files: { "src/flags.ts": text(lines(10, "flag")) },
    });
    // GitHub's Revert button, squash merged: the lines go and the author adds a note in place.
    repo.commit({
      message: 'Revert "Add flags (#12)" (#13)\n\nReverts acme/api#12\n',
      at: day(2),
      committer: GITHUB,
      files: { "src/flags.ts": text(lines(6, "note")) },
    });
    const report = await readProvenance(repo.dir, {
      since: SINCE,
      until: UNTIL,
      runs: [RUN(flags)],
    });
    expect(report.by_agent.find((row) => row.vendor === "claude_code")).toMatchObject({
      model: "claude-sonnet-4-5",
      lines: 10,
      runs: 1,
      reverted_lines: 10,
      reworked_lines: 0,
    });
  });

  it("counts `git revert -m 1` of a merge commit as a revert of the pull request's lines", async () => {
    const repo = fresh();
    repo.checkout("-b", "feature");
    const work = repo.commit({
      message: "Add limiter",
      at: day(1),
      files: { "src/limiter.ts": text(lines(9, "limit")) },
    });
    repo.checkout("main");
    const merge = repo.merge("feature", {
      message: "Merge pull request #20 from acme/feature",
      at: day(2),
      committer: GITHUB,
    });
    execFileSync("git", ["-C", repo.dir, "revert", "--no-edit", "-m", "1", merge], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: ALICE.name,
        GIT_AUTHOR_EMAIL: ALICE.email,
        GIT_AUTHOR_DATE: day(3),
        GIT_COMMITTER_NAME: ALICE.name,
        GIT_COMMITTER_EMAIL: ALICE.email,
        GIT_COMMITTER_DATE: day(3),
      },
      stdio: "ignore",
    });
    const report = await readProvenance(repo.dir, {
      since: SINCE,
      until: UNTIL,
      runs: [RUN(work)],
    });
    expect(report.by_agent.find((row) => row.vendor === "claude_code")).toMatchObject({
      lines: 9,
      reverted_lines: 9,
    });
  });

  it("counts a fix-forward rewrite of every line as rework, not a revert", async () => {
    const repo = fresh();
    const flags = repo.commit({
      message: "Add flags",
      at: day(1),
      files: { "src/flags.ts": text(lines(4, "flag")) },
    });
    repo.commit({
      message: "Fix flags",
      at: day(2),
      files: { "src/flags.ts": text(lines(4, "fixed flag")) },
    });
    const report = await readProvenance(repo.dir, {
      since: SINCE,
      until: UNTIL,
      runs: [RUN(flags)],
    });
    expect(report.by_agent.find((row) => row.vendor === "claude_code")).toMatchObject({
      reverted_lines: 0,
      reworked_lines: 4,
    });
  });

  it("follows a line moved to another file in the same commit, so the move is no change", async () => {
    const repo = fresh();
    const body = lines(12, "export const value_that_is_long_enough_to_move =");
    const added = repo.commit({
      message: "Add constants",
      at: day(1),
      files: { "src/a.ts": text(body) },
    });
    repo.commit({
      message: "Move constants",
      at: day(2),
      files: { "src/a.ts": null, "src/b.ts": text(body) },
    });
    const report = await readProvenance(repo.dir, {
      since: SINCE,
      until: UNTIL,
      runs: [RUN(added)],
    });
    expect(report.by_agent.find((row) => row.vendor === "claude_code")).toMatchObject({
      lines: 12,
      reverted_lines: 0,
      reworked_lines: 0,
    });
  });

  it("uses per-commit vendor stats only when nothing else names an agent, and reports them", async () => {
    const repo = fresh();
    const plain = repo.commit({
      message: "Add table",
      at: day(1),
      files: { "src/table.ts": text(lines(6, "row")) },
    });
    const report = await readProvenance(repo.dir, {
      since: SINCE,
      until: UNTIL,
      vendorStats: [
        { vendor: "cursor", commit: plain.slice(0, 10), lines_added: 6 },
        { vendor: "claude_code", day: "2026-10-03", lines_added: 40, lines_removed: 2 },
        { vendor: "claude_code", day: "2026-12-01", lines_added: 999 },
      ],
    });
    expect(report.by_agent.find((row) => row.vendor === "cursor")?.lines).toBe(6);
    expect(report.vendor_reported).toEqual([
      { vendor: "claude_code", lines_added: 40, lines_removed: 2 },
      { vendor: "cursor", lines_added: 6, lines_removed: 0 },
    ]);
  });
});
