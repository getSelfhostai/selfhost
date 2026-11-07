import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Webhooks } from "@octokit/webhooks";
import { checkExternalId, createGitHubApp, type RiskLevel } from "@selfhost/github";
import { FakeGitHub } from "@selfhost/github/testing";
import { parseConfig, type ResolvedSelfhostConfig } from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import { GITHUB_WEBHOOK_PATH, githubAppFromEnv, githubConfig } from "../src/github.js";
import type { GitHubProviders, ReviewBrief } from "../src/github-pull.js";
import { eeRisk } from "../src/github-risk.js";
import { startTestServer, type TestServer } from "./helpers.js";

const GITHUB_FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures", "github");
const REPO = "acme/acme-api";
const HEAD = "5786c5c9d81ca4218b7e44bf0007f5580f66c489";
const NEXT_HEAD = "b2e4f6a8c0d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9";
const BASE = "c3b8739bdcca2b4e2f5bdead2a8f238916813446";
const MARKER = "<!-- selfhost:brief v1 -->";

// A key made for this run only, PKCS#1 as GitHub hands out App keys.
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const APP_ID = "123456";
const SECRET = "test-webhook-secret";
const signer = new Webhooks({ secret: SECRET });

const REVIEW_TOML = `version = 1
[review]
github_team = "platform-reviewers"
[review.github_logins]
"bob@example.com" = "bob"
"alice@example.com" = "alice"
`;

function config(toml = REVIEW_TOML): ResolvedSelfhostConfig {
  const parsed = parseConfig(toml);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
}

/** A webhook fixture, with the fields tests change. */
interface Payload {
  action?: string;
  pull_request: { state: string; draft: boolean; [field: string]: unknown };
  sender: { login: string; type: string; [field: string]: unknown };
  [field: string]: unknown;
}

const fixture = (name: string): Payload =>
  JSON.parse(readFileSync(join(GITHUB_FIXTURES, "webhooks", `${name}.json`), "utf8"));

const repoFile = (...parts: string[]) =>
  readFileSync(join(GITHUB_FIXTURES, "repos", "acme", "acme-api", ...parts), "utf8");

interface Harness {
  server: TestServer;
  github: FakeGitHub;
  lines: string[];
  /** What the providers return; tests change them between deliveries. */
  state: { risk?: RiskLevel; owner?: string; brief?: ReviewBrief; config: ResolvedSelfhostConfig };
  deliver(
    payload: Payload | string,
    options?: { id?: string; event?: string; signature?: string },
  ): Promise<{ status: number; json: Record<string, unknown> }>;
}

const open: TestServer[] = [];

afterEach(async () => {
  for (const server of open.splice(0)) await server.ledger.close();
});

let deliveries = 0;

async function harness(
  options: { app?: boolean; providers?: Partial<GitHubProviders> } = {},
): Promise<Harness> {
  const github = new FakeGitHub({ appId: APP_ID, publicKey: PUBLIC_KEY });
  github.addPull(REPO, 101, { author: "alice" });
  github.addPull(REPO, 106, { author: "bob" });
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const state: Harness["state"] = { risk: "low", config: config() };
  const app = createGitHubApp(
    { appId: APP_ID, privateKey: PRIVATE_KEY, webhookSecret: SECRET },
    { fetch: github.fetch, log },
  );
  const server = await startTestServer({
    ...(options.app === false ? {} : { app }),
    config: async () => state.config,
    log,
    providers: {
      risk: async () =>
        state.risk && {
          level: state.risk,
          title: `${state.risk} risk`,
          summary: `Risk is ${state.risk}.`,
          text: "| Input | Points |",
        },
      owner: async () => state.owner,
      brief: async () => state.brief,
      ...options.providers,
    },
  });
  open.push(server);
  return {
    server,
    github,
    lines,
    state,
    async deliver(
      payload,
      { id = `delivery-${++deliveries}`, event = "pull_request", signature } = {},
    ) {
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      // No bearer token: the signature is the credential.
      const res = await server.app.request(GITHUB_WEBHOOK_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": id,
          "x-github-event": event,
          "x-hub-signature-256": signature ?? (await signer.sign(body)),
        },
        body,
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    },
  };
}

