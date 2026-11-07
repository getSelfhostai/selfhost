import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubDecision } from "@selfhost/attribution";
import { chatDecision, type Ledger, openLedger } from "@selfhost/ledger";
import type {
  CreateDecisionRequest,
  CreateDecisionResponse,
  DecisionsPage,
  LedgerEvent,
} from "@selfhost/schema";
import { createApp } from "@selfhost/server/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoPath } from "../src/decisions.js";
import { run, tempDir } from "./run.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const webhook = (name: string): unknown =>
  JSON.parse(readFileSync(join(fixtures, "github", "webhooks", `${name}.json`), "utf8"));

const ITEM = "01930c4e-2f1a-7b2c-8d3e-4f5a6b7c8d40";

const POLICY = `version = 1

[[rules]]
id = "protect-migrations"
match = { path = "db/migrations/**" }
action = "ask"
message = "Migrations need a human review."
`;

/** Every decision.recorded event in the ledger, newest first. */
async function decisions(ledger: Ledger): Promise<LedgerEvent[]> {
  return (await ledger.query({ kind: "decision.recorded", limit: 1000 })).events;
}

/** Opens the embedded ledger in `dir`, reads every decision and closes it again. */
async function decisionsIn(dir: string): Promise<LedgerEvent[]> {
  const ledger = await openLedger({ dataDir: dir });
  try {
    return await decisions(ledger);
  } finally {
    await ledger.close();
  }
}

const shared: string[] = [];

afterAll(() => {
  for (const dir of shared.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp folder kept until the file's tests finish; tempDir ones go after each test. */
function sharedDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `selfhost-cli-${prefix}-`));
  shared.push(dir);
  return dir;
}

/** A git repository with dev@example.com as its user, and a db/ folder. */
function gitRepo(root: string) {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  mkdirSync(join(root, "db"));
  return { root, path: (...parts: string[]) => join(root, ...parts) };
}

