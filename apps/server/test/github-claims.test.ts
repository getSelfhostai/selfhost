import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Webhooks } from "@octokit/webhooks";
import { createGitHubApp } from "@selfhost/github";
import { FakeGitHub } from "@selfhost/github/testing";
import { databaseOf } from "@selfhost/ledger";
import { parseConfig } from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import { GITHUB_WEBHOOK_PATH } from "../src/github.js";
import { claimRepos, startTestServer, type TestServer } from "./helpers.js";

const WEBHOOKS = join(import.meta.dirname, "..", "..", "..", "fixtures", "github", "webhooks");
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const APP_ID = "123456";
const SECRET = "test-webhook-secret";
const signer = new Webhooks({ secret: SECRET });

// The App is installed on the whole org, so the public product repo sends deliveries too; no
// team claimed it. In the real test 14 of them arrived, check_suite.completed among them.
const UNCLAIMED = "getSelfhostai/selfhost";

/** A fixture delivery, moved to `repo`. */
function from(file: string, repo = UNCLAIMED): unknown {
  const [owner = "", name = ""] = repo.split("/");
  const text = readFileSync(join(WEBHOOKS, file), "utf8").replaceAll("acme/acme-api", repo);
  const payload = JSON.parse(text) as { repository: Record<string, unknown> };
  payload.repository.name = name;
  payload.repository.owner = { ...(payload.repository.owner as object), login: owner };
  return payload;
}

/** Every event type the webhook handles, with the fixture that carries it. */
const DELIVERIES: [event: string, file: string][] = [
  ["pull_request", "pull_request.opened.json"],
  ["pull_request", "pull_request.synchronize.json"],
  ["pull_request", "pull_request.labeled.json"],
  ["pull_request", "pull_request.closed.merged.json"],
  ["check_suite", "check_suite.completed.json"],
  ["check_run", "reviewers/check_run.completed.claude-code-action-failure.json"],
  ["issue_comment", "reviewers/issue_comment.created.pr-agent.json"],
  ["issue_comment", "reviewers/issue_comment.created.claude-code-action.json"],
  ["issue_comment", "runs/issue_comment.created.run.json"],
  ["issues", "runs/issues.labeled.selfhost.json"],
  ["pull_request_review", "reviewers/pull_request_review.submitted.coderabbit.json"],
  ["pull_request_review", "pull_request_review.approved.json"],
];

const AUTO_APPROVE = `version = 1
[review]
github_team = "platform-reviewers"
[review.auto_approve]
enabled = true
max_risk = 100
allowed_paths = ["**"]
require_green_checks = false
`;

const open: TestServer[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) await server.ledger.close();
});

async function harness(team?: string) {
  const github = new FakeGitHub({ appId: APP_ID, publicKey: PUBLIC_KEY });
  github.addPull(UNCLAIMED, 101, { author: "alice" });
  const app = createGitHubApp(
    { appId: APP_ID, privateKey: PRIVATE_KEY, webhookSecret: SECRET },
    { fetch: github.fetch, log: () => {} },
  );
  const parsed = parseConfig(AUTO_APPROVE);
  if (!parsed.ok) throw new Error("bad config");
  const server = await startTestServer({
    app,
    config: async () => parsed.config,
    log: () => {},
    providers: { risk: async () => ({ level: "low", score: 1 }) },
    ...(team ? { team } : {}),
  });
  open.push(server);
  let n = 0;
  const deliver = async (event: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const res = await server.app.request(GITHUB_WEBHOOK_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": `claims-${++n}`,
        "x-github-event": event,
        "x-hub-signature-256": await signer.sign(body),
      },
      body,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const stored = async () => {
    const db = databaseOf(server.ledger);
    const [events] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM events");
    const [deliveries] = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM github_deliveries",
    );
    return { events: events?.n, deliveries: deliveries?.n };
  };
  return { server, github, deliver, stored };
}

describe("GitHub deliveries from a repository no team claimed", () => {
  it("answer handled:false for every event, with no GitHub call and no write", async () => {
    const h = await harness();
    // Another repository is claimed: what counts is the delivery's own repository.
    await claimRepos(h.server.ledger, ["acme/acme-api"]);
    for (const [event, file] of DELIVERIES) {
      const res = await h.deliver(event, from(file));
      expect(res.status, `${event} ${file}`).toBe(200);
      expect(res.json, `${event} ${file}`).toMatchObject({
        handled: false,
        skipped: `${UNCLAIMED.toLowerCase()} is not claimed by any team: add it with selfhost team repo add for GitHub deliveries to act on it`,
      });
    }
    expect(h.github.requests).toEqual([]);
    expect(await h.stored()).toEqual({ events: 0, deliveries: 0 });
  });

  it("with SELFHOST_GITHUB_TEAM, ignores a repository of another team or of none", async () => {
    const h = await harness("platform");
    await claimRepos(h.server.ledger, ["acme/acme-api"], "platform");
    await claimRepos(h.server.ledger, [UNCLAIMED], "data");
    for (const [event, file] of DELIVERIES) {
      expect((await h.deliver(event, from(file))).json).toMatchObject({
        handled: false,
        skipped: `${UNCLAIMED.toLowerCase()} belongs to team data, not platform (SELFHOST_GITHUB_TEAM)`,
      });
      expect((await h.deliver(event, from(file, "acme/elsewhere"))).json).toMatchObject({
        handled: false,
        skipped:
          "acme/elsewhere is not claimed by team platform: add it with selfhost team repo add for GitHub deliveries to act on it",
      });
    }
    expect(h.github.requests).toEqual([]);
    expect(await h.stored()).toEqual({ events: 0, deliveries: 0 });
  });

  it("acts on the same delivery once the repository is claimed", async () => {
    const h = await harness();
    await claimRepos(h.server.ledger, [UNCLAIMED]);
    const res = await h.deliver("pull_request", from("pull_request.opened.json"));
    expect(res.json).toMatchObject({ handled: true });
    expect(h.github.writes.length).toBeGreaterThan(0);
  });
});
