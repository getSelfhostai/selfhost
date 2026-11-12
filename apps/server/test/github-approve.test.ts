import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Webhooks } from "@octokit/webhooks";
import { createGitHubApp, STATUSES_UNREADABLE } from "@selfhost/github";
import { FakeGitHub, type FakeGitHubOptions } from "@selfhost/github/testing";
import { stableEventId } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  EVENT_SCHEMA,
  type LedgerEvent,
  parseConfig,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import { GITHUB_WEBHOOK_PATH } from "../src/github.js";
import { AUTO_APPROVE_DRY_RUN_ALERT, secondOpinionOf } from "../src/github-approve.js";
import type { RiskAssessment } from "../src/github-pull.js";
import { claimRepos, startTestServer, type TestServer } from "./helpers.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");
const REPO = "acme/acme-api";
const HEAD = "5786c5c9d81ca4218b7e44bf0007f5580f66c489";
const BASE = "c3b8739bdcca2b4e2f5bdead2a8f238916813446";
const PR_URL = "https://github.com/acme/acme-api/pull/101";
const SESSION = "7b0c2c1e-docs-session";
const COMMITTED = "2026-11-10T09:58:00.000Z";
const APP_ID = "123456";
const SECRET = "test-webhook-secret";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const signer = new Webhooks({ secret: SECRET });

const PULL = JSON.parse(
  readFileSync(join(FIXTURES, "github", "webhooks", "pull_request.opened.json"), "utf8"),
).pull_request as { title: string; body: string };

const webhook = (name: string) =>
  readFileSync(join(FIXTURES, "github", "webhooks", `${name}.json`), "utf8");

const AUTO = `version = 1
[review]
github_team = "platform-reviewers"
[review.auto_approve]
enabled = true
`;

function config(toml: string): ResolvedSelfhostConfig {
  const parsed = parseConfig(toml);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
}

let n = 0;
const event = (fields: Pick<LedgerEvent, "kind"> & Partial<LedgerEvent>): LedgerEvent => {
  n += 1;
  const ts = fields.ts ?? COMMITTED;
  return {
    id: stableEventId(ts, `approve-test:${n}`),
    schema: EVENT_SCHEMA,
    ts,
    source: "hook",
    actor: { kind: "person", id: "alice@example.com" },
    session_id: SESSION,
    ...fields,
  };
};

const open: TestServer[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) await server.ledger.close();
});

let deliveries = 0;

