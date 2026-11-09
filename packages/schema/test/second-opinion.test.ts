import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA,
  type LedgerEvent,
  latestSecondOpinions,
  overallSecondOpinion,
  type SecondOpinion,
  secondOpinionOf,
  validateEvent,
  validateReviewItem,
} from "../src/index.js";

const event = (data: Record<string, unknown>, ts = "2026-11-09T10:00:00.000Z"): LedgerEvent => ({
  id: "019a6800-0000-7000-8000-000000000001",
  schema: EVENT_SCHEMA,
  ts,
  source: "github",
  kind: "review.submitted",
  actor: { kind: "system", id: "coderabbitai[bot]", name: "CodeRabbit" },
  target: { type: "pr", value: "https://github.com/acme/api/pull/7" },
  links: { pr_url: "https://github.com/acme/api/pull/7" },
  data,
});

const opinion = (fields: Partial<SecondOpinion>): SecondOpinion => ({
  tool: "coderabbit",
  reviewer: "coderabbitai[bot]",
  verdict: "comment",
  at: "2026-11-09T10:00:00.000Z",
  event_id: "019a6800-0000-7000-8000-000000000001",
  ...fields,
});

describe("second opinions", () => {
  it("reads a review.submitted event, and nothing from a malformed one", () => {
    const valid = event({
      second_opinion: {
        tool: "coderabbit",
        reviewer: "coderabbitai[bot]",
        verdict: "changes",
        findings: 2,
      },
    });
    expect(validateEvent(valid).ok).toBe(true);
    expect(secondOpinionOf(valid)).toEqual({
      tool: "coderabbit",
      reviewer: "coderabbitai[bot]",
      verdict: "changes",
      findings: 2,
      at: "2026-11-09T10:00:00.000Z",
      event_id: valid.id,
    });
    expect(secondOpinionOf(event({ second_opinion: { tool: "codex", verdict: "changes" } }))).toBe(
      undefined,
    );
    expect(secondOpinionOf({ ...valid, kind: "pr.opened" })).toBeUndefined();
  });

  it("keeps the newest per tool and takes the strictest verdict overall", () => {
    const opinions = [
      opinion({ verdict: "changes", at: "2026-11-09T09:00:00.000Z" }),
      opinion({ verdict: "approve", at: "2026-11-09T11:00:00.000Z" }),
      opinion({ tool: "pr-agent", reviewer: "github-actions[bot]", verdict: "failed" }),
    ];
    expect(latestSecondOpinions(opinions).map((o) => [o.tool, o.verdict])).toEqual([
      ["pr-agent", "failed"],
      ["coderabbit", "approve"],
    ]);
    expect(overallSecondOpinion(opinions)).toEqual({
      verdict: "failed",
      tool: "pr-agent",
      summary: "PR-Agent failed to run; CodeRabbit approved",
    });
    expect(overallSecondOpinion([opinion({ verdict: "approve", findings: 0 })])?.verdict).toBe(
      "approve",
    );
    expect(overallSecondOpinion([])).toBeUndefined();
  });

  it("validates on a review item", () => {
    const item = {
      id: "019a6800-0000-7000-8000-000000000002",
      schema: "selfhost.review_item/v1",
      kind: "pr",
      title: "Add rate limits",
      created_at: "2026-11-09T10:00:00.000Z",
      updated_at: "2026-11-09T10:00:00.000Z",
      state: "open",
      blocking: false,
      risk: { score: 70, reasons: [] },
      owners: [],
      source_event_ids: [],
      second_opinion: {
        verdict: "changes",
        tool: "coderabbit",
        summary: "CodeRabbit requested changes",
      },
      second_opinions: [opinion({ verdict: "changes" })],
    };
    expect(validateReviewItem(item).ok).toBe(true);
    expect(validateReviewItem({ ...item, second_opinion: { verdict: "maybe" } }).ok).toBe(false);
  });
});
