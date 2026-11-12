import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  BRIEF_MARKER,
  coderabbitSeverity,
  markerOpinion,
  prAgentOpinion,
  REVIEWER_FILES,
  REVIEWER_PINS,
  type ReviewerDelivery,
  ReviewerSetupError,
  type ReviewerSetupOptions,
  reviewerDelivery,
  reviewerSetup,
} from "../src/index.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures", "github", "webhooks");
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, "reviewers", `${name}.json`), "utf8"));

const OPTIONS: ReviewerSetupOptions = {
  agentCondition: (labelEvents) =>
    `github.event.pull_request.draft == false && (\nstartsWith(x, 'claude/')${labelEvents ? " ||\nlabeled" : ""}\n)`,
  agentLabels: ["selfhost:agent-claude-code", "selfhost:agent-codex"],
  agentBots: ["claude[bot]", "copilot-swe-agent[bot]"],
};

const only = (setup: ReturnType<typeof reviewerSetup>) => {
  expect(setup.files).toHaveLength(1);
  return setup.files[0]?.text ?? "";
};

const delivered = (event: string, name: string): ReviewerDelivery => {
  const parsed = reviewerDelivery(event, fixture(name));
  if ("skip" in parsed) throw new Error(`skipped: ${parsed.skip}`);
  return parsed.delivery;
};

