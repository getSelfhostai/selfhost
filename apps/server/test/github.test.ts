import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Webhooks } from "@octokit/webhooks";
import { checkExternalId, createGitHubApp, type RiskLevel } from "@selfhost/github";
import { FakeGitHub } from "@selfhost/github/testing";
import { stableEventId } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  EVENT_SCHEMA,
  type LedgerEvent,
  parseConfig,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITHUB_WEBHOOK_PATH,
  type GitHubRouteOptions,
  githubAppFromEnv,
  githubConfig,
} from "../src/github.js";
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
  options: {
    app?: boolean;
    providers?: Partial<GitHubProviders>;
    /** The server's own owner and brief providers instead of the stubs. */
    review?: boolean;
    route?: Pick<GitHubRouteOptions, "team" | "publicUrl">;
  } = {},
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
      ...(options.review ? {} : { owner: async () => state.owner, brief: async () => state.brief }),
      ...options.providers,
    },
    ...options.route,
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

const BRIEF_FIXTURES = join(GITHUB_FIXTURES, "..", "brief");
const briefRepoFile = (...parts: string[]) =>
  readFileSync(join(BRIEF_FIXTURES, "github", "repos", "acme", "acme-api", ...parts), "utf8");
const PR_142 = JSON.parse(briefRepoFile("pulls", "142.json")) as {
  html_url: string;
  title: string;
  body: string;
  base: { sha: string };
  head: { sha: string };
};
const SERVER = "https://selfhost.acme.example.com";
/** The session in the ledger that made the first commit of pull request 142. */
const SESSION = "5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87";

const OWNERS_TOML = `version = 1
[review]
github_team = "platform-reviewers"
high_risk_paths = ["src/auth/**", "db/migrations/**"]
[review.owners]
"src/auth/**" = ["bob@example.com"]
[review.github_logins]
"bob@example.com" = "bob"
"carol@example.com" = "carol"
`;

/** The recorded opened delivery, moved to pull request 142, whose recorded files have patches. */
function opened142(): Payload {
  const payload = fixture("pull_request.opened");
  const pr = payload.pull_request;
  Object.assign(pr, {
    number: 142,
    html_url: PR_142.html_url,
    title: PR_142.title,
    body: PR_142.body,
    head: { ...(pr.head as object), sha: PR_142.head.sha },
    base: { ...(pr.base as object), sha: PR_142.base.sha },
  });
  return payload;
}

/** Every event of the two sessions in the brief fixture; only one made a commit of 142. */
const runEvents = (): LedgerEvent[] =>
  (
    JSON.parse(readFileSync(join(BRIEF_FIXTURES, "agent-pr.json"), "utf8")) as {
      inputs: { run: { events: LedgerEvent[] } };
    }
  ).inputs.run.events;

/** pr.opened as PR attribution writes it, by the person whose session opened the pull request. */
const prOpened = (person: string): LedgerEvent => ({
  id: stableEventId("2026-10-12T09:30:00.000Z", `github-test:pr.opened:${PR_142.html_url}`),
  schema: EVENT_SCHEMA,
  ts: "2026-10-12T09:30:00.000Z",
  source: "github",
  kind: "pr.opened",
  actor: { kind: "person", id: person },
  repo: "acme/acme-api",
  agent: { vendor: "claude_code" },
  target: { type: "pr", value: PR_142.html_url },
  links: { pr_url: PR_142.html_url },
  data: { number: 142, files: ["docs/rate-limits.md"] },
});

/** The server's own owner and brief providers, over pull request 142 on the fake GitHub. */
async function reviewHarness(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = await harness({ review: true, route: { publicUrl: SERVER }, ...options });
  h.state.config = config(OWNERS_TOML);
  h.github.addPull(REPO, 142, {
    author: "alice",
    files: JSON.parse(briefRepoFile("pulls", "142", "files.json")),
    commits: JSON.parse(briefRepoFile("pulls", "142", "commits.json")),
  });
  for (const sha of [PR_142.base.sha, PR_142.head.sha]) {
    h.github.contents.set(
      `${REPO}@${sha}:package.json`,
      briefRepoFile("contents", sha, "package.json"),
    );
  }
  return h;
}

/** How many GETs went to paths matching `pattern`. */
const gets = (h: Harness, pattern: RegExp) =>
  h.github.requests.filter((r) => r.method === "GET" && pattern.test(r.path)).length;

