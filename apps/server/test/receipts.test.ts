import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGitHubApp } from "@selfhost/github";
import { FakeGitHub } from "@selfhost/github/testing";
import type { Receipt } from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import type { OidcVerifier } from "../src/oidc.js";
import { RECEIPTS_PATH } from "../src/receipts.js";
import { startTestServer, type TestServer, TOKEN } from "./helpers.js";

const REPO = "acme/acme-web";
const HEAD = "5786c5c9d81ca4218b7e44bf0007f5580f66c489";
const BASE = "c3b8739bdcca2b4e2f5bdead2a8f238916813446";
const NEXT_HEAD = "b2e4f6a8c0d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9";
const PUBLIC_URL = "https://selfhost.example.com";
const RECEIPT_MARKER = "<!-- selfhost:receipt v1 -->";
const BRIEF_MARKER = "<!-- selfhost:brief v1 -->";
const OIDC = "oidc-token-for-acme-web";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const APP_ID = "123456";

const receiptFixture = (): Receipt =>
  JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../../packages/schema/fixtures/receipt/valid/passed-with-preview.json",
      ),
      "utf8",
    ),
  );

/** Accepts OIDC as a token for acme/acme-web's pull request 42 run, at this server's URL. */
function fakeOidc(
  claims: { repository: string; ref?: string } = { repository: REPO, ref: "refs/pull/42/merge" },
) {
  const audiences: string[] = [];
  const verifier: OidcVerifier = {
    async verify(token, audience) {
      audiences.push(audience);
      return token === OIDC ? { ok: true, claims } : { ok: false, reason: "bad signature" };
    },
  };
  return { verifier, audiences };
}

interface Harness {
  server: TestServer;
  github: FakeGitHub;
  lines: string[];
  audiences: string[];
  post(body: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }>;
}

const open: TestServer[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) await server.ledger.close();
});

