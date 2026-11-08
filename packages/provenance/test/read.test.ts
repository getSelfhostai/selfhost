import type { ProvenanceReport } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  groupLandings,
  readMainline,
  readProvenance,
  systemGit,
  trackRepository,
} from "../src/index.js";
import { SINCE, UNTIL } from "./helpers.js";
import { buildHistory, type History } from "./history.js";

let history: History;
let report: ProvenanceReport;

beforeAll(async () => {
  history = buildHistory();
  report = await readProvenance(history.repo.dir, {
    since: SINCE,
    until: UNTIL,
    repo: "acme/api",
    runs: history.runs,
    pulls: [{ number: 11, agent: { vendor: "copilot" } }],
  });
});

afterAll(() => history.repo.remove());

const agent = (vendor: string, model: string | null = null) =>
  report.by_agent.find((row) => row.vendor === vendor && row.model === model);

describe("readProvenance on a fixture history", () => {
  it("reads the main branch and every landing in the window", () => {
    expect(report).toMatchObject({
      schema: "selfhost.provenance/v1",
      repo: "acme/api",
      status: "computed",
      branch: "main",
      head: history.shas.lateDocs,
      window_days: 14,
      threshold: 0.25,
    });
    expect(report.totals).toEqual({
      lines: 144,
      agent_lines: 127,
      agent_share: 127 / 144,
      landings: 13,
      agent_reverted_lines: 72,
      agent_reworked_lines: 5,
      agent_revert_rework_rate: 77 / 127,
    });
  });

  it("counts lines by agent and model, with the revert and rework rate of each", () => {
    expect(report.by_agent.map((row) => [row.vendor, row.model, row.lines])).toEqual([
      ["claude_code", null, 35],
      ["codex", null, 65],
      ["goose", "gpt-5.5", 8],
      ["cursor", null, 12],
      ["copilot", null, 7],
      ["unattributed", null, 17],
    ]);
    // Bob's fix-forward of three lines is rework; the reindent and the day-20 edit are not.
    expect(agent("claude_code")).toMatchObject({
      reverted_lines: 0,
      reworked_lines: 3,
      open_lines: 3,
      revert_rework_rate: 3 / 35,
      landings: 4,
    });
    // `git revert` of the 60 lines.
    expect(agent("codex")).toMatchObject({
      reverted_lines: 60,
      reworked_lines: 0,
      revert_rate: 60 / 65,
      landings: 2,
    });
    // Deleting the file with no revert message still takes the lines out wholesale.
    expect(agent("cursor")).toMatchObject({ reverted_lines: 12, revert_rate: 1 });
    // Joined to the goose run through the ledger; the edit after the rename is rework.
    expect(agent("goose", "gpt-5.5")).toMatchObject({
      lines: 8,
      runs: 1,
      reworked_lines: 2,
      rework_rate: 0.25,
    });
    expect(agent("copilot")).toMatchObject({ lines: 7, reworked_lines: 0 });
  });

  it("keeps a branch commit by a person on an agent's pull request as the person's", () => {
    const bob = report.by_person.find((row) => row.person === "bob@example.com");
    expect(bob).toEqual({
      person: "bob@example.com",
      lines: 10,
      agent_lines: 0,
      agent_share: 0,
      by_agent: [{ vendor: "unattributed", model: null, lines: 10 }],
    });
    const alice = report.by_person.find((row) => row.person === "alice@example.com");
    expect(alice?.lines).toBe(122);
    expect(alice?.agent_lines).toBe(115);
  });

  it("ranks modules by agent-written lines and flags the ones above the threshold", () => {
    expect(
      report.modules.map((row) => [
        row.rank,
        row.module,
        row.lines,
        row.agent_lines,
        row.agent_revert_rework_rate,
        row.above_threshold,
      ]),
    ).toEqual([
      [1, "lib", 73, 73, 60 / 73, true],
      [2, "src", 40, 31, 3 / 31, false],
      [3, "web", 12, 12, 1, false],
      [4, "pkg", 10, 8, 0.25, false],
      [5, "docs", 7, 3, 0, false],
      [6, "(root)", 2, 0, null, false],
    ]);
  });

  it("groups a rebase merge into one landing and leaves the root commit with no bottom", async () => {
    const git = systemGit(history.repo.dir);
    const landings = groupLandings(await readMainline(git, "main", SINCE));
    const queue = landings.find((l) => l.commits.some((c) => c.sha === history.shas.queue1));
    expect(queue?.commits.map((c) => c.sha)).toEqual([history.shas.queue1, history.shas.queue2]);
    expect(landings.find((l) => l.pr === 7)?.commits.map((c) => c.sha)).toEqual([
      history.shas.merge,
    ]);
    expect(landings.find((l) => l.pr === 9)?.commits[0]?.sha).toBe(history.shas.squashCodex);
    expect(landings[0]?.bottom).toBeUndefined();
  });

  it("names the commit that reverted or reworked each line", async () => {
    const tracked = await trackRepository(systemGit(history.repo.dir), "main", {
      since: SINCE,
      until: UNTIL,
      settings: { modules: {}, moduleDepth: 1, windowDays: 14, threshold: 0.25 },
    });
    const of = (sha: string | undefined) =>
      tracked.find((t) => t.landing.commits.some((c) => c.sha === sha));
    const util = of(history.shas.util);
    expect(util?.revertedBy).toEqual([history.shas.revertUtil]);
    expect(new Set(util?.lines.map((line) => line.by))).toEqual(new Set([history.shas.revertUtil]));
    const page = of(history.shas.page);
    expect(page?.revertedBy).toEqual([]);
    expect(new Set(page?.lines.map((line) => `${line.fate} ${line.by}`))).toEqual(
      new Set([`reverted ${history.shas.dropPage}`]),
    );
    const handlers = of(history.shas.handlers);
    expect(
      handlers?.lines.filter((line) => line.fate === "reworked").map((line) => line.by),
    ).toEqual([history.shas.fix, history.shas.fix, history.shas.fix]);
    expect(of(history.shas.lateDocs)?.open).toBe(true);
    expect(of(history.shas.handlers)?.open).toBe(false);
  });

  it("gives the same report for the same history", async () => {
    const again = await readProvenance(history.repo.dir, {
      since: SINCE,
      until: UNTIL,
      repo: "acme/api",
      runs: history.runs,
      pulls: [{ number: 11, agent: { vendor: "copilot" } }],
    });
    expect(again).toEqual(report);
  });

  it("only counts changes up to `until`: before the fix-forward, nothing is rework yet", async () => {
    const early = await readProvenance(history.repo.dir, {
      since: SINCE,
      until: new Date("2026-10-03T00:00:00Z"),
    });
    expect(early.by_agent.find((row) => row.vendor === "claude_code")).toMatchObject({
      lines: 20,
      reworked_lines: 0,
      open_lines: 20,
    });
  });
});
