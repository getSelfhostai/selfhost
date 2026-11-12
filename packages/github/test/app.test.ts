import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import { Webhooks } from "@octokit/webhooks";
import { afterAll, describe, expect, it } from "vitest";
import {
  createGitHubApp,
  GITHUB_APP_ENV,
  githubAppEnv,
  RUN_TOKEN_PERMISSIONS,
} from "../src/index.js";
import { FakeGitHub } from "../src/testing.js";

// A key made for this run only, PKCS#1 as GitHub hands out App keys.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const SECRET = "test-webhook-secret";
const dir = mkdtempSync(join(tmpdir(), "selfhost-github-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("githubAppEnv", () => {
  it("is unset with every variable named when nothing is set", () => {
    expect(githubAppEnv({})).toEqual({
      missing: [
        "SELFHOST_GITHUB_APP_ID",
        "SELFHOST_GITHUB_PRIVATE_KEY or SELFHOST_GITHUB_PRIVATE_KEY_FILE",
        "SELFHOST_GITHUB_WEBHOOK_SECRET",
      ],
    });
  });

  it("names only what is missing and never a value", () => {
    const result = githubAppEnv({
      [GITHUB_APP_ENV.appId]: "123",
      [GITHUB_APP_ENV.privateKey]: pem,
    });
    expect(result).toEqual({ missing: ["SELFHOST_GITHUB_WEBHOOK_SECRET"] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY-----");
  });

  it("reads the key from a file, or from one line with \\n escapes", () => {
    const file = join(dir, "app.pem");
    writeFileSync(file, pem);
    const env = { [GITHUB_APP_ENV.appId]: " 123 ", [GITHUB_APP_ENV.webhookSecret]: SECRET };
    expect(githubAppEnv({ ...env, [GITHUB_APP_ENV.privateKeyFile]: file })).toEqual({
      credentials: { appId: "123", privateKey: pem.trim(), webhookSecret: SECRET },
      missing: [],
    });
    const oneLine = pem.trim().replaceAll("\n", "\\n");
    expect(
      githubAppEnv({ ...env, [GITHUB_APP_ENV.privateKey]: oneLine }).credentials?.privateKey,
    ).toBe(pem.trim());
  });

  it("fails on an unreadable key file without printing its content", () => {
    expect(() =>
      githubAppEnv({ [GITHUB_APP_ENV.privateKeyFile]: join(dir, "missing.pem") }),
    ).toThrow(/SELFHOST_GITHUB_PRIVATE_KEY_FILE: cannot read .*missing\.pem \(ENOENT\)/);
  });
});

describe("createGitHubApp", () => {
  const credentials = { appId: "123", privateKey: pem, webhookSecret: SECRET };

  it("accepts the signature GitHub sends and rejects anything else", async () => {
    const app = createGitHubApp(credentials);
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const signature = await new Webhooks({ secret: SECRET }).sign(body);
    const wrong = await new Webhooks({ secret: "another-secret" }).sign(body);
    expect(await app.verify(body, signature)).toBe(true);
    expect(await app.verify(`${body} `, signature)).toBe(false);
    expect(await app.verify(body, wrong)).toBe(false);
    expect(await app.verify(body, "sha256=abc")).toBe(false);
    expect(await app.verify(body, undefined)).toBe(false);
    expect(await app.verify("", signature)).toBe(false);
  });

  it("signs a JWT for the installation token and reuses the token", async () => {
    const github = new FakeGitHub({
      appId: "123",
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    github.addPull("acme/acme-api", 101, { author: "alice", labels: ["bug"] });
    const app = createGitHubApp(credentials, { fetch: github.fetch });
    const octokit = app.installation(42);
    expect(app.installation(42)).toBe(octokit);
    const issue = { owner: "acme", repo: "acme-api", issue_number: 101 };
    const { data } = await octokit.rest.issues.listLabelsOnIssue(issue);
    await octokit.rest.issues.listLabelsOnIssue(issue);
    expect(data.map((label) => label.name)).toEqual(["bug"]);
    expect(github.tokensIssued).toBe(1);
    expect(github.requests[0]?.path).toBe("/app/installations/42/access_tokens");
  });

  it("finds the App's installation on a repository, signed with its key", async () => {
    const github = new FakeGitHub({
      appId: "123",
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      installationOf: (repo) => (repo === "acme/acme-web" ? 77 : undefined),
    });
    const app = createGitHubApp(credentials, { fetch: github.fetch });
    expect(await app.repoInstallation("acme", "acme-web")).toBe(77);
    expect(await app.repoInstallation("acme", "elsewhere")).toBeUndefined();
    expect(github.requests.map((r) => r.path)).toEqual([
      "/repos/acme/acme-web/installation",
      "/repos/acme/elsewhere/installation",
    ]);
  });

  it("gets no token with a key that is not the App's", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const github = new FakeGitHub({ appId: "123", publicKey: other.publicKey });
    const lines: string[] = [];
    const app = createGitHubApp(credentials, { fetch: github.fetch, log: (l) => lines.push(l) });
    await expect(
      app
        .installation(42)
        .rest.issues.listLabelsOnIssue({ owner: "a", repo: "b", issue_number: 1 }),
    ).rejects.toMatchObject({ status: 401 });
    expect(lines.join("\n")).not.toContain("PRIVATE KEY");
  });
});

describe("GitHub calls that get no answer", () => {
  const credentials = { appId: "123", privateKey: pem, webhookSecret: SECRET };
  /** A fetch that never answers but stops when its signal aborts, counting calls by method. */
  const hanging = () => {
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }) as typeof globalThis.fetch;
    return { calls, fetch };
  };

  it("fails a call after its timeout, trying a GET again with backoff and a POST only once", async () => {
    const { calls, fetch } = hanging();
    const app = createGitHubApp(credentials, { fetch, timeoutMs: 30, retries: 2, backoffMs: 1 });
    await expect(app.repoInstallation("acme", "acme-api")).rejects.toThrow(
      "GET /repos/acme/acme-api/installation: GitHub did not answer in 0s",
    );
    expect(calls).toEqual([
      "GET /repos/acme/acme-api/installation",
      "GET /repos/acme/acme-api/installation",
      "GET /repos/acme/acme-api/installation",
    ]);
    calls.length = 0;
    const octokit = app.installation(42);
    await expect(
      octokit.rest.issues.createComment({ owner: "a", repo: "b", issue_number: 1, body: "x" }),
    ).rejects.toThrow("POST /app/installations/42/access_tokens");
    expect(calls).toEqual(["POST /app/installations/42/access_tokens"]);
  });

  it("tries a GET again after a 502 and returns the answer that came", async () => {
    let answered = 0;
    const github = new FakeGitHub({
      appId: "123",
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      installationOf: () => 77,
    });
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      answered++;
      if (answered === 1) return new Response("bad gateway", { status: 502 });
      return github.fetch(String(input), init);
    }) as typeof globalThis.fetch;
    const app = createGitHubApp(credentials, { fetch: flaky, backoffMs: 1 });
    expect(await app.repoInstallation("acme", "acme-api")).toBe(77);
    expect(answered).toBe(2);
  });

  it("aborts calls in flight on close, and refuses new ones", async () => {
    const { fetch } = hanging();
    const app = createGitHubApp(credentials, { fetch, timeoutMs: 60_000 });
    const pending = app.repoInstallation("acme", "acme-api");
    setTimeout(() => app.close(), 10);
    await expect(pending).rejects.toThrow("the server is shutting down");
    await expect(app.repoInstallation("acme", "acme-web")).rejects.toThrow(
      "the server is shutting down",
    );
  });
});

