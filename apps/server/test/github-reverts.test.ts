import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Webhooks } from "@octokit/webhooks";
import { createGitHubApp } from "@selfhost/github";
import { type FakeFile, FakeGitHub } from "@selfhost/github/testing";
import { stableEventId } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import { EVENT_SCHEMA, type LedgerEvent, parseConfig } from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import { GITHUB_WEBHOOK_PATH } from "../src/github.js";
import { learnedRisk } from "../src/github-reverts.js";
import { eeRisk } from "../src/github-risk.js";
import { claimRepos, startTestServer, type TestServer } from "./helpers.js";

const WEBHOOKS = join(import.meta.dirname, "..", "..", "..", "fixtures", "github", "webhooks");
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const APP_ID = "123456";
const SECRET = "test-webhook-secret";
const signer = new Webhooks({ secret: SECRET });
const REPO = "acme/acme-api";
const URL = (n: number) => `https://github.com/${REPO}/pull/${n}`;
const SESSION = "0193a000-0000-7000-8000-00000000f012";

const day = (n: number) => new Date(Date.parse("2026-10-01T10:00:00Z") + n * 86_400_000);

/** A file that adds `count` lines from line 1: what an agent pull request wrote. */
const added = (filename: string, count: number): FakeFile => ({
  filename,
  status: "added",
  additions: count,
  deletions: 0,
  patch: `@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, (_, i) => `+line ${i + 1}`).join("\n")}`,
});

/** A file that rewrites lines `from` and `from + 1`: a later fix. */
const edited = (filename: string, from: number): FakeFile => ({
  filename,
  status: "modified",
  additions: 2,
  deletions: 2,
  patch: `@@ -${from - 1},4 +${from - 1},4 @@\n context\n-old a\n-old b\n+new a\n+new b\n context`,
});

interface Merge {
  agent?: boolean;
  title?: string;
  body?: string;
  at: Date;
  sha?: string;
}

/** The recorded closed.merged delivery, moved to pull request `n`. */
function merged(n: number, merge: Merge): unknown {
  const payload = JSON.parse(
    readFileSync(join(WEBHOOKS, "pull_request.closed.merged.json"), "utf8"),
  );
  const pr = payload.pull_request;
  payload.number = n;
  Object.assign(pr, {
    number: n,
    html_url: URL(n),
    title: merge.title ?? `Change ${n}`,
    body: merge.body ?? "",
    merged_at: merge.at.toISOString(),
    closed_at: merge.at.toISOString(),
    merge_commit_sha: merge.sha ?? `${String(n).padStart(4, "0")}${"a".repeat(36)}`,
  });
  if (merge.agent === false) {
    pr.user = { login: "bob", type: "User" };
    pr.head = { ...pr.head, ref: `bob/change-${n}` };
  } else {
    pr.head = { ...pr.head, ref: `claude/change-${n}` };
  }
  return payload;
}

const open: TestServer[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) await server.ledger.close();
});

async function harness(toml = "version = 1\n[review]\nrevert_window_days = 14\n") {
  const github = new FakeGitHub({ appId: APP_ID, publicKey: PUBLIC_KEY });
  const app = createGitHubApp(
    { appId: APP_ID, privateKey: PRIVATE_KEY, webhookSecret: SECRET },
    { fetch: github.fetch, log: () => {} },
  );
  const parsed = parseConfig(toml);
  if (!parsed.ok) throw new Error("bad config");
  const lines: string[] = [];
  const clock = { now: day(30) };
  const server = await startTestServer({
    app,
    config: async () => parsed.config,
    log: (line) => lines.push(line),
    now: () => clock.now,
    providers: { risk: async () => ({ level: "low", score: 1 }) },
  });
  open.push(server);
  await claimRepos(server.ledger, [REPO]);
  let n = 0;
  const deliver = async (payload: unknown, event = "pull_request") => {
    const body = JSON.stringify(payload);
    const res = await server.app.request(GITHUB_WEBHOOK_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": `reverts-${++n}`,
        "x-github-event": event,
        "x-hub-signature-256": await signer.sign(body),
      },
      body,
    });
    return (await res.json()) as Record<string, unknown>;
  };
  const events = async (kind: string) =>
    (await server.ledger.query({ kind, limit: 500 })).events.sort((a, b) =>
      a.ts.localeCompare(b.ts),
    );
  /** An agent pull request merged on day `at`, writing `files`. */
  const agentMerge = async (number: number, at: number, files: FakeFile[], sha?: string) => {
    github.addPull(REPO, number, { author: "alice", files });
    return deliver(merged(number, { at: day(at), ...(sha ? { sha } : {}) }));
  };
  return { server, github, deliver, events, agentMerge, lines, config: parsed.config, clock };
}

