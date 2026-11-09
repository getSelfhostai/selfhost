import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Webhooks } from "@octokit/webhooks";
import { AGENT_LABEL_PREFIX, agentLabels } from "@selfhost/attribution";
import { BRIEF_MARKER } from "@selfhost/brief";
import { agentLabel, createGitHubApp } from "@selfhost/github";
import { FakeGitHub } from "@selfhost/github/testing";
import { BRIEF_MARKER as INTEGRATIONS_BRIEF_MARKER } from "@selfhost/integrations";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  AGENT_VENDORS,
  EVENT_SCHEMA,
  type LedgerEvent,
  parseConfig,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import { GITHUB_WEBHOOK_PATH } from "../src/github.js";
import { ledgerSecondOpinions } from "../src/github-second-opinion.js";
import { startTestServer, type TestServer } from "./helpers.js";

const WEBHOOKS = join(import.meta.dirname, "..", "..", "..", "fixtures", "github", "webhooks");
const REPO = "acme/acme-api";
const HEAD = "5786c5c9d81ca4218b7e44bf0007f5580f66c489";
const BASE = "c3b8739bdcca2b4e2f5bdead2a8f238916813446";
const PR_URL = "https://github.com/acme/acme-api/pull/101";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const APP_ID = "123456";
const SECRET = "test-webhook-secret";
const signer = new Webhooks({ secret: SECRET });

const reviewer = (name: string) =>
  JSON.parse(readFileSync(join(WEBHOOKS, "reviewers", `${name}.json`), "utf8"));

function config(toml: string): ResolvedSelfhostConfig {
  const parsed = parseConfig(toml);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
}

const open: TestServer[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) await server.ledger.close();
});

let deliveries = 0;

async function harness(toml = 'version = 1\n[integrations.reviewer]\ntool = "coderabbit"\n') {
  const github = new FakeGitHub({ appId: APP_ID, publicKey: PUBLIC_KEY });
  const agentPull = {
    author: "alice",
    title: "Add per-key rate limiting",
    body: "Adds a token bucket per API key.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    head: { sha: HEAD, ref: "claude/add-rate-limit" },
    base: { sha: BASE, ref: "main" },
    reviewComments: {
      9301: reviewer("coderabbit-review-comments") as {
        id: number;
        body: string;
        user: { login: string; type: "Bot" };
      }[],
    },
  };
  github.addPull(REPO, 101, agentPull);
  const lines: string[] = [];
  const app = createGitHubApp(
    { appId: APP_ID, privateKey: PRIVATE_KEY, webhookSecret: SECRET },
    { fetch: github.fetch, log: (line) => lines.push(line) },
  );
  const server = await startTestServer({
    app,
    config: async () => config(toml),
    log: (line) => lines.push(line),
  });
  open.push(server);
  return {
    server,
    github,
    lines,
    async deliver(event: string, payload: unknown, id = `delivery-${++deliveries}`) {
      const body = JSON.stringify(payload);
      const res = await server.app.request(GITHUB_WEBHOOK_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": id,
          "x-github-event": event,
          "x-hub-signature-256": await signer.sign(body),
        },
        body,
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    },
    async reviews(): Promise<LedgerEvent[]> {
      return (await server.ledger.query({ kind: "review.submitted" })).events;
    },
  };
}