describe("run tokens", () => {
  const credentials = { appId: "123", privateKey: pem, webhookSecret: SECRET };
  const fake = () =>
    new FakeGitHub({
      appId: "123",
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      installationOf: (repo) => (repo.startsWith("acme/") ? 42 : undefined),
      repositoriesOf: () => ["acme-api", "acme-web"],
    });
  const asToken = (github: FakeGitHub, token: string) =>
    new Octokit({ auth: token, request: { fetch: github.fetch } });

  it("asks GitHub for the run's one repository and the least permissions", async () => {
    const github = fake();
    const app = createGitHubApp(credentials, { fetch: github.fetch });
    const run = await app.runToken("acme", "acme-api");
    expect(run).toMatchObject({
      installationId: 42,
      repository: "acme/acme-api",
      permissions: RUN_TOKEN_PERMISSIONS,
    });
    const minted = github.requests.find((r) => r.path === "/app/installations/42/access_tokens");
    expect(minted?.body).toEqual({
      repositories: ["acme-api"],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    });
  });

  it("works on the run's repository and fails on every other one of the installation", async () => {
    const github = fake();
    const app = createGitHubApp(credentials, { fetch: github.fetch });
    const { token } = await app.runToken("acme", "acme-api");
    const octokit = asToken(github, token);
    await expect(
      octokit.rest.repos.get({ owner: "acme", repo: "acme-api" }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(octokit.rest.repos.get({ owner: "acme", repo: "acme-web" })).rejects.toMatchObject(
      { status: 404 },
    );
  });

  it("is refused once revoked, and a second revoke says so", async () => {
    const github = fake();
    const app = createGitHubApp(credentials, { fetch: github.fetch });
    const { token } = await app.runToken("acme", "acme-api");
    expect(await app.revokeToken(token)).toBe("revoked");
    expect(github.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/installation/token" });
    await expect(
      asToken(github, token).rest.repos.get({ owner: "acme", repo: "acme-api" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(await app.revokeToken(token)).toBe("already");
  });

  it("fails without minting when the App is not on the repository", async () => {
    const github = fake();
    const app = createGitHubApp(credentials, { fetch: github.fetch });
    await expect(app.runToken("other", "repo")).rejects.toThrow(
      "The GitHub App is not installed on other/repo",
    );
    expect(github.scopedTokens.size).toBe(0);
  });
});