/** The run that opened pull request `n`, so its pr.merged and every revert name the session. */
const runOpened = (n: number): LedgerEvent => ({
  id: stableEventId("2026-09-30T09:00:00.000Z", `reverts-test:${n}`),
  schema: EVENT_SCHEMA,
  ts: "2026-09-30T09:00:00.000Z",
  source: "hook",
  kind: "tool.result",
  actor: { kind: "person", id: "carol@example.com" },
  session_id: SESSION,
  agent: { vendor: "claude_code" },
  tool: { name: "Bash", input_summary: "gh pr create" },
  links: { pr_url: URL(n) },
});

describe("learning from reverts", () => {
  it("records the lines an agent pull request added on its pr.merged event", async () => {
    const h = await harness();
    await h.agentMerge(201, 0, [added("src/auth/keys.ts", 20), added("docs/keys.md", 3)]);
    const [merge] = await h.events("pr.merged");
    expect(merge?.data?.lines).toEqual({ "docs/keys.md": [[1, 3]], "src/auth/keys.ts": [[1, 20]] });
  });

  it("links a revert pull request to the agent pull request, its run and the reason", async () => {
    const h = await harness();
    await h.server.ledger.append([runOpened(201)]);
    await h.agentMerge(201, 0, [added("src/auth/keys.ts", 20)]);
    h.github.addPull(REPO, 202, { author: "bob" });
    const res = await h.deliver(
      merged(202, {
        agent: false,
        title: 'Revert "Change 201"',
        body: "Reverts acme/acme-api#201\n\nBroke key rotation for SSO tenants.",
        at: day(2),
      }),
    );
    expect(res).toMatchObject({ handled: true });
    const [revert, ...more] = await h.events("pr.reverted");
    expect(more).toEqual([]);
    expect(revert).toMatchObject({
      kind: "pr.reverted",
      source: "server",
      actor: { kind: "person", id: "bob" },
      agent: { vendor: "claude_code" },
      session_id: SESSION,
      repo: REPO,
      target: { type: "pr", value: URL(201) },
      links: { pr_url: URL(201) },
      data: {
        number: 201,
        via: "revert_pr",
        by_pr: URL(202),
        by_number: 202,
        days_after_merge: 2,
        reason: "Broke key rotation for SSO tenants.",
      },
    });
    // The push of the same revert to main names the same pull request: still one event.
    await h.deliver(
      {
        ref: "refs/heads/main",
        repository: { name: "acme-api", owner: { login: "acme" }, default_branch: "main" },
        commits: [
          {
            id: "b".repeat(40),
            message: 'Revert "Change 201" (#202)\n\nReverts acme/acme-api#201',
            timestamp: day(2).toISOString(),
            author: { username: "bob" },
          },
        ],
      },
      "push",
    );
    expect(await h.events("pr.reverted")).toHaveLength(1);
  });

  it("finds the reverted pull request from the commits when the description names none", async () => {
    const h = await harness();
    await h.agentMerge(201, 0, [added("src/auth/keys.ts", 20)], "c".repeat(40));
    h.github.addPull(REPO, 202, {
      author: "bob",
      commits: [
        {
          sha: "d".repeat(40),
          commit: {
            message: `Revert "Change 201"\n\nThis reverts commit ${"c".repeat(40)}.`,
            author: null,
          },
        },
      ],
    });
    await h.deliver(merged(202, { agent: false, title: 'Revert "Change 201"', at: day(1) }));
    const [revert] = await h.events("pr.reverted");
    expect(revert?.target?.value).toBe(URL(201));
  });

  it("records a revert pushed straight to the default branch", async () => {
    const h = await harness();
    await h.agentMerge(201, 0, [added("src/auth/keys.ts", 20)], "e".repeat(40));
    const push = (ref: string) => ({
      ref,
      repository: { name: "acme-api", owner: { login: "acme" }, default_branch: "main" },
      pusher: { name: "dave" },
      commits: [
        {
          id: "f".repeat(40),
          message: `Revert "Change 201"\n\nThis reverts commit ${"e".repeat(12)}.\nIt leaked keys in logs.`,
          timestamp: day(3).toISOString(),
          author: {},
        },
      ],
    });
    expect(await h.deliver(push("refs/heads/feature"), "push")).toMatchObject({
      handled: false,
      skipped: "no revert of an agent pull request",
    });
    expect(await h.deliver(push("refs/heads/main"), "push")).toMatchObject({ handled: true });
    const [revert] = await h.events("pr.reverted");
    expect(revert).toMatchObject({
      actor: { kind: "person", id: "dave" },
      target: { value: URL(201) },
      links: { commit_sha: "f".repeat(40) },
      data: { via: "revert_commit", days_after_merge: 3, reason: "It leaked keys in logs." },
    });
  });

  it("does not count a revert or a fix after revert_window_days", async () => {
    const h = await harness();
    await h.agentMerge(201, 0, [added("src/auth/keys.ts", 20)]);
    h.github.addPull(REPO, 202, { author: "bob" });
    const late = await h.deliver(
      merged(202, {
        agent: false,
        title: 'Revert "Change 201"',
        body: "Reverts #201",
        at: day(15),
      }),
    );
    expect(late).toMatchObject({ handled: false, skipped: "not an agent pull request" });
    h.github.addPull(REPO, 203, { author: "bob", files: [edited("src/auth/keys.ts", 5)] });
    await h.deliver(merged(203, { agent: false, at: day(16) }));
    expect(await h.events("pr.reverted")).toEqual([]);
    expect(await h.events("pr.reworked")).toEqual([]);
    // Day 14 itself still counts.
    h.github.addPull(REPO, 204, { author: "bob" });
    await h.deliver(
      merged(204, {
        agent: false,
        title: 'Revert "Change 201"',
        body: "Reverts #201",
        at: day(14),
      }),
    );
    expect(await h.events("pr.reverted")).toHaveLength(1);
  });

  it("records a later change to the lines an agent pull request wrote as a rework", async () => {
    const h = await harness();
    await h.agentMerge(201, 0, [added("src/auth/keys.ts", 20)]);
    // A change elsewhere in the file, or in another file, is not a rework.
    h.github.addPull(REPO, 202, {
      author: "bob",
      files: [edited("src/auth/other.ts", 5), { ...edited("src/auth/keys.ts", 40) }],
    });
    await h.deliver(merged(202, { agent: false, at: day(1) }));
    expect(await h.events("pr.reworked")).toEqual([]);
    h.github.addPull(REPO, 203, { author: "bob", files: [edited("src/auth/keys.ts", 12)] });
    expect(await h.deliver(merged(203, { agent: false, at: day(4) }))).toMatchObject({
      handled: true,
    });
    const [rework] = await h.events("pr.reworked");
    expect(rework).toMatchObject({
      actor: { kind: "person", id: "bob" },
      agent: { vendor: "claude_code" },
      target: { value: URL(201) },
      data: {
        via: "later_pr",
        by_pr: URL(203),
        files: ["src/auth/keys.ts"],
        lines: 2,
        days_after_merge: 4,
      },
    });
  });

  it("proposes a signal above the threshold, which raises the risk only once a person approves it", async () => {
    const h = await harness();
    // Five agent pull requests in src, two of them reverted: 40%, above the default 25%.
    for (const [number, at] of [
      [301, 0],
      [302, 1],
      [303, 2],
      [304, 3],
    ] as const) {
      await h.agentMerge(number, at, [added(`src/mod${number}.ts`, 10)]);
    }
    h.github.addPull(REPO, 310, { author: "bob" });
    await h.deliver(
      merged(310, {
        agent: false,
        title: 'Revert "Change 301"',
        body: "Reverts #301\n\nFlaky.",
        at: day(4),
      }),
    );
    // Four merges is under the minimum sample: nothing is proposed yet.
    expect(await h.events("risk.learned")).toEqual([]);
    await h.agentMerge(305, 5, [added("src/mod305.ts", 10)]);
    h.github.addPull(REPO, 311, { author: "bob" });
    await h.deliver(
      merged(311, { agent: false, title: 'Revert "Change 302"', body: "Reverts #302", at: day(6) }),
    );

    const [learned, ...more] = await h.events("risk.learned");
    expect(more).toEqual([]);
    const reverts = await h.events("pr.reverted");
    expect(learned).toMatchObject({
      kind: "risk.learned",
      agent: { vendor: "claude_code" },
      repo: REPO,
      data: {
        state: "proposed",
        module: "src",
        pulls: 5,
        reverted: 2,
        reworked: 0,
        rate: 0.4,
        threshold: 0.25,
        days: 14,
      },
    });
    expect(
      ((learned?.data?.evidence ?? []) as { event_id: string }[]).map((e) => e.event_id).sort(),
    ).toEqual(reverts.map((e) => e.id).sort());
    expect(learned?.data?.suggestion).toContain('"src/**"');
    expect(h.lines.some((line) => line.includes("learned risk.learned proposed"))).toBe(true);

    // The review list opens a quality item under the signal's id.
    const list = openReviewList(h.server.ledger, { config: h.config, now: () => h.clock.now });
    await refreshReviewList(h.server.ledger, list);
    const itemId = learned?.links?.item_id ?? "";
    const item = await list.get(itemId);
    expect(item).toMatchObject({ kind: "quality", state: "open" });
    expect(item?.title).toBe("Claude Code pull requests in acme/acme-api src keep being reverted");
    expect(item?.why?.signal).toBe("risk.learned");
    expect(item?.brief).toContain(
      "2 of 5 merged pull requests by Claude Code in acme/acme-api src",
    );
    expect(item?.brief).toContain(
      `- Reverted: ${URL(301)} by ${URL(310)}, 4 days after the merge. Why: Flaky.`,
    );
    expect(item?.brief).toContain('"src/**"');

    // Not approved yet: a new agent pull request in src scores without it.
    const lookup = learnedRisk(h.server.ledger);
    const agent = { vendor: "claude_code" as const };
    expect(await lookup(REPO, agent, ["src"])).toEqual([]);

    await list.decide(itemId, { verdict: "approve", by: "lead@example.com" });
    expect(await lookup(REPO, agent, ["src", "docs"])).toEqual([
      { module: "src", pulls: 5, reverted: 2, reworked: 0, rate: 0.4, days: 14 },
    ]);
    // Another agent, or a module the pull request does not touch, gets nothing.
    expect(await lookup(REPO, { vendor: "codex" }, ["src"])).toEqual([]);
    expect(await lookup(REPO, agent, ["docs"])).toEqual([]);

    // The server's risk provider counts it for a new pull request in src.
    h.github.addPull(REPO, 320, { author: "alice", files: [added("src/new.ts", 5)] });
    const provider = eeRisk(undefined, undefined, undefined, undefined, undefined, lookup);
    const octokit = createGitHubApp(
      { appId: APP_ID, privateKey: PRIVATE_KEY, webhookSecret: SECRET },
      { fetch: h.github.fetch, log: () => {} },
    ).installation(61000001);
    const files = () =>
      octokit.paginate(octokit.rest.pulls.listFiles, {
        owner: "acme",
        repo: "acme-api",
        pull_number: 320,
        per_page: 100,
      });
    const scored = await provider?.({
      octokit,
      pull: {
        owner: "acme",
        repo: "acme-api",
        number: 320,
        title: "New",
        url: URL(320),
        headSha: "1".repeat(40),
        baseSha: "2".repeat(40),
        headRef: "claude/new",
        author: "alice",
        draft: false,
      },
      agent,
      config: h.config,
      server: "https://selfhost.example.com",
      reads: { files, commits: async () => [], contents: async () => undefined } as never,
    } as never);
    expect(scored?.text).toContain("Learned from reverts");
    expect(scored?.score).toBe(15);

    // Five more clean merges bring the rate to 20%: the signal clears and stops counting.
    h.clock.now = day(31);
    for (const number of [306, 307, 308, 309, 312]) {
      await h.agentMerge(number, 7, [added(`src/mod${number}.ts`, 10)]);
    }
    const states = (await h.events("risk.learned")).map((e) => e.data?.state);
    expect(states).toEqual(["proposed", "cleared"]);
    expect(await lookup(REPO, agent, ["src"])).toEqual([]);
  });
});