describe("POST /v1/github/webhooks", () => {
  it("answers 404 when no GitHub App is configured", async () => {
    const h = await harness({ app: false });
    const res = await h.deliver(fixture("pull_request.opened"), { signature: "sha256=00" });
    expect(res).toEqual({
      status: 404,
      json: { error: { code: "not_found", message: `No route for POST ${GITHUB_WEBHOOK_PATH}` } },
    });
    expect(h.github.requests).toEqual([]);
  });

  it("refuses a delivery whose signature does not match, and writes nothing", async () => {
    const h = await harness();
    const body = JSON.stringify(fixture("pull_request.opened"));
    const forged = await new Webhooks({ secret: "not-the-secret" }).sign(body);
    for (const signature of [forged, "sha256=00", ""]) {
      const res = await h.deliver(body, { signature });
      expect(res.status).toBe(401);
      expect(res.json).toMatchObject({ error: { code: "invalid_signature" } });
    }
    const tampered = body.replace("Add per-key rate limiting", "Something else");
    expect((await h.deliver(tampered, { signature: await signer.sign(body) })).status).toBe(401);
    expect(h.github.requests).toEqual([]);
  });

  it("needs the delivery and event headers", async () => {
    const h = await harness();
    const res = await h.deliver(fixture("pull_request.opened"), { id: "" });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: { code: "invalid_webhook" } });
  });

  it("labels an opened agent pull request, posts the check and brief, and requests review", async () => {
    const h = await harness();
    h.state.owner = "bob@example.com";
    h.state.brief = {
      body: `${MARKER}\n## Review brief\n\nToken bucket per key.`,
      marker: MARKER,
      summary: "Adds a per-key token bucket.",
    };
    const res = await h.deliver(fixture("pull_request.opened"), { id: "d-open" });
    expect(res).toEqual({ status: 200, json: { delivery: "d-open", handled: true, writes: 4 } });

    const pull = h.github.pull(REPO, 101);
    expect(pull.labels).toEqual(["selfhost:risk-low", "selfhost:agent-claude-code"]);
    expect(pull.requestedUsers).toEqual(["bob"]);
    expect(pull.comments.map((c) => c.body)).toEqual([h.state.brief.body]);
    expect(h.github.checkRuns).toHaveLength(1);
    const [run] = h.github.checkRuns;
    expect(run).toMatchObject({
      name: "selfhost/review",
      head_sha: HEAD,
      external_id: checkExternalId({ owner: "acme", repo: "acme-api", number: 101, headSha: HEAD }),
      conclusion: "neutral",
      output: { title: "low risk" },
    });
    expect(run?.output.summary).toBe(
      "Adds a per-key token bucket.\n\nRisk is low.\n\nReview requested from @bob.",
    );
    expect(run?.output.text).toContain("## Review brief");
    expect(run?.output.text).not.toContain(MARKER);
    expect(h.github.unknown).toEqual([]);
    expect(h.github.tokensIssued).toBe(1);
  });

  it("changes nothing when the same delivery arrives twice", async () => {
    const h = await harness();
    h.state.owner = "bob@example.com";
    const payload = fixture("pull_request.opened");
    await h.deliver(payload, { id: "d-twice" });
    const requests = h.github.requests.length;
    const again = await h.deliver(payload, { id: "d-twice" });
    expect(again).toEqual({
      status: 200,
      json: { delivery: "d-twice", handled: false, duplicate: true },
    });
    // Not even a read: the delivery id alone answers it.
    expect(h.github.requests).toHaveLength(requests);
    expect(h.github.checkRuns).toHaveLength(1);
    expect(h.github.pull(REPO, 101).labels).toHaveLength(2);
    expect(h.github.pull(REPO, 101).requestedUsers).toEqual(["bob"]);
  });

  it("writes nothing for a new delivery when nothing changed", async () => {
    const h = await harness();
    h.state.owner = "bob@example.com";
    h.state.brief = { body: `${MARKER}\nBrief`, marker: MARKER };
    await h.deliver(fixture("pull_request.opened"));
    const writes = h.github.writes.length;
    const res = await h.deliver(fixture("pull_request.opened"));
    expect(res.json).toMatchObject({ handled: true, writes: 0 });
    expect(h.github.writes).toHaveLength(writes);
  });

  it("swaps the risk label and makes one check run per head commit", async () => {
    const h = await harness();
    await h.deliver(fixture("pull_request.opened"));
    h.state.risk = "high";
    const res = await h.deliver(fixture("pull_request.synchronize"));
    expect(res.json).toMatchObject({ handled: true });
    expect(h.github.pull(REPO, 101).labels).toEqual([
      "selfhost:agent-claude-code",
      "selfhost:risk-high",
    ]);
    const removed = h.github.writes.filter((w) => w.method === "DELETE").map((w) => w.path);
    expect(removed).toEqual(["/repos/acme/acme-api/issues/101/labels/selfhost:risk-low"]);
    expect(h.github.checkRuns.map((run) => [run.head_sha, run.conclusion])).toEqual([
      [HEAD, "neutral"],
      [NEXT_HEAD, "neutral"],
    ]);
    expect(h.github.checkRuns[1]?.output.summary).toContain(
      "set [review] block_merge_on_high = true",
    );

    // Opting in fails the check on high risk; the run on the same head is updated, not added.
    h.state.config = config(
      REVIEW_TOML.replace("[review]\n", "[review]\nblock_merge_on_high = true\n"),
    );
    await h.deliver(fixture("pull_request.synchronize"));
    expect(h.github.checkRuns.map((run) => [run.head_sha, run.conclusion])).toEqual([
      [HEAD, "neutral"],
      [NEXT_HEAD, "failure"],
    ]);
  });

  it("asks the team when the owner has no GitHub login, as routing falls back", async () => {
    const h = await harness();
    h.state.owner = "dave@example.com";
    await h.deliver(fixture("pull_request.opened"));
    const pull = h.github.pull(REPO, 101);
    expect(pull.requestedUsers).toEqual([]);
    expect(pull.requestedTeams).toEqual(["platform-reviewers"]);
    expect(h.github.checkRuns[0]?.output.summary).toContain(
      "The owner has no GitHub login in [review] github_logins, so review is requested from @acme/platform-reviewers.",
    );
  });

  it("asks the team when the owner opened the pull request, and nobody without a team", async () => {
    const h = await harness();
    h.state.owner = "alice@example.com";
    await h.deliver(fixture("pull_request.opened"));
    expect(h.github.pull(REPO, 101).requestedTeams).toEqual(["platform-reviewers"]);

    const bare = await harness();
    bare.state.config = config("version = 1\n");
    await bare.deliver(fixture("pull_request.opened"));
    expect(bare.github.writes.some((w) => w.path.endsWith("/requested_reviewers"))).toBe(false);
    expect(bare.github.checkRuns[0]?.output.summary).toContain(
      "No owner was picked and [review] github_team is not set.",
    );
  });

  it("edits the brief comment in place", async () => {
    const h = await harness();
    h.state.brief = { body: `${MARKER}\nFirst brief`, marker: MARKER };
    await h.deliver(fixture("pull_request.opened"));
    h.state.brief = { body: `${MARKER}\nSecond brief`, marker: MARKER };
    await h.deliver(fixture("pull_request.synchronize"));
    const comments = h.github.pull(REPO, 101).comments;
    expect(comments.map((c) => c.body)).toEqual([`${MARKER}\nSecond brief`]);
    const commentWrites = h.github.writes
      .filter((w) => w.path.includes("comments"))
      .map((w) => w.method);
    expect(commentWrites).toEqual(["POST", "PATCH"]);
  });

  it("puts a risk label set by hand back to the scored one", async () => {
    const h = await harness();
    await h.deliver(fixture("pull_request.opened"));
    h.github.pull(REPO, 101).labels.push("selfhost:risk-medium");
    const res = await h.deliver(fixture("pull_request.labeled"));
    expect(res.json).toMatchObject({ handled: true, writes: 1 });
    expect(h.github.pull(REPO, 101).labels).toEqual([
      "selfhost:risk-low",
      "selfhost:agent-claude-code",
    ]);
  });

  it("leaves pull requests by people, bot labels, closed pull requests and other events alone", async () => {
    const h = await harness();
    const byBot = fixture("pull_request.labeled");
    byBot.sender = { login: "selfhost[bot]", id: 9000001, type: "Bot" };
    const closed = fixture("pull_request.synchronize");
    closed.pull_request.state = "closed";
    const edited = { ...fixture("pull_request.opened"), action: "edited" };
    const skipped = [];
    for (const payload of [fixture("pull_request.opened.person"), byBot, closed, edited]) {
      const { json } = await h.deliver(payload);
      expect(json).toMatchObject({ handled: false });
      skipped.push(json.skipped);
    }
    expect(skipped).toEqual([
      "not an agent pull request",
      "labeled by a bot",
      "the pull request is not open",
      "action edited is not handled",
    ]);
    const comment = fixture("issue_comment.created");
    expect((await h.deliver(comment, { event: "issue_comment" })).json).toMatchObject({
      handled: false,
    });
    expect(
      (await h.deliver(JSON.stringify({ zen: "Design for failure." }), { event: "ping" })).status,
    ).toBe(200);
    expect(h.github.requests).toEqual([]);
  });

  it("requests no review on a draft", async () => {
    const h = await harness();
    h.state.owner = "bob@example.com";
    const draft = fixture("pull_request.opened");
    draft.pull_request.draft = true;
    await h.deliver(draft);
    expect(h.github.pull(REPO, 101).requestedUsers).toEqual([]);
    expect(h.github.checkRuns[0]?.output.summary).toContain("Draft: no review is requested");
  });

  it("forgets a delivery whose sync failed, so GitHub's redelivery runs it", async () => {
    const h = await harness();
    h.github.failNext("POST", /\/check-runs$/, 502);
    const failed = await h.deliver(fixture("pull_request.opened"), { id: "d-retry" });
    expect(failed).toEqual({
      status: 500,
      json: {
        error: {
          code: "github_sync_failed",
          message: "Could not sync acme/acme-api#101 on GitHub",
        },
      },
    });
    const retried = await h.deliver(fixture("pull_request.opened"), { id: "d-retry" });
    // The labels landed before the failure; the rerun adds the check and the team request.
    expect(retried.json).toMatchObject({ handled: true, writes: 2 });
    expect(h.github.checkRuns).toHaveLength(1);
    expect(h.github.pull(REPO, 101).labels).toHaveLength(2);
    expect(h.lines.some((l) => l.includes("delivery d-retry for acme/acme-api#101 failed"))).toBe(
      true,
    );
  });

  it("logs ids and counts, never secrets or payload text", async () => {
    const h = await harness();
    h.state.brief = { body: `${MARKER}\nBrief text`, marker: MARKER };
    h.github.failNext("POST", /\/check-runs$/, 500);
    await h.deliver(fixture("pull_request.opened"));
    await h.deliver(fixture("pull_request.opened"));
    await h.deliver(fixture("pull_request.opened"), { signature: "sha256=00" });
    const logged = h.lines.join("\n");
    expect(logged).toContain("pull_request.opened acme/acme-api#101");
    for (const secret of [
      SECRET,
      "PRIVATE KEY",
      "fake-installation-token",
      "Add per-key",
      "Brief text",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe("risk from ee", () => {
  it("scores the pull request's files and dependencies with ee/risk", async () => {
    const h = await harness({ providers: { risk: eeRisk() } });
    const pull = h.github.pull(REPO, 101);
    pull.files = JSON.parse(repoFile("pulls", "101", "files.json"));
    h.github.contents.set(
      `${REPO}@${BASE}:package.json`,
      repoFile("contents", BASE, "package.json"),
    );
    h.github.contents.set(
      `${REPO}@${HEAD}:package.json`,
      repoFile("contents", HEAD, "package.json"),
    );
    await h.deliver(fixture("pull_request.opened"));

    const risk = pull.labels.find((label) => label.startsWith("selfhost:risk-"));
    expect(risk).toMatch(/^selfhost:risk-(low|medium|high)$/);
    const [run] = h.github.checkRuns;
    expect(run?.output.title).toMatch(/^(Low|Medium|High) risk \(score \d+\)$/);
    expect(run?.output.text).toContain("| Input | Points | Found |");
    expect(run?.output.text).toContain("New dependencies");
    expect(run?.output.summary).toContain("no sandbox run yet");

    // The same files score the same, so a second delivery changes nothing.
    const writes = h.github.writes.length;
    await h.deliver(fixture("pull_request.opened"));
    expect(h.github.writes).toHaveLength(writes);
  });

  it("puts no risk label on when the build has no ee/", async () => {
    const h = await harness({ providers: { risk: eeRisk(async () => undefined) } });
    await h.deliver(fixture("pull_request.opened"));
    expect(h.github.pull(REPO, 101).labels).toEqual(["selfhost:agent-claude-code"]);
    expect(h.github.checkRuns[0]).toMatchObject({
      conclusion: "neutral",
      output: { title: "Not scored" },
    });
  });
});

describe("GitHub App settings", () => {
  it("names the variables a partial setup lacks, and is off when none are set", () => {
    const lines: string[] = [];
    expect(githubAppFromEnv({}, (l) => lines.push(l))).toBeUndefined();
    expect(lines).toEqual([]);
    const partial = { SELFHOST_GITHUB_APP_ID: APP_ID, SELFHOST_GITHUB_WEBHOOK_SECRET: SECRET };
    expect(githubAppFromEnv(partial, (l) => lines.push(l))).toBeUndefined();
    expect(lines).toEqual([
      "GitHub App: SELFHOST_GITHUB_PRIVATE_KEY or SELFHOST_GITHUB_PRIVATE_KEY_FILE not set, so POST /v1/github/webhooks answers 404",
    ]);
    expect(
      githubAppFromEnv({ ...partial, SELFHOST_GITHUB_PRIVATE_KEY: PRIVATE_KEY }, (l) =>
        lines.push(l),
      ),
    ).toBeDefined();
  });

  it("reads [review] from the team's stored policy when one is named", async () => {
    const h = await harness();
    const { ledger } = h.server;
    const defaults = config("version = 1\n");
    expect(await githubConfig(ledger, defaults, undefined)()).toBe(defaults);
    expect(await githubConfig(ledger, defaults, "platform")()).toBe(defaults);
    await ledger.teams.createTeam({ id: "platform", name: "Platform" });
    await ledger.teams.setPolicy("platform", REVIEW_TOML);
    const team = await githubConfig(ledger, defaults, "platform")();
    expect(team.review.github_team).toBe("platform-reviewers");
  });
});