describe("one human action makes exactly one decision event", () => {
  describe("on the command line", () => {
    it("selfhost decide records the CLI inbox answer", async () => {
      const repo = gitRepo(tempDir("decide").root);
      const data = tempDir("decide-ledger").root;
      const result = await run(
        [
          "decide",
          ITEM,
          "deny",
          "--reason",
          "Not before the backfill",
          "--question",
          "Apply migration 0004?",
          "--path",
          "migrations/0004.sql",
          "--data-dir",
          data,
        ],
        { cwd: repo.path("db") },
      );
      expect(result.err).toBe("");
      expect(result.code).toBe(0);
      const [event, ...rest] = await decisionsIn(data);
      expect(rest).toEqual([]);
      expect(result.out.split("\n")[0]).toBe(`Recorded decision ${event?.id}.`);
      expect(event).toMatchObject({
        source: "cli",
        actor: { kind: "person", id: "dev@example.com" },
        // --path is relative to where the command ran, stored relative to the repository.
        target: { type: "file", value: "db/migrations/0004.sql" },
        decision: { verdict: "deny", by: "dev@example.com", item_id: ITEM },
        data: { surface: "cli", question: "Apply migration 0004?" },
      });

      const answer = await run(
        [
          "decide",
          "run-7",
          "answer",
          "--reason",
          "Use the staging key",
          "--json",
          "--data-dir",
          data,
        ],
        { cwd: repo.root, env: { SELFHOST_PERSON: "ops@example.com" } },
      );
      const report = JSON.parse(answer.out) as CreateDecisionResponse;
      expect(report).toMatchObject({ schema: "selfhost.decide/v1", duplicate: false });
      const answered = report.decision_event;
      expect(answered).toMatchObject({
        run_id: "run-7",
        decision: { verdict: "answer", by: "ops@example.com", reason: "Use the staging key" },
      });
      expect((await decisionsIn(data)).map((e) => e.id)).toEqual([answered.id, event?.id]);
    });

    it("selfhost policy promote records the rule promotion, and nothing when nothing changed", async () => {
      const repo = tempDir("promote-decision");
      gitRepo(repo.root);
      repo.write("selfhost.toml", POLICY);
      const data = tempDir("promote-ledger").root;
      const promote = (...extra: string[]) =>
        run(["policy", "promote", "protect-migrations", "--data-dir", data, ...extra], {
          cwd: repo.root,
        });

      const first = await promote("--reason", "A week in observe with no false positives");
      expect(first.err).toBe("");
      const [event, ...rest] = await decisionsIn(data);
      expect(rest).toEqual([]);
      expect(event).toMatchObject({
        source: "cli",
        actor: { kind: "person", id: "dev@example.com" },
        target: { type: "file", value: "selfhost.toml" },
        decision: {
          verdict: "approve",
          by: "dev@example.com",
          reason: "A week in observe with no false positives",
          rule_id: "protect-migrations",
        },
        data: {
          surface: "rule_promotion",
          question: "Change rule protect-migrations from observe to enforce",
        },
      });
      expect(first.out).toContain(`Recorded decision ${event?.id} in the ledger.`);

      // Already in enforce: no human decision happened, so nothing is recorded.
      await promote();
      expect(await decisionsIn(data)).toHaveLength(1);

      const back = await promote("--to", "observe", "--json");
      const report = JSON.parse(back.out);
      const after = await decisionsIn(data);
      expect(after).toHaveLength(2);
      expect(after[0]).toMatchObject({
        id: report.decision_event_id,
        decision: { verdict: "override", rule_id: "protect-migrations" },
      });
    });
  });

  describe("through POST /v1/decisions", () => {
    const TOKEN = "admin-token";
    let ledger: Ledger;
    let app: ReturnType<typeof createApp>;

    beforeAll(async () => {
      ledger = await openLedger({ dataDir: "memory://" });
      app = createApp({ version: "test", ledger, token: TOKEN });
    });

    afterAll(async () => {
      await ledger.close();
    });

    async function send(decision: CreateDecisionRequest | undefined) {
      expect(decision).toBeDefined();
      const res = await app.request("/v1/decisions", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(decision),
      });
      expect([200, 201]).toContain(res.status);
      return (await res.json()) as CreateDecisionResponse;
    }

    /** Sends the decision twice, as a retried delivery would, and checks one event exists. */
    async function once(decision: CreateDecisionRequest | undefined) {
      const before = (await decisions(ledger)).length;
      const first = await send(decision);
      const again = await send(decision);
      expect(first.duplicate).toBe(false);
      expect(again).toEqual({ decision_event: first.decision_event, duplicate: true });
      const after = await decisions(ledger);
      expect(after).toHaveLength(before + 1);
      return first.decision_event;
    }

    it("a GitHub review on an agent pull request, redelivered", async () => {
      const event = await once(
        githubDecision("pull_request_review", webhook("pull_request_review.approved")),
      );
      expect(event).toMatchObject({
        source: "github",
        actor: { kind: "person", id: "bob" },
        repo: "acme/acme-api",
        target: { type: "pr", value: "https://github.com/acme/acme-api/pull/101" },
        decision: { verdict: "approve", by: "bob" },
        links: { pr_url: "https://github.com/acme/acme-api/pull/101" },
        data: { surface: "github_review", question: "#101 Add per-key rate limiting" },
      });
      const changes = await once(
        githubDecision("pull_request_review", webhook("pull_request_review.changes_requested")),
      );
      expect(changes.decision?.verdict).toBe("deny");
    });

    it("a GitHub comment on an agent pull request, redelivered", async () => {
      const event = await once(githubDecision("issue_comment", webhook("issue_comment.created")));
      expect(event).toMatchObject({
        source: "github",
        decision: { verdict: "answer", by: "carol" },
        data: { surface: "github_comment" },
      });
    });

    it("an exception approval", async () => {
      const event = await once({
        verdict: "approve",
        by: "lead@example.com",
        reason: "One-off: the seed only touches staging",
        question: "Allow run 12 past ask-before-seed?",
        rule_id: "ask-before-seed",
        run_id: "run-12",
        surface: "exception_approval",
        key: "exception:run-12:ask-before-seed",
        ts: "2026-11-07T10:00:00.000Z",
      });
      expect(event.data).toMatchObject({ surface: "exception_approval" });
    });

    it.each(["slack", "telegram"] as const)("a %s button press, retried", async (surface) => {
      const event = await once(
        chatDecision({
          surface,
          actionId: `${surface}-press-1`,
          at: "2026-11-07T10:05:00.000Z",
          person: "dana@example.com",
          verdict: "approve",
          itemId: ITEM,
          reason: "ok",
        }),
      );
      expect(event.data).toMatchObject({ surface });
    });

    it("finds them again by path and topic, as plain text", async () => {
      const res = await app.request("/v1/decisions?topic=bucket&format=text", {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const text = await res.text();
      expect(text).toContain("approve by bob");
      expect(text).toContain("  pr: https://github.com/acme/acme-api/pull/101");
      const json = await app.request("/v1/decisions?topic=seed%20staging", {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const page = (await json.json()) as DecisionsPage;
      expect(page.decisions.map((e) => e.data?.surface)).toEqual(["exception_approval"]);
    });
  });
});

describe("selfhost decisions", () => {
  let data: string;
  let repo: ReturnType<typeof gitRepo>;

  beforeAll(async () => {
    data = sharedDir("decisions-ledger");
    repo = gitRepo(sharedDir("decisions"));
    const decide = async (...args: string[]) => {
      const result = await run(["decide", ...args, "--data-dir", data], { cwd: repo.root });
      expect(result.err).toBe("");
    };
    await decide(
      "run-1",
      "approve",
      "--question",
      "Run the orders migration?",
      "--path",
      "db/migrations/0005_orders.sql",
    );
    await decide("run-2", "deny", "--reason", "Retries belong in the client", "--path", "src/x.ts");
  });

  it("finds decisions by path from a subfolder and by topic", async () => {
    const byPath = await run(["decisions", "--path", "migrations", "--data-dir", data], {
      cwd: repo.path("db"),
    });
    expect(byPath.err).toBe("");
    expect(byPath.out).toMatch(/^1 decision, newest first\.\n\n[0-9a-f-]{36} {2}\S+ {2}approve by/);
    expect(byPath.out).toContain("  files: db/migrations/0005_orders.sql");

    const byTopic = await run(
      ["decisions", "--topic", "client retries", "--json", "--data-dir", data],
      {
        cwd: repo.root,
      },
    );
    const page = JSON.parse(byTopic.out) as DecisionsPage;
    expect(page).toMatchObject({ schema: "selfhost.decisions/v1", next_cursor: null });
    expect(page.decisions.map((e) => e.run_id)).toEqual(["run-2"]);
    expect(page.next_cursor).toBeNull();
  });

  it("records a correction linked to the decision it changes", async () => {
    const [denied] = (
      JSON.parse(
        (await run(["decisions", "--topic", "retries", "--json", "--data-dir", data])).out,
      ) as DecisionsPage
    ).decisions;
    const fix = await run(
      [
        "decide",
        "run-2",
        "override",
        "--replaces",
        denied?.id ?? "",
        "--reason",
        "Retries in the client did not cover webhooks",
        "--data-dir",
        data,
      ],
      { cwd: repo.root },
    );
    expect(fix.err).toBe("");
    const text = await run(["decisions", "--path", "src/x.ts", "--data-dir", data], {
      cwd: repo.root,
    });
    const ids = [...text.out.matchAll(/^([0-9a-f-]{36}) {2}/gm)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(denied?.id);
    expect(text.out).toContain(`  replaces: ${denied?.id}`);
    expect(text.out).toContain(`  replaced by: ${ids[0]}`);
  });

  it("names the flag when a decision or query is wrong", async () => {
    const bad = await run(["decide", "run-3", "maybe", "--data-dir", data]);
    expect(bad.code).toBe(1);
    expect(bad.err).toBe('Expected a verdict of approve, deny, answer or override, got "maybe"');
    const pr = await run(["decide", "run-3", "approve", "--pr", "nope", "--data-dir", data]);
    expect(pr.err).toBe("--pr: Expected a uri string");
    const replaces = await run(
      ["decide", "run-3", "override", "--replaces", ITEM, "--json", "--data-dir", data],
      {},
    );
    expect(JSON.parse(replaces.out)).toEqual({
      schema: "selfhost.error/v1",
      error: "--replaces: No decision or rule verdict with this id",
    });
    const limit = await run(["decisions", "--limit", "x", "--data-dir", data]);
    expect(limit.err).toBe('--limit: expected a number, got "x"');
  });
});

describe("repoPath", () => {
  it("makes paths relative to the repository root, and leaves others normalized", () => {
    const repo = gitRepo(tempDir("repo-path").root);
    expect(repoPath("a/b.ts", repo.path("src"))).toBe("src/a/b.ts");
    expect(repoPath(repo.path("src", "c.ts"), repo.root)).toBe("src/c.ts");
    expect(repoPath("./x/", tempDir("no-repo").root)).toBe("x");
  });
});
