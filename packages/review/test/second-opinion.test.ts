import type { LedgerEvent, SecondOpinionData } from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  openReviewList,
  opinionFloor,
  refreshReviewList,
  SECOND_OPINION_REASON,
  withSecondOpinionRisk,
} from "../src/index.js";
import { at, BACKENDS, config, event } from "./helpers.js";

const NOW = "2026-11-09T12:00:00.000Z";
const PR_URL = "https://github.com/acme/api/pull/42";

const pullRequest = (ts: string, risk: number) =>
  event({
    kind: "pr.opened",
    ts,
    source: "github",
    actor: { kind: "agent", id: "github:claude[bot]" },
    repo: "acme/api",
    agent: { vendor: "claude_code" },
    target: { type: "pr", value: PR_URL },
    links: { pr_url: PR_URL },
    data: {
      number: 42,
      title: "Add rate limits",
      risk: { score: risk, reasons: ["Small change"] },
    },
  });

/** review.submitted as the GitHub App writes it. */
const review = (ts: string, opinion: Omit<SecondOpinionData, "reviewer"> & { reviewer?: string }) =>
  event({
    kind: "review.submitted",
    ts,
    source: "github",
    actor: { kind: "system", id: opinion.reviewer ?? "coderabbitai[bot]" },
    repo: "acme/api",
    agent: { vendor: "claude_code" },
    target: { type: "pr", value: PR_URL },
    links: { pr_url: PR_URL },
    data: { second_opinion: { reviewer: "coderabbitai[bot]", ...opinion } },
  });

describe("risk floors", () => {
  const policy = config();
  const opinion = (fields: Partial<SecondOpinionData>) => ({
    tool: "coderabbit" as const,
    reviewer: "coderabbitai[bot]",
    verdict: "comment" as const,
    at: NOW,
    event_id: "0196a000-0000-7000-8000-000000000000",
    ...fields,
  });

  it("holds the high threshold for changes over a severe finding, the medium band otherwise", () => {
    expect(opinionFloor(opinion({ verdict: "changes", severity: "critical" }), policy)).toBe(70);
    expect(opinionFloor(opinion({ verdict: "changes" }), policy)).toBe(35);
    expect(
      opinionFloor(opinion({ verdict: "comment", findings: 2, severity: "high" }), policy),
    ).toBe(35);
    expect(
      opinionFloor(opinion({ verdict: "comment", findings: 2, severity: "low" }), policy),
    ).toBe(0);
    expect(opinionFloor(opinion({ verdict: "approve" }), policy)).toBe(0);
    expect(opinionFloor(opinion({ verdict: "failed" }), policy)).toBe(0);
  });

  it("replaces earlier second-opinion reasons and never lowers the score", () => {
    const raised = withSecondOpinionRisk(
      { score: 20, reasons: ["Small change"] },
      [opinion({ verdict: "changes", findings: 3, severity: "critical" })],
      policy,
    );
    expect(raised).toEqual({
      score: 70,
      reasons: [
        "Small change",
        `${SECOND_OPINION_REASON}CodeRabbit requested changes: 3 findings, highest critical`,
      ],
    });
    expect(withSecondOpinionRisk(raised, [opinion({ verdict: "approve" })], policy)).toEqual({
      score: 70,
      reasons: ["Small change"],
    });
  });
});

describe.each(BACKENDS)("second opinions on the review list on $name", (backend) => {
  const opened: { close(): Promise<void> }[] = [];
  afterEach(async () => {
    for (const store of opened.splice(0)) await store.close();
  });

  async function setup() {
    const store = await backend.open();
    opened.push(store);
    const list = openReviewList(store.ledger, { config: config(), now: () => new Date(NOW) });
    return {
      list,
      refresh: () => refreshReviewList(store.ledger, list),
      append: (...events: LedgerEvent[]) => store.ledger.append(events),
    };
  }

  it.skipIf(backend.skip)("attaches the newest verdict per tool and raises the risk", async () => {
    const { list, refresh, append } = await setup();
    const opened = pullRequest(at(NOW, -60), 20);
    await append(opened);
    await refresh();
    const first = review(at(NOW, -50), {
      tool: "coderabbit",
      verdict: "comment",
      findings: 1,
      severity: "low",
    });
    const second = review(at(NOW, -40), {
      tool: "coderabbit",
      verdict: "changes",
      findings: 3,
      severity: "critical",
      url: `${PR_URL}#pullrequestreview-1`,
    });
    const prAgent = review(at(NOW, -45), {
      tool: "pr-agent",
      reviewer: "github-actions[bot]",
      verdict: "approve",
      findings: 0,
    });
    await append(first, second, prAgent);
    expect(await refresh()).toMatchObject({ created: 0, updated: 3 });
    const item = await list.pullRequest(PR_URL);
    expect(item?.second_opinions?.map((o) => [o.tool, o.verdict, o.event_id])).toEqual([
      ["pr-agent", "approve", prAgent.id],
      ["coderabbit", "changes", second.id],
    ]);
    expect(item?.risk.score).toBe(70);
    // The strictest verdict is the item's overall second opinion, as approval routing reads it.
    expect(item?.second_opinion).toEqual({
      verdict: "changes",
      tool: "coderabbit",
      summary:
        "PR-Agent approved: 0 findings; CodeRabbit requested changes: 3 findings, highest critical",
    });
    expect(item?.risk.reasons).toContain(
      `${SECOND_OPINION_REASON}CodeRabbit requested changes: 3 findings, highest critical`,
    );
    expect(item?.delivery).toBe("instant");
    expect(item?.source_event_ids).toEqual(expect.arrayContaining([opened.id, second.id]));

    // A later pr.opened with a new score keeps the second opinion's floor.
    await append(pullRequest(at(NOW, -30), 10));
    await refresh();
    expect((await list.pullRequest(PR_URL))?.risk.score).toBe(70);
  });

  it.skipIf(backend.skip)(
    "picks up verdicts that reached the ledger before the pr item",
    async () => {
      const { list, refresh, append } = await setup();
      await append(
        review(at(NOW, -50), {
          tool: "pr-agent",
          reviewer: "github-actions[bot]",
          verdict: "changes",
          findings: 2,
        }),
      );
      await refresh();
      expect(await list.pullRequest(PR_URL)).toBeUndefined();
      await append(pullRequest(at(NOW, -40), 10));
      await refresh();
      const item = await list.pullRequest(PR_URL);
      expect(item?.second_opinions?.map((o) => o.verdict)).toEqual(["changes"]);
      expect(item?.risk.score).toBe(35);
    },
  );

  it.skipIf(backend.skip)("leaves an answered item alone", async () => {
    const { list, refresh, append } = await setup();
    await append(pullRequest(at(NOW, -60), 20));
    await refresh();
    const item = await list.pullRequest(PR_URL);
    await list.decide(item?.id ?? "", { verdict: "approve", by: "bob@example.com" });
    await append(
      review(at(NOW, -10), { tool: "coderabbit", verdict: "changes", severity: "high" }),
    );
    await refresh();
    const after = await list.pullRequest(PR_URL);
    expect(after?.state).toBe("answered");
    expect(after?.second_opinions).toBeUndefined();
  });
});