describe("owner and brief from the review list", () => {
  it("posts one brief comment built from GitHub and the ledger, and requests the routed owner", async () => {
    const h = await reviewHarness();
    await h.server.ledger.append(runEvents());
    const res = await h.deliver(opened142(), { id: "d-brief" });
    expect(res).toEqual({ status: 200, json: { delivery: "d-brief", handled: true, writes: 4 } });

    const pull = h.github.pull(REPO, 142);
    // [review.owners] "src/auth/**" picks bob: the pull request changes src/auth/keys.ts.
    expect(pull.requestedUsers).toEqual(["bob"]);
    expect(pull.comments).toHaveLength(1);
    const body = pull.comments[0]?.body ?? "";
    expect(body.startsWith(`${MARKER}\n## Review brief`)).toBe(true);
    expect(body).toContain("**Add per-key rate limiting to the public API**");
    expect(body).toContain(
      `- Protected path: [\`src/auth/keys.ts:20\`](${PR_142.html_url}/files#diff-`,
    );
    expect(body).toContain("- New dependency `ioredis`");
    expect(body).toContain(`[run view](${SERVER}/runs/${SESSION})`);
    expect(body).not.toContain("0199f2a4");

    const [run] = h.github.checkRuns;
    expect(run?.output.summary).toBe(
      [
        "Agent: `claude_code`. 2 commits, 8 files, +37 -14, 1 agent session. 6 lines to look at. 2 test runs. The last run passed. 2 blocked actions.",
        "Risk is low.",
        "Review requested from @bob.",
      ].join("\n\n"),
    );
    expect(run?.output.text).toContain("### Trace");

    // One paginated call for the files and one for the commits; contents for the manifest only.
    expect(gets(h, /\/pulls\/142\/files$/)).toBe(1);
    expect(gets(h, /\/pulls\/142\/commits$/)).toBe(1);
    expect(
      h.github.requests
        .filter((r) => r.path.includes("/contents/"))
        .map((r) => `${r.path}@${r.query.ref}`)
        .sort(),
    ).toEqual(
      [PR_142.base.sha, PR_142.head.sha]
        .map((sha) => `/repos/acme/acme-api/contents/package.json@${sha}`)
        .sort(),
    );
    expect(h.github.unknown).toEqual([]);
  });

  it("reads the files and manifests once when the risk score and the brief both need them", async () => {
    const h = await reviewHarness({ providers: { risk: eeRisk() } });
    await h.deliver(opened142());
    expect(h.github.pull(REPO, 142).labels.some((l) => l.startsWith("selfhost:risk-"))).toBe(true);
    expect(h.github.pull(REPO, 142).comments).toHaveLength(1);
    expect(gets(h, /\/pulls\/142\/files$/)).toBe(1);
    expect(gets(h, /\/contents\//)).toBe(2);
  });

  it("edits the same comment on a later delivery and writes nothing else", async () => {
    const h = await reviewHarness();
    await h.server.ledger.append(runEvents());
    await h.deliver(opened142());
    const pull = h.github.pull(REPO, 142);
    const [posted] = pull.comments;
    if (!posted) throw new Error("Expected the brief comment");
    const brief = posted.body;

    posted.body = `${MARKER}\nAn older brief`;
    const before = h.github.writes.length;
    const res = await h.deliver(opened142());
    expect(res.json).toMatchObject({ handled: true, writes: 1 });
    expect(h.github.writes.slice(before).map((w) => `${w.method} ${w.path}`)).toEqual([
      `PATCH /repos/acme/acme-api/issues/comments/${posted.id}`,
    ]);
    expect(pull.comments.map((c) => c.body)).toEqual([brief]);
    expect(pull.requestedUsers).toEqual(["bob"]);

    // Nothing changed since, so the next delivery reads and writes nothing.
    expect((await h.deliver(opened142())).json).toMatchObject({ handled: true, writes: 0 });
  });

  it("briefs a pull request with no ledger sessions, saying the run data is missing", async () => {
    const h = await reviewHarness();
    await h.deliver(opened142());
    const pull = h.github.pull(REPO, 142);
    const [comment] = pull.comments;
    expect(comment?.body).toContain("No trace found: no session in the ledger made these commits.");
    expect(comment?.body).toContain("No commands known: no agent run was found.");
    expect(comment?.body).toContain("No cost known: no agent run was found.");
    expect(h.github.checkRuns[0]?.output.summary).toContain(
      "No trace found: no session in the ledger made these commits.",
    );
    // No session person either; the owner glob on the files still routes it.
    expect(pull.requestedUsers).toEqual(["bob"]);

    // The run arrives later: the same comment is rewritten with it, and the check follows.
    await h.server.ledger.append(runEvents());
    const before = h.github.writes.length;
    await h.deliver(opened142());
    expect(pull.comments.map((c) => c.id)).toEqual([comment?.id]);
    expect(pull.comments[0]?.body).toContain(`${SERVER}/runs/${SESSION}`);
    expect(h.github.writes.slice(before).map((w) => w.method)).toEqual(["PATCH", "PATCH"]);
  });

  it("asks the owner of the pull request's review item over fresh routing", async () => {
    const h = await reviewHarness();
    const { ledger } = h.server;
    await ledger.append([prOpened("carol@example.com")]);
    const list = openReviewList(ledger, { config: h.state.config });
    await refreshReviewList(ledger, list);
    // The item's own files match no [review.owners] glob, so it went to the session's person.
    expect((await list.pullRequest(PR_142.html_url))?.owners).toEqual(["carol@example.com"]);

    await h.deliver(opened142());
    expect(h.github.pull(REPO, 142).requestedUsers).toEqual(["carol"]);
    expect(h.github.checkRuns[0]?.output.summary).toContain("Review requested from @carol.");

    // A team's delivery reads only that team's items; this one has no team, so routing decides.
    const teamed = await reviewHarness({ route: { publicUrl: SERVER, team: "platform" } });
    await teamed.server.ledger.append([prOpened("carol@example.com")]);
    await refreshReviewList(
      teamed.server.ledger,
      openReviewList(teamed.server.ledger, { config: teamed.state.config }),
    );
    await teamed.deliver(opened142());
    expect(teamed.github.pull(REPO, 142).requestedUsers).toEqual(["bob"]);
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