async function harness(toml = AUTO, fake: FakeGitHubOptions = {}) {
  const github = new FakeGitHub(fake);
  const pull = github.addPull(REPO, 101, {
    author: "alice",
    title: PULL.title,
    body: PULL.body,
    head: { sha: HEAD, ref: "claude/add-rate-limit" },
    base: { sha: BASE, ref: "main" },
    files: [
      { filename: "docs/rate-limits.md", status: "added", additions: 40, deletions: 0 },
      { filename: "README.md", status: "modified", additions: 2, deletions: 1 },
    ],
    commits: [
      {
        sha: HEAD,
        commit: { message: "Document the rate limits", author: { date: COMMITTED } },
      },
    ],
  });
  const check = (status: string, conclusion: string | null) => {
    const existing = github.checkRuns.find((run) => run.name === "ci / test");
    if (existing) Object.assign(existing, { status, conclusion });
    else {
      github.checkRuns.push({
        id: 1,
        name: "ci / test",
        head_sha: HEAD,
        external_id: null,
        status,
        conclusion,
        output: { title: null, summary: null, text: null },
      });
    }
  };
  check("completed", "success");
  const state: { config: ResolvedSelfhostConfig; risk?: RiskAssessment } = {
    config: config(toml),
    risk: { level: "low", score: 5, title: "Low risk (score 5)" },
  };
  const app = createGitHubApp(
    { appId: APP_ID, privateKey: PRIVATE_KEY, webhookSecret: SECRET },
    { fetch: github.fetch, log: () => {} },
  );
  const server = await startTestServer({
    app,
    config: async () => state.config,
    log: () => {},
    providers: { risk: async () => state.risk },
  });
  open.push(server);
  await claimRepos(server.ledger, [REPO]);
  // The agent's session made the head commit: its run, with no guardrail hits yet.
  await server.ledger.append([
    event({ kind: "commit.created", links: { commit_sha: HEAD }, repo: REPO }),
  ]);
  const deliver = async (name: string, event = name.split(".")[0] ?? "pull_request") => {
    const body = webhook(name);
    const res = await server.app.request(GITHUB_WEBHOOK_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": `approve-${++deliveries}`,
        "x-github-event": event,
        "x-hub-signature-256": await signer.sign(body),
      },
      body,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const reviewWrites = () =>
    github.writes.filter((w) => w.method === "POST" && w.path.endsWith("/reviews"));
  const records = async () => ({
    decisions: (await server.ledger.query({ kind: "decision.recorded", limit: 100 })).events.filter(
      (e) => e.data?.surface === "auto_approve",
    ),
    dryRuns: (await server.ledger.query({ kind: "alert.raised", limit: 100 })).events.filter(
      (e) => e.data?.alert === AUTO_APPROVE_DRY_RUN_ALERT,
    ),
  });
  const summary = () => github.checkRuns.find((r) => r.name === "selfhost/review")?.output.summary;
  return { github, pull, server, state, deliver, check, reviewWrites, records, summary };
}

describe("auto-approve through the GitHub App", () => {
  it("in dry run, only records once per head commit what it would have approved", async () => {
    const h = await harness();
    expect((await h.deliver("pull_request.opened")).json).toMatchObject({ handled: true });
    expect(h.summary()).toContain("Auto-approve (dry run): selfhost would approve this");
    expect(h.reviewWrites()).toEqual([]);
    const text = h.github.checkRuns.find((r) => r.name === "selfhost/review")?.output.text;
    expect(text).toContain("| checks | passed | 1 check passed on the head commit |");

    await h.deliver("pull_request.opened");
    const { decisions, dryRuns } = await h.records();
    expect(decisions).toEqual([]);
    expect(dryRuns).toHaveLength(1);
    expect(dryRuns[0]).toMatchObject({
      kind: "alert.raised",
      source: "server",
      actor: { kind: "system", id: "selfhost auto-approve" },
      repo: REPO,
      links: { pr_url: PR_URL, commit_sha: HEAD },
      data: {
        alert: AUTO_APPROVE_DRY_RUN_ALERT,
        paths: ["docs/rate-limits.md", "README.md"],
      },
    });
    expect(dryRuns[0]?.data?.reasons).toContain("Low risk, score 5 (max_risk 20)");
  });

  it("approves through the App and records the decision, once, when dry_run is off", async () => {
    const h = await harness(`${AUTO}dry_run = false\n`);
    // The review list already has the pull request's item: it is answered by the approval.
    await h.server.ledger.append([
      event({
        kind: "pr.opened",
        source: "github",
        ts: "2026-11-10T09:59:00.000Z",
        actor: { kind: "agent", id: "github:claude[bot]" },
        session_id: undefined,
        repo: REPO,
        agent: { vendor: "claude_code" },
        target: { type: "pr", value: PR_URL },
        links: { pr_url: PR_URL },
        data: { number: 101, risk: { score: 5, reasons: [] }, files: ["docs/rate-limits.md"] },
      }),
    ]);
    const list = openReviewList(h.server.ledger);
    await refreshReviewList(h.server.ledger, list);
    const item = await list.pullRequest(PR_URL);
    expect(item?.state).toBe("open");

    expect((await h.deliver("pull_request.opened")).json).toMatchObject({ handled: true });
    expect(h.reviewWrites()).toHaveLength(1);
    expect(h.reviewWrites()[0]?.body).toMatchObject({ event: "APPROVE", commit_id: HEAD });
    const posted = h.reviewWrites()[0]?.body as { body?: string } | undefined;
    expect(posted?.body).toContain("<!-- selfhost:auto-approve v1 -->");
    expect(h.summary()).toContain("Auto-approve: selfhost approved this pull request.");
    const { decisions, dryRuns } = await h.records();
    expect(dryRuns).toEqual([]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      actor: { kind: "system", id: "selfhost auto-approve" },
      repo: REPO,
      decision: { verdict: "approve", by: "selfhost auto-approve", item_id: item?.id },
      links: { pr_url: PR_URL, commit_sha: HEAD, item_id: item?.id },
      data: { surface: "auto_approve" },
    });
    expect(decisions[0]?.decision?.reason).toContain("No guardrail or rule hits");
    const answered = await list.get(item?.id ?? "");
    expect(answered).toMatchObject({
      state: "answered",
      answer: { by: "selfhost auto-approve", verdict: "approve" },
    });

    // A redelivery approves nothing again and records nothing new.
    await h.deliver("pull_request.opened");
    expect(h.reviewWrites()).toHaveLength(1);
    expect((await h.records()).decisions).toHaveLength(1);
  });

  it("waits for checks still running, then approves when the check suite finishes", async () => {
    const h = await harness(`${AUTO}dry_run = false\n`);
    h.check("in_progress", null);
    await h.deliver("pull_request.opened");
    expect(h.reviewWrites()).toEqual([]);
    expect(h.summary()).toContain("Auto-approve: a person reviews this. Still running: ci / test.");

    h.check("completed", "success");
    const res = await h.deliver("check_suite.completed");
    // The check run's summary changes and the approval goes out.
    expect(res).toEqual({
      status: 200,
      json: { delivery: expect.any(String), handled: true, writes: 2 },
    });
    expect(h.github.writes.map((w) => `${w.method} ${w.path}`).slice(-2)).toEqual([
      "PATCH /repos/acme/acme-api/check-runs/1000",
      "POST /repos/acme/acme-api/pulls/101/reviews",
    ]);
    expect(h.reviewWrites()).toHaveLength(1);
    expect((await h.records()).decisions).toHaveLength(1);
  });

  // The App's documented permissions once lacked "Commit statuses: read": the combined status
  // answered 403 on every delivery and require_green_checks failed with every check green.
  it("counts the check runs alone, and says so, when the App may not read commit statuses", async () => {
    const h = await harness(`${AUTO}dry_run = false\nrequire_green_checks = true\n`, {
      noStatusesPermission: true,
    });
    await h.deliver("pull_request.opened");
    expect(h.reviewWrites()).toHaveLength(1);
    const text = h.github.checkRuns.find((r) => r.name === "selfhost/review")?.output.text;
    expect(text).toContain(`1 check passed on the head commit (${STATUSES_UNREADABLE})`);
    expect((await h.records()).decisions[0]?.decision?.reason).toContain(STATUSES_UNREADABLE);
  });

  it("ignores finished check suites while auto-approve is off", async () => {
    const h = await harness("version = 1\n");
    const res = await h.deliver("check_suite.completed");
    expect(res.json).toMatchObject({
      handled: false,
      skipped: "[review.auto_approve] is off, so finished checks change nothing",
    });
    expect(h.github.requests).toEqual([]);
  });

  it("never approves while an exception from the agent's run is open, or after a guardrail hit", async () => {
    const h = await harness(`${AUTO}dry_run = false\n`);
    await h.server.ledger.append([
      event({
        kind: "policy.evaluated",
        ts: "2026-11-10T09:50:00.000Z",
        actor: { kind: "system", id: "selfhost-policy" },
        tool: { name: "Bash", input_summary: "git push -f" },
        decision: {
          verdict: "block",
          by: "selfhost-policy",
          rule_id: "guard.force_push",
          mode: "enforce",
        },
        data: {
          exception: { id: "019a7000-0000-7000-8000-000000000001", fingerprint: "f1" },
          sent_by: "alice@example.com",
        },
      }),
    ]);
    await refreshReviewList(h.server.ledger, openReviewList(h.server.ledger));
    await h.deliver("pull_request.opened");
    expect(h.reviewWrites()).toEqual([]);
    const text = h.github.checkRuns.find((r) => r.name === "selfhost/review")?.output.text ?? "";
    expect(text).toContain('exception "Allow once: Bash: git push -f"');
    expect(text).toContain("Guardrail or rule hits in the run: guard.force_push");
    expect(await h.records()).toEqual({ decisions: [], dryRuns: [] });
  });

  it("does nothing, and reads nothing extra, while auto-approve is off", async () => {
    const h = await harness("version = 1\n");
    await h.deliver("pull_request.opened");
    expect(h.summary()).not.toContain("Auto-approve");
    expect(h.github.requests.some((r) => r.path.endsWith("/status"))).toBe(false);
    expect(h.reviewWrites()).toEqual([]);
  });

  it("needs a passing second opinion once the reviewer integration is set", async () => {
    const h = await harness(
      `${AUTO}dry_run = false\n[integrations.reviewer]\ntool = "coderabbit"\n`,
    );
    await h.deliver("pull_request.opened");
    expect(h.summary()).toContain("No second opinion from coderabbit yet");
    expect(h.reviewWrites()).toEqual([]);
  });
});