describe("second opinions from the GitHub App's webhooks", () => {
  it("records CodeRabbit's review once, with the severity of its inline comments, and scores it", async () => {
    const h = await harness();
    const payload = reviewer("pull_request_review.submitted.coderabbit");
    const res = await h.deliver("pull_request_review", payload, "d-cr");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ delivery: "d-cr", handled: true });

    const [event] = await h.reviews();
    expect(event).toMatchObject({
      schema: EVENT_SCHEMA,
      kind: "review.submitted",
      source: "github",
      actor: { kind: "system", id: "coderabbitai[bot]", name: "CodeRabbit" },
      repo: REPO,
      agent: { vendor: "claude_code" },
      target: { type: "pr", value: PR_URL },
      links: { pr_url: PR_URL, commit_sha: HEAD },
      data: {
        second_opinion: {
          tool: "coderabbit",
          verdict: "comment",
          findings: 3,
          severity: "critical",
          url: `${PR_URL}#pullrequestreview-9301`,
        },
      },
    });

    // The pull request is synced again, and its risk check counts the second opinion.
    const [run] = h.github.checkRuns;
    expect(run?.output.text).toContain(
      "| Second opinion | 15 | CodeRabbit commented: 3 findings, highest critical |",
    );
    expect(h.lines.join("\n")).toContain("acme/acme-api#101: coderabbit comment");

    // The same delivery again changes nothing; GitHub's redelivery under a new id stores nothing new.
    expect((await h.deliver("pull_request_review", payload, "d-cr")).json).toEqual({
      delivery: "d-cr",
      handled: false,
      duplicate: true,
    });
    const writes = h.github.writes.length;
    await h.deliver("pull_request_review", payload, "d-cr-again");
    expect(await h.reviews()).toHaveLength(1);
    expect(h.github.writes).toHaveLength(writes);
  });

  it("reads PR-Agent and the Claude Code action from comments, the newest per tool winning", async () => {
    const h = await harness();
    expect(
      (await h.deliver("issue_comment", reviewer("issue_comment.created.pr-agent"))).json,
    ).toMatchObject({ handled: true });
    await h.deliver("issue_comment", reviewer("issue_comment.created.claude-code-action"));
    await h.deliver("issue_comment", reviewer("issue_comment.edited.pr-agent-clean"));
    // The pull request was read through the App, since comment payloads do not carry its branch.
    expect(h.github.requests.some((r) => r.method === "GET" && r.path.endsWith("/pulls/101"))).toBe(
      true,
    );

    const opinions = await ledgerSecondOpinions(h.server.ledger)(PR_URL);
    expect(opinions.map((o) => [o.tool, o.verdict, o.findings])).toEqual([
      ["pr-agent", "approve", 0],
      ["claude-code-action", "changes", 2],
    ]);
  });

  it("attaches the verdicts to the pull request's review item", async () => {
    const h = await harness();
    await h.server.ledger.append([
      {
        id: "0199b4c0-0000-7000-8000-000000000101",
        schema: EVENT_SCHEMA,
        ts: "2026-10-05T09:00:00.000Z",
        source: "github",
        kind: "pr.opened",
        actor: { kind: "agent", id: "github:alice" },
        repo: REPO,
        agent: { vendor: "claude_code" },
        target: { type: "pr", value: PR_URL },
        links: { pr_url: PR_URL },
        data: { number: 101, title: "Add per-key rate limiting", risk: { score: 20, reasons: [] } },
      },
    ]);
    await h.deliver("issue_comment", reviewer("issue_comment.created.claude-code-action"));
    const list = openReviewList(h.server.ledger, { now: () => new Date("2026-10-05T10:00:00Z") });
    await refreshReviewList(h.server.ledger, list);
    const item = await list.pullRequest(PR_URL);
    expect(item?.second_opinions).toEqual([
      expect.objectContaining({ tool: "claude-code-action", verdict: "changes", severity: "high" }),
    ]);
    expect(item?.risk.score).toBe(70);
  });

  it("records a failed reviewer job, and names it as missing in the risk check", async () => {
    const h = await harness('version = 1\n[integrations.reviewer]\ntool = "claude-code-action"\n');
    const res = await h.deliver(
      "check_run",
      reviewer("check_run.completed.claude-code-action-failure"),
    );
    expect(res.json).toMatchObject({ handled: true });
    const [event] = await h.reviews();
    expect(event?.data?.second_opinion).toMatchObject({
      tool: "claude-code-action",
      verdict: "failed",
    });
    expect(h.github.checkRuns[0]?.output.text).toContain(
      "- Second opinion: Claude Code failed to run",
    );
  });

  it("skips its own check runs, people, placeholders and pull requests no agent opened", async () => {
    const h = await harness();
    const skipped: unknown[] = [];
    const human = reviewer("issue_comment.created.claude-code-action");
    human.comment.user = { login: "carol", type: "User" };
    const person = reviewer("pull_request_review.submitted.coderabbit");
    person.pull_request.head.ref = "fix/limits";
    person.pull_request.body = "Fixes the limiter.";
    for (const [event, payload] of [
      ["check_run", reviewer("check_run.completed.selfhost-review")],
      ["issue_comment", human],
      ["issue_comment", reviewer("issue_comment.created.pr-agent-preparing")],
      ["pull_request_review", person],
    ] as const) {
      const { json } = await h.deliver(event, payload);
      expect(json).toMatchObject({ handled: false });
      skipped.push(json.skipped);
    }
    expect(skipped).toEqual([
      "the check run is not a workflow job",
      "the comment is not from a reviewer bot",
      "a comment by github-actions[bot] is not a reviewer's verdict",
      "not an agent pull request",
    ]);
    expect(await h.reviews()).toEqual([]);
    expect(h.github.writes).toEqual([]);
  });

  it("keeps the constants other packages copy in step", () => {
    expect(INTEGRATIONS_BRIEF_MARKER).toBe(BRIEF_MARKER);
    expect(AGENT_LABEL_PREFIX).toBe(agentLabel("x").slice(0, -1));
    expect(agentLabels()).toEqual(AGENT_VENDORS.map((vendor) => agentLabel(vendor)));
  });
});
