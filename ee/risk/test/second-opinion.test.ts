import { describe, expect, it } from "vitest";
import { type RiskInputs, riskCheck, scoreRisk, WEIGHTS } from "../src/index.js";
import { config } from "./helpers.js";

const policy = config("version = 1\n");
const HEAD = "5786c5c9d81ca4218b7e44bf0007f5580f66c489";
const small: RiskInputs = {
  files: [{ path: "src/limits/bucket.ts", additions: 20, deletions: 4 }],
  headSha: HEAD,
};

describe("second opinion as a risk input", () => {
  it("is not an input, and not missing, for a team with no reviewer", () => {
    const result = scoreRisk(small, policy);
    expect(result.factors.map((f) => f.input)).not.toContain("second_opinion");
    expect(result.missing.map((m) => m.input)).not.toContain("second_opinion");
  });

  it("is missing until the configured reviewer has reviewed", () => {
    const result = scoreRisk({ ...small, secondOpinions: [] }, policy);
    expect(result.missing).toContainEqual({
      input: "second_opinion",
      reason: "no review from [integrations.reviewer] on this pull request yet",
    });
  });

  it("adds points for a request for changes, more for a severe finding, capped", () => {
    const changes = scoreRisk(
      {
        ...small,
        secondOpinions: [
          {
            tool: "coderabbit",
            verdict: "changes",
            findings: 3,
            severity: "critical",
            head_sha: HEAD,
          },
        ],
      },
      policy,
    );
    const factor = changes.factors.find((f) => f.input === "second_opinion");
    expect(factor).toMatchObject({
      points: WEIGHTS.secondOpinionChanges + WEIGHTS.secondOpinionSevere,
      forcesHigh: false,
      detail: "CodeRabbit requested changes: 3 findings, highest critical",
    });
    expect(changes.reasons).toContain(factor?.detail);
    expect(changes.score).toBe(scoreRisk(small, policy).score + 25);

    const both = scoreRisk(
      {
        ...small,
        secondOpinions: [
          { tool: "pr-agent", verdict: "changes", severity: "high" },
          { tool: "claude-code-action", verdict: "comment", findings: 1 },
        ],
      },
      policy,
    );
    expect(both.factors.find((f) => f.input === "second_opinion")?.points).toBe(
      WEIGHTS.secondOpinionMax,
    );
  });

  it("an approval or a clean comment adds nothing, and never lowers the score", () => {
    const result = scoreRisk(
      {
        ...small,
        secondOpinions: [
          { tool: "pr-agent", verdict: "approve", findings: 0 },
          { tool: "coderabbit", verdict: "comment", findings: 0 },
        ],
      },
      policy,
    );
    expect(result.factors.find((f) => f.input === "second_opinion")?.points).toBe(0);
    expect(result.score).toBe(scoreRisk(small, policy).score);
  });

  it("notes a review of an earlier commit, and names a failed run as missing", () => {
    const earlier = scoreRisk(
      {
        ...small,
        secondOpinions: [
          { tool: "pr-agent", verdict: "comment", findings: 2, head_sha: "b2e4f6a" },
        ],
      },
      policy,
    );
    expect(earlier.factors.find((f) => f.input === "second_opinion")?.detail).toBe(
      "PR-Agent commented: 2 findings (on earlier commit b2e4f6a)",
    );
    const failed = scoreRisk(
      { ...small, secondOpinions: [{ tool: "claude-code-action", verdict: "failed" }] },
      policy,
    );
    expect(failed.missing).toContainEqual({
      input: "second_opinion",
      reason: "Claude Code failed to run",
    });
    expect(riskCheck(failed, policy).text).toContain("- Second opinion: Claude Code failed to run");
  });
});
