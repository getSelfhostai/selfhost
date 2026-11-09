import { describe, expect, it } from "vitest";
import {
  AUTO_APPROVE_MARKER,
  type AutoApproveInputs,
  autoApproveReviewBody,
  autoApproveSummary,
  autoApproveText,
  autoApproveVerdict,
} from "../src/index.js";
import { config } from "./helpers.js";

const ON = `version = 1
[review]
high_risk_paths = ["docs/security/**"]
[review.auto_approve]
enabled = true
`;

/** A docs-only agent pull request that passes every check. */
const clean: AutoApproveInputs = {
  draft: false,
  risk: { level: "low", score: 5 },
  files: ["docs/guide.md", "README.md"],
  checks: [
    { name: "ci / test", state: "passed" },
    { name: "ci / lint", state: "passed" },
  ],
  guardrails: [],
  waits: [],
};

const failed = (inputs: Partial<AutoApproveInputs>, toml = ON) =>
  autoApproveVerdict({ ...clean, ...inputs }, config(toml));

describe("autoApproveVerdict", () => {
  it("approves a low-risk docs change with green checks and a clean run, in dry run by default", () => {
    const verdict = autoApproveVerdict(clean, config(ON));
    expect(verdict.eligible).toBe(true);
    expect(verdict.dryRun).toBe(true);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.reasons).toEqual([
      "Ready for review",
      "No agent waits on a person and no exception is open",
      "Low risk, score 5 (max_risk 20)",
      "2 changed files, all under docs/**, **/*.md",
      "2 checks passed on the head commit",
      "No guardrail or rule hits in the agent's run",
      "No second opinion required",
    ]);
    expect(autoApproveSummary(verdict)).toMatch(
      /^Auto-approve \(dry run\): selfhost would approve/,
    );
  });

  it("approves nothing while [review.auto_approve] is off, the default", () => {
    const verdict = autoApproveVerdict(clean, config("version = 1\n"));
    expect(verdict).toMatchObject({ eligible: false, blockers: [] });
  });

  it("approves for real once dry_run is false", () => {
    const verdict = failed({}, `${ON}dry_run = false\n`);
    expect(verdict).toMatchObject({ eligible: true, dryRun: false });
    expect(autoApproveSummary(verdict)).toBe("Auto-approve: selfhost approved this pull request.");
    expect(autoApproveReviewBody(verdict).startsWith(AUTO_APPROVE_MARKER)).toBe(true);
  });

  it.each<[string, Partial<AutoApproveInputs>, string]>([
    ["a draft", { draft: true }, "The pull request is a draft"],
    [
      "an exception in the run",
      { waits: [{ kind: "exception", title: "Allow once: git push -f", blocking: false }] },
      'Open items that need a person: exception "Allow once: git push -f"',
    ],
    [
      "an agent waiting",
      { waits: [{ kind: "question", title: "Which table?", blocking: true }] },
      'Open items that need a person: question "Which table?"',
    ],
    ["no risk score", { risk: undefined }, "The pull request has no risk score yet"],
    ["medium risk", { risk: { level: "medium", score: 45 } }, "Risk is medium (score 45)"],
    [
      "a score above max_risk",
      { risk: { level: "low", score: 25 } },
      "Risk score 25 is above max_risk 20",
    ],
    ["no files", { files: [] }, "No changed files were read"],
    [
      "a file outside allowed_paths",
      { files: ["docs/a.md", "src/app.ts"] },
      "Files outside allowed_paths: src/app.ts",
    ],
    [
      "a high risk path even inside allowed_paths",
      { files: ["docs/security/keys.md"] },
      "Touches [review] high_risk_paths: docs/security/keys.md",
    ],
    ["checks not read", { checks: undefined }, "The head commit's checks could not be read"],
    ["no checks at all", { checks: [] }, "No checks have reported on the head commit"],
    ["a failed check", { checks: [{ name: "ci / test", state: "failed" }] }, "Failed: ci / test"],
    [
      "a running check",
      { checks: [{ name: "ci / e2e", state: "pending" }] },
      "Still running: ci / e2e",
    ],
    [
      "no recorded run",
      { guardrails: undefined },
      "No agent run was recorded for these commits, so guardrail hits are unknown",
    ],
    [
      "a guardrail hit, even observed",
      {
        guardrails: [
          { rule_id: "guard.secret_read", verdict: "block", mode: "observe", irreversible: false },
        ],
      },
      "Guardrail or rule hits in the run: guard.secret_read",
    ],
  ])("waits for a person on %s", (_name, inputs, blocker) => {
    const verdict = failed(inputs);
    expect(verdict.eligible).toBe(false);
    expect(verdict.blockers).toEqual([blocker]);
    expect(autoApproveSummary(verdict)).toBe(`Auto-approve: a person reviews this. ${blocker}.`);
  });

  it("requires a passing second opinion once the reviewer integration is set", () => {
    const toml = `${ON}[integrations.reviewer]\ntool = "coderabbit"\n`;
    expect(failed({}, toml).blockers).toEqual(["No second opinion from coderabbit yet"]);
    expect(
      failed({ secondOpinion: { verdict: "fail", by: "coderabbit", summary: "2 bugs" } }, toml)
        .blockers,
    ).toEqual(["The second opinion from coderabbit found problems: 2 bugs"]);
    expect(failed({ secondOpinion: { verdict: "pass" } }, toml).eligible).toBe(true);
    expect(
      failed({}, ON.replace("enabled = true", "enabled = true\nrequire_second_opinion = true"))
        .blockers,
    ).toEqual(["No second opinion from the reviewer yet"]);
  });

  it("can skip green checks when a team asks, and lists every check in the text", () => {
    const verdict = failed(
      { checks: undefined },
      ON.replace("enabled = true", "enabled = true\nrequire_green_checks = false"),
    );
    expect(verdict.eligible).toBe(true);
    expect(autoApproveText(verdict).split("\n").slice(0, 5)).toEqual([
      "### Auto-approve (dry run)",
      "",
      "| Check | Result | Found |",
      "| --- | --- | --- |",
      "| ready | passed | Ready for review |",
    ]);
  });

  it("names every blocker when several fail", () => {
    const verdict = failed({ draft: true, risk: { level: "high", score: 92 } });
    expect(verdict.blockers).toEqual(["The pull request is a draft", "Risk is high (score 92)"]);
    expect(autoApproveSummary(verdict)).toBe(
      "Auto-approve: a person reviews this. The pull request is a draft (and 1 more).",
    );
  });
});