async function harness(
  options: {
    app?: boolean;
    ee?: boolean;
    claims?: { repository: string; ref?: string };
    installed?: boolean;
    headRef?: string;
  } = {},
): Promise<Harness> {
  const github = new FakeGitHub({
    appId: APP_ID,
    publicKey: PUBLIC_KEY,
    installationOf: (repo) => (options.installed === false || repo !== REPO ? undefined : 7),
  });
  github.addPull(REPO, 42, {
    author: "claude[bot]",
    title: "Add the billing settings page",
    body: "Adds the billing page.",
    head: { sha: HEAD, ref: options.headRef ?? "claude/billing-page" },
    base: { sha: BASE, ref: "main" },
  });
  const lines: string[] = [];
  const app = createGitHubApp(
    { appId: APP_ID, privateKey: PRIVATE_KEY, webhookSecret: "secret" },
    { fetch: github.fetch, log: (line) => lines.push(line) },
  );
  const { verifier, audiences } = fakeOidc(options.claims);
  const server = await startTestServer(
    {
      ...(options.app === false ? {} : { app }),
      publicUrl: PUBLIC_URL,
      log: (line) => lines.push(line),
      // Risk is scored by ee/risk in other tests; here only the brief matters.
      providers: { risk: async () => undefined },
    },
    { oidc: verifier, ...(options.ee === false ? { load: async () => undefined } : {}) },
  );
  open.push(server);
  return {
    server,
    github,
    lines,
    audiences,
    async post(body, token = OIDC) {
      const response = await server.app.request(RECEIPTS_PATH, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    },
  };
}

const comments = (h: Harness) => h.github.pull(REPO, 42).comments;
const receiptComment = (h: Harness) => comments(h).find((c) => c.body.includes(RECEIPT_MARKER));
const briefComment = (h: Harness) => comments(h).find((c) => c.body.includes(BRIEF_MARKER));

describe("POST /v1/receipts", () => {
  it("stores the receipt, comments it on the pull request and links it from the brief", async () => {
    const h = await harness();
    const { status, json } = await h.post(receiptFixture());
    expect(status).toBe(201);
    const id = String(json.id);
    const receipt = receiptComment(h);
    expect(json).toEqual({
      id,
      url: `${PUBLIC_URL}/v1/receipts/${id}`,
      comment_url: receipt?.html_url,
      brief: "updated",
    });
    expect(h.audiences).toEqual([PUBLIC_URL]);

    expect(receipt?.user.type).toBe("Bot");
    expect(receipt?.body.startsWith(`${RECEIPT_MARKER}\n## Proof receipt`)).toBe(true);
    expect(receipt?.body).toContain(`[Stored receipt](${PUBLIC_URL}/v1/receipts/${id})`);

    const brief = briefComment(h)?.body ?? "";
    expect(brief).toContain("## Review brief");
    expect(brief).toContain(
      "### Proof receipt\n\n**Passed. 1 test run passed, 1 screen captured, preview ready.**",
    );
    expect(brief).toContain(`[Full receipt](${receipt?.html_url})`);
    expect(brief).toContain("[Preview](https://acme-web-git-agent-billing-acme.vercel.app)");
    const check = h.github.checkRuns[0];
    expect(check?.output.summary).toContain(
      "Proof receipt: Passed. 1 test run passed, 1 screen captured, preview ready.",
    );

    const stored = await h.server.request(`${RECEIPTS_PATH}/${id}`);
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({
      id,
      repo: REPO,
      pull: 42,
      head_sha: HEAD,
      comment_url: receipt?.html_url,
      receipt: receiptFixture(),
    });
  });

  it("edits the same comments when the next CI run posts again", async () => {
    const h = await harness();
    await h.post(receiptFixture());
    const failed = receiptFixture();
    failed.verdict = "failed";
    failed.tests.runs[0] = {
      ...failed.tests.runs[0],
      status: "failed",
      exit_code: 1,
    } as Receipt["tests"]["runs"][number];
    expect((await h.post(failed)).status).toBe(201);
    expect(comments(h)).toHaveLength(2);
    expect(receiptComment(h)?.body).toContain("**Failed. 1 of 1 test run failed");
    expect(briefComment(h)?.body).toContain("**Failed. 1 of 1 test run failed");
  });

  it("only stores a receipt for a commit that is no longer the head", async () => {
    const h = await harness();
    const old = receiptFixture();
    old.pull.head_sha = NEXT_HEAD;
    const { status, json } = await h.post(old);
    expect(status).toBe(202);
    expect(json.brief).toBe("stale");
    expect(comments(h)).toEqual([]);
    expect(await h.server.ledger.receipts.latest(REPO, 42)).toMatchObject({ head_sha: NEXT_HEAD });
  });

  it("comments a receipt on a pull request that is not an agent's, with no brief", async () => {
    const h = await harness({ headRef: "feature/billing" });
    h.github.pull(REPO, 42).author = "alice";
    const { status, json } = await h.post(receiptFixture());
    expect(status).toBe(201);
    expect(json.brief).toBe("not_agent_pr");
    expect(comments(h).map((c) => c.body.split("\n")[0])).toEqual([RECEIPT_MARKER]);
  });

  it("needs the job's OIDC token, not a selfhost token", async () => {
    const h = await harness();
    const missing = await h.server.app.request(RECEIPTS_PATH, {
      method: "POST",
      body: JSON.stringify(receiptFixture()),
    });
    expect(missing.status).toBe(401);
    const admin = await h.post(receiptFixture(), TOKEN);
    expect(admin).toEqual({
      status: 401,
      json: {
        error: { code: "unauthorized", message: "The GitHub Actions OIDC token: bad signature" },
      },
    });
    expect(comments(h)).toEqual([]);
  });

  it("refuses a receipt for another repository or another pull request than the token's", async () => {
    const other = await harness({ claims: { repository: "acme/other", ref: "refs/heads/main" } });
    expect(await other.post(receiptFixture())).toEqual({
      status: 403,
      json: {
        error: {
          code: "forbidden",
          message:
            "The token is for acme/other, not acme/acme-web: a workflow posts receipts only for its own repository",
        },
      },
    });
    const pull = await harness({
      claims: { repository: "ACME/acme-web", ref: "refs/pull/41/merge" },
    });
    expect((await pull.post(receiptFixture())).json).toEqual({
      error: { code: "forbidden", message: "The token is for pull request #41, not #42" },
    });
  });

  it("refuses a repository the GitHub App is not installed on", async () => {
    const h = await harness({ installed: false });
    expect(await h.post(receiptFixture())).toEqual({
      status: 403,
      json: {
        error: {
          code: "forbidden",
          message: "The selfhost GitHub App is not installed on acme/acme-web",
        },
      },
    });
    expect(await h.server.ledger.receipts.latest(REPO, 42)).toBeUndefined();
  });

  it("refuses a receipt that does not match the schema", async () => {
    const h = await harness();
    const { status, json } = await h.post({ ...receiptFixture(), verdict: "green" });
    expect(status).toBe(400);
    expect(json).toMatchObject({ error: { code: "invalid_request" } });
    expect(String((json.error as { message: string }).message)).toMatch(/^verdict: /);
  });

  it("answers 404 for a missing pull request", async () => {
    const h = await harness();
    const receipt = receiptFixture();
    receipt.pull.number = 43;
    const missing = await harness({ claims: { repository: REPO } });
    expect((await missing.post(receipt)).status).toBe(404);
    expect(h).toBeTruthy();
  });

  it("is absent without the GitHub App or without ee/", async () => {
    expect((await (await harness({ app: false })).post(receiptFixture())).status).toBe(404);
    expect((await (await harness({ ee: false })).post(receiptFixture())).status).toBe(404);
  });
});

describe("GET /v1/receipts/{id}", () => {
  it("needs the admin token and answers 404 for an unknown id", async () => {
    const h = await harness();
    const { json } = await h.post(receiptFixture());
    const anonymous = await h.server.app.request(`${RECEIPTS_PATH}/${json.id}`);
    expect(anonymous.status).toBe(401);
    expect(
      (await h.server.request(`${RECEIPTS_PATH}/00000000-0000-4000-8000-000000000000`)).status,
    ).toBe(404);
    expect((await h.server.request(`${RECEIPTS_PATH}/nope`)).status).toBe(404);
  });
});