describe("reviewer setup", () => {
  it("pr-agent: a pinned workflow on the org's OpenAI key, for agent pull requests", () => {
    const setup = reviewerSetup("pr-agent", OPTIONS);
    const text = only(setup);
    expect(setup.files[0]?.path).toBe(".github/workflows/selfhost-pr-agent.yml");
    const pin = REVIEWER_PINS.prAgent;
    expect(text).toContain(`uses: docker://${pin.image}:${pin.tag}@${pin.digest} # v0.49.0`);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, kept as written.
    expect(text).toContain("OPENAI_KEY: ${{ secrets.OPENAI_KEY }}");
    expect(text).toContain("startsWith(x, 'claude/')");
    expect(text).toContain(BRIEF_MARKER);
    expect(text).toContain("pr_reviewer.require_merge_recommendation");
    expect(text).toContain("Do not comment on style");
    expect(text).not.toContain("config.model");
    expect(setup.secrets).toEqual([
      { name: "OPENAI_KEY", holds: expect.stringContaining("OpenAI") },
    ]);
    expect(setup.next[0]).toContain("gh secret set OPENAI_KEY");

    const workflow = parseYaml(text);
    expect(workflow.on.pull_request.types).toContain("labeled");
    const job = workflow.jobs.review;
    expect(job.name).toBe("PR-Agent review");
    // The folded condition joins into one expression.
    expect(job.if).toBe(
      "github.event.pull_request.draft == false && ( startsWith(x, 'claude/') || labeled )",
    );
    expect(job.steps[1].env["github_action_config.pr_actions"]).toBe(
      '["opened", "reopened", "ready_for_review", "labeled"]',
    );
  });

  it("pr-agent: an anthropic/ model reads ANTHROPIC.KEY from the named secret", () => {
    const setup = reviewerSetup("pr-agent", {
      ...OPTIONS,
      settings: { model: "anthropic/claude-sonnet-4-5", api_key_env: "ORG_ANTHROPIC_KEY" },
    });
    const step = parseYaml(only(setup)).jobs.review.steps[1];
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, kept as written.
    expect(step.env["ANTHROPIC.KEY"]).toBe("${{ secrets.ORG_ANTHROPIC_KEY }}");
    expect(step.env["config.model"]).toBe("anthropic/claude-sonnet-4-5");
    expect(step.env["config.fallback_models"]).toBe("[]");
    expect(setup.secrets.map((secret) => secret.name)).toEqual(["ORG_ANTHROPIC_KEY"]);
  });

  it("claude-code-action: pinned to commits, API key only, reports with the marker line", () => {
    const setup = reviewerSetup("claude-code-action", {
      ...OPTIONS,
      settings: { model: "claude-sonnet-4-5" },
    });
    const text = only(setup);
    const { claudeCodeAction, checkout } = REVIEWER_PINS;
    expect(text).toContain(`uses: ${claudeCodeAction.uses}@${claudeCodeAction.sha} # v1.0.259`);
    expect(text).toContain(`uses: ${checkout.uses}@${checkout.sha} # v7.0.1`);
    const workflow = parseYaml(text);
    const step = workflow.jobs.review.steps[1];
    expect(workflow.jobs.review.name).toBe("Claude Code review");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, kept as written.
    expect(step.with.anthropic_api_key).toBe("${{ secrets.ANTHROPIC_API_KEY }}");
    expect(step.with.claude_code_oauth_token).toBeUndefined();
    expect(step.with.allowed_bots).toBe("claude[bot],copilot-swe-agent[bot]");
    // Without the App's bot login the labeled event would be refused, so it is left out.
    expect(workflow.on.pull_request.types).not.toContain("labeled");
    expect(workflow.jobs.review.if).not.toContain("labeled");
    expect(setup.next.join("\n")).toContain("--app-bot");
    const withApp = parseYaml(
      only(reviewerSetup("claude-code-action", { ...OPTIONS, appBot: "acme-selfhost[bot]" })),
    );
    expect(withApp.on.pull_request.types).toContain("labeled");
    expect(withApp.jobs.review.if).toContain("labeled");
    expect(withApp.jobs.review.steps[1].with.allowed_bots).toBe(
      "claude[bot],copilot-swe-agent[bot],acme-selfhost[bot]",
    );
    expect(step.with.claude_args).toContain("--model claude-sonnet-4-5");
    expect(step.with.prompt).toContain(
      "<!-- selfhost:second-opinion tool=claude-code-action verdict=VERDICT findings=N severity=SEVERITY -->",
    );
    expect(step.with.prompt).toContain("say so at the top of your review");
    expect(setup.secrets.map((secret) => secret.name)).toEqual(["ANTHROPIC_API_KEY"]);
  });

  // The App labels a pull request seconds after it opens. With one concurrency group per pull
  // request, the labeled run (skipped by its if) still cancelled the review the opening started.
  it("never lets a label event cancel the review a push started", () => {
    const withApp = { ...OPTIONS, appBot: "acme-selfhost[bot]" };
    for (const tool of ["pr-agent", "claude-code-action"] as const) {
      const workflow = parseYaml(only(reviewerSetup(tool, withApp)));
      const group: string = workflow.concurrency.group;
      expect(group).toContain(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, kept as written.
        "${{ github.event.pull_request.number }}-${{ github.event.action == 'labeled' && format('label-{0}', github.event.label.name) || 'change' }}",
      );
      expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
      // Without label events in the trigger, one group per pull request is enough.
      const plain = parseYaml(
        only(reviewerSetup(tool, { ...withApp, settings: { pull_requests: "all" } })),
      );
      expect(plain.concurrency.group).not.toContain("labeled");
    }
  });

  it("refuses a secret that holds one person's subscription login", () => {
    for (const tool of ["claude-code-action", "pr-agent"] as const) {
      expect(() =>
        reviewerSetup(tool, { ...OPTIONS, settings: { api_key_env: "CLAUDE_CODE_OAUTH_TOKEN" } }),
      ).toThrow(ReviewerSetupError);
    }
    expect(() =>
      reviewerSetup("claude-code-action", {
        ...OPTIONS,
        settings: { api_key_env: "CLAUDE_CODE_OAUTH_TOKEN" },
      }),
    ).toThrow(/personal subscription login.*org's API key/);
  });

  it("refuses a model that is not a model id, since it lands in a workflow", () => {
    expect(() =>
      reviewerSetup("claude-code-action", { ...OPTIONS, settings: { model: "x\n  run: curl" } }),
    ).toThrow(/not a model id/);
  });

  it("coderabbit: .coderabbit.yaml filtered to agent labels, no auto approvals, no key", () => {
    const setup = reviewerSetup("coderabbit", OPTIONS);
    const config = parseYaml(only(setup));
    expect(setup.files[0]?.path).toBe(".coderabbit.yaml");
    expect(config.reviews.profile).toBe("chill");
    expect(config.reviews.auto_approvals).toEqual({ enabled: false });
    expect(config.reviews.auto_review.labels).toEqual(OPTIONS.agentLabels);
    expect(config.reviews.path_instructions[0].instructions).toContain("try to break it");
    expect(setup.secrets).toEqual([]);
    expect(setup.next.join("\n")).toContain("https://github.com/apps/coderabbitai");
  });

  it("pull_requests = all and style = true widen the review", () => {
    const settings = { pull_requests: "all" as const, style: true };
    for (const tool of ["pr-agent", "claude-code-action"] as const) {
      const workflow = parseYaml(only(reviewerSetup(tool, { ...OPTIONS, settings })));
      expect(workflow.jobs.review.if).toBe("github.event.pull_request.draft == false");
      expect(workflow.on.pull_request.types).not.toContain("labeled");
    }
    const coderabbit = parseYaml(only(reviewerSetup("coderabbit", { ...OPTIONS, settings })));
    expect(coderabbit.reviews.profile).toBe("assertive");
    expect(coderabbit.reviews.auto_review.labels).toBeUndefined();
    expect(coderabbit.reviews.path_instructions[0].instructions).toContain(
      "Style, formatting and naming comments are welcome",
    );
  });

  it("names a file per tool", () => {
    expect(Object.keys(REVIEWER_FILES).sort()).toEqual(
      ["claude-code-action", "coderabbit", "pr-agent"].sort(),
    );
  });
});

describe("reviewer verdicts from webhooks", () => {
  it("PR-Agent: merge recommendation, focus areas plus a security concern, risk level", () => {
    const delivery = delivered("issue_comment", "issue_comment.created.pr-agent");
    expect(delivery).toMatchObject({
      opinion: {
        tool: "pr-agent",
        reviewer: "github-actions[bot]",
        verdict: "changes",
        findings: 3,
        severity: "high",
        url: "https://github.com/acme/acme-api/pull/101#issuecomment-9311",
      },
      key: "issue_comment:9311:2026-10-05T09:04:00.000Z",
      repo: "acme/acme-api",
      number: 101,
      url: "https://github.com/acme/acme-api/pull/101",
      installation: 61000001,
    });
    expect(delivery.pull).toBeUndefined();
  });

  it("PR-Agent: the edited comment of a later clean review is a new verdict", () => {
    const delivery = delivered("issue_comment", "issue_comment.edited.pr-agent-clean");
    expect(delivery.opinion).toMatchObject({ tool: "pr-agent", verdict: "approve", findings: 0 });
    expect(delivery.opinion.severity).toBeUndefined();
    expect(delivery.key).toBe("issue_comment:9311:2026-10-05T11:10:00.000Z");
  });

  it("PR-Agent: the placeholder before a review is not a verdict", () => {
    const parsed = reviewerDelivery(
      "issue_comment",
      fixture("issue_comment.created.pr-agent-preparing"),
    );
    expect(parsed).toEqual({
      skip: "a comment by github-actions[bot] is not a reviewer's verdict",
    });
  });

  it("Claude Code action: the marker line it is told to end with", () => {
    const delivery = delivered("issue_comment", "issue_comment.created.claude-code-action");
    expect(delivery.opinion).toEqual({
      tool: "claude-code-action",
      reviewer: "github-actions[bot]",
      verdict: "changes",
      findings: 2,
      severity: "high",
      url: "https://github.com/acme/acme-api/pull/101#issuecomment-9321",
    });
  });

  it("CodeRabbit: the review state, actionable and outside-diff findings, nitpicks left out", () => {
    const delivery = delivered("pull_request_review", "pull_request_review.submitted.coderabbit");
    expect(delivery.opinion).toEqual({
      tool: "coderabbit",
      reviewer: "coderabbitai[bot]",
      verdict: "comment",
      findings: 3,
      severity: "high",
      url: "https://github.com/acme/acme-api/pull/101#pullrequestreview-9301",
      head_sha: "5786c5c9d81ca4218b7e44bf0007f5580f66c489",
    });
    expect(delivery.coderabbitReview).toBe(9301);
    expect(delivery.pull?.head.ref).toBe("claude/add-rate-limit");
    const inline = fixture("coderabbit-review-comments") as { body: string }[];
    expect(coderabbitSeverity(inline.map((comment) => comment.body))).toBe("critical");
  });

  it("CodeRabbit: an approval has no findings", () => {
    const delivery = delivered(
      "pull_request_review",
      "pull_request_review.submitted.coderabbit-approved",
    );
    expect(delivery.opinion).toMatchObject({ verdict: "approve", findings: 0 });
  });

  it("a failed reviewer job is a failed opinion; other check runs are not", () => {
    const delivery = delivered("check_run", "check_run.completed.claude-code-action-failure");
    expect(delivery).toMatchObject({
      opinion: { tool: "claude-code-action", verdict: "failed" },
      key: "check_run:9331",
      number: 101,
    });
    expect(reviewerDelivery("check_run", fixture("check_run.completed.selfhost-review"))).toEqual({
      skip: "the check run is not a workflow job",
    });
    const passed = fixture("check_run.completed.claude-code-action-failure");
    passed.check_run.conclusion = "success";
    expect(reviewerDelivery("check_run", passed)).toEqual({
      skip: "Claude Code review success: its review carries the verdict",
    });
  });

  it("people never give a second opinion, even with the marker line", () => {
    const human = fixture("issue_comment.created.claude-code-action");
    human.comment.user = { login: "carol", type: "User" };
    expect(reviewerDelivery("issue_comment", human)).toEqual({
      skip: "the comment is not from a reviewer bot",
    });
    const review = fixture("pull_request_review.submitted.coderabbit");
    review.review.user = { login: "bob", type: "User" };
    expect(reviewerDelivery("pull_request_review", review)).toEqual({
      skip: "the review is not from a reviewer bot",
    });
  });

  it("other bots and other events carry nothing", () => {
    const bot = fixture("pull_request_review.submitted.coderabbit");
    bot.review.user = { login: "cursor[bot]", type: "Bot" };
    expect(reviewerDelivery("pull_request_review", bot)).toEqual({
      skip: "a review by cursor[bot] is not a reviewer's verdict",
    });
    expect(reviewerDelivery("push", {})).toEqual({ skip: "push events carry no reviewer verdict" });
    expect(reviewerDelivery("issue_comment", null)).toEqual({
      skip: "unexpected issue_comment payload",
    });
  });

  it("the marker line: last one wins, unknown values are no line", () => {
    expect(
      markerOpinion(
        "<!-- selfhost:second-opinion tool=pr-agent verdict=comment -->\n<!-- selfhost:second-opinion verdict=APPROVE tool=claude-code-action findings=0 severity=none -->",
      ),
    ).toEqual({ tool: "claude-code-action", verdict: "approve", findings: 0 });
    expect(markerOpinion("<!-- selfhost:second-opinion tool=codex verdict=approve -->")).toBe(
      undefined,
    );
    expect(markerOpinion("<!-- selfhost:second-opinion tool=pr-agent verdict=maybe -->")).toBe(
      undefined,
    );
  });

  it("PR-Agent without GFM: headings instead of a table", () => {
    const body = [
      "## PR Reviewer Guide 🔍",
      "",
      "### ⚡ Recommended focus areas for review",
      "",
      "#### ",
      "**Possible Issue**",
      "",
      "Off by one in the loop.",
      "",
      "[**Missed case**](https://github.com/acme/acme-api/pull/101/files#diff-1)",
      "",
      "Empty input.",
      "",
      "### 🔒 No security concerns identified",
      "",
    ].join("\n");
    expect(prAgentOpinion(body)).toEqual({ verdict: "comment", findings: 2 });
  });
});
