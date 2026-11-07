import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CreateDecisionRequestSchema, createValidator } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import {
  githubDecision,
  type IssueCommentWebhook,
  type PullRequestReviewWebhook,
  webhookPullAgent,
} from "../src/index.js";
import { GITHUB_FIXTURES } from "./helpers.js";

const webhook = <T>(name: string): T =>
  JSON.parse(readFileSync(join(GITHUB_FIXTURES, "webhooks", `${name}.json`), "utf8")) as T;

const approved = () => webhook<PullRequestReviewWebhook>("pull_request_review.approved");
const changes = () => webhook<PullRequestReviewWebhook>("pull_request_review.changes_requested");
const comment = () => webhook<IssueCommentWebhook>("issue_comment.created");

const valid = createValidator(CreateDecisionRequestSchema);

describe("githubDecision", () => {
  it("maps an approving review on an agent pull request to approve with the review as reason", () => {
    const decision = githubDecision("pull_request_review", approved());
    expect(decision).toEqual({
      verdict: "approve",
      by: "bob",
      reason: "Looks good. The bucket size matches what we agreed for the free plan.",
      question: "#101 Add per-key rate limiting",
      repo: "acme/acme-api",
      pr_url: "https://github.com/acme/acme-api/pull/101",
      commit_sha: "5786c5c9d81ca4218b7e44bf0007f5580f66c489",
      surface: "github_review",
      key: "pull_request_review:9101",
      ts: "2026-10-05T14:00:00.000Z",
    });
    expect(valid.validate(decision).ok).toBe(true);
  });

  it("maps changes requested to deny and a commented review to answer", () => {
    expect(githubDecision("pull_request_review", changes())).toMatchObject({
      verdict: "deny",
      reason: "This drops env overrides. Keep SELFHOST_CONFIG working before the refactor lands.",
      question: "#103 Refactor config loading",
      key: "pull_request_review:9104",
    });
    const commented = approved();
    commented.review.state = "commented";
    expect(githubDecision("pull_request_review", commented)?.verdict).toBe("answer");
  });

  it("maps a conversation comment on an agent pull request to answer", () => {
    const decision = githubDecision("issue_comment", comment());
    expect(decision).toEqual({
      verdict: "answer",
      by: "carol",
      reason:
        "Answering the agent's question: use a per-key bucket, not per-IP. Mobile clients share IPs.",
      question: "#101 Add per-key rate limiting",
      repo: "acme/acme-api",
      pr_url: "https://github.com/acme/acme-api/pull/101",
      surface: "github_comment",
      key: "issue_comment:7101",
      ts: "2026-10-05T12:30:00.000Z",
    });
    expect(valid.validate(decision).ok).toBe(true);
  });

  it("names the person through the login map when one is given", () => {
    const person = (login: string) => (login === "bob" ? "bob@example.com" : undefined);
    expect(githubDecision("pull_request_review", approved(), { person })?.by).toBe(
      "bob@example.com",
    );
    expect(githubDecision("issue_comment", comment(), { person })?.by).toBe("carol");
  });

  it("gives nothing for pull requests no agent opened", () => {
    const human = approved();
    human.pull_request.body = "Redirect back to the page the user came from.";
    human.pull_request.head.ref = "fix/login-redirect";
    expect(webhookPullAgent(human.pull_request)).toBeUndefined();
    expect(githubDecision("pull_request_review", human)).toBeUndefined();

    const onHuman = comment();
    onHuman.issue.body = "Plain change.";
    expect(githubDecision("issue_comment", onHuman)).toBeUndefined();
  });

  it("gives nothing for bots, other actions, empty comment reviews and plain issues", () => {
    const bot = approved();
    bot.review.user = { login: "cursor[bot]", type: "Bot" };
    expect(githubDecision("pull_request_review", bot)).toBeUndefined();

    const dismissed = approved();
    dismissed.action = "dismissed";
    expect(githubDecision("pull_request_review", dismissed)).toBeUndefined();

    const empty = approved();
    empty.review.state = "commented";
    empty.review.body = "  ";
    expect(githubDecision("pull_request_review", empty)).toBeUndefined();

    const edited = comment();
    edited.action = "edited";
    expect(githubDecision("issue_comment", edited)).toBeUndefined();

    const issue = comment();
    issue.issue.pull_request = undefined;
    expect(githubDecision("issue_comment", issue)).toBeUndefined();

    expect(githubDecision("push", approved())).toBeUndefined();
  });

  it("finds the agent from the author account when the body says nothing", () => {
    const copilot = comment();
    copilot.issue.body = "";
    copilot.issue.user = { login: "copilot-swe-agent[bot]", type: "Bot" };
    expect(githubDecision("issue_comment", copilot)?.verdict).toBe("answer");
  });

  it("throws on a payload that is not the event's shape", () => {
    expect(() => githubDecision("pull_request_review", { action: "submitted" })).toThrow(
      "Unexpected pull_request_review payload",
    );
    expect(() => githubDecision("issue_comment", null)).toThrow(/issue_comment payload/);
  });
});