describe("secondOpinionOf", () => {
  it("reads the reviewer ingest's second_opinion off an item, passing only clean verdicts", () => {
    const item = (second_opinion: unknown) => ({ second_opinion }) as never;
    expect(secondOpinionOf(item({ verdict: "clean", tool: "coderabbit" }))).toEqual({
      verdict: "pass",
      by: "coderabbit",
    });
    expect(secondOpinionOf(item({ verdict: "changes_requested", summary: " 2 bugs " }))).toEqual({
      verdict: "fail",
      summary: "2 bugs",
    });
    expect(secondOpinionOf(item(undefined))).toBeUndefined();
    expect(secondOpinionOf(undefined)).toBeUndefined();
  });
});

describe("routes on GitHub", () => {
  it("asks the GitHub accounts a route names, from @ targets and CODEOWNERS", async () => {
    const h = await harness(`version = 1
[review]
github_team = "platform-reviewers"
[review.github_logins]
"bob@example.com" = "bob"
[[review.routes]]
id = "docs"
kinds = ["pr"]
paths = ["docs/**"]
to = ["@acme/docs", "codeowners"]
`);
    h.github.contents.set(`${REPO}@${BASE}:.github/CODEOWNERS`, "*.md @bob @acme/writers\n");
    await h.deliver("pull_request.opened");
    expect(h.pull.requestedUsers).toEqual(["bob"]);
    expect(h.pull.requestedTeams).toEqual(["docs", "writers"]);
    expect(h.summary()).toContain(
      'Review requested from @bob, @acme/docs, @acme/writers ([[review.routes]] "docs").',
    );
  });
});
