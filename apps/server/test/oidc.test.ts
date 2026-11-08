import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GITHUB_OIDC_ISSUER, githubOidc } from "../src/oidc.js";

// Keys made for this run only, published the way GitHub publishes its Actions OIDC keys.
const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const AUDIENCE = "https://selfhost.example.com";
const NOW = Date.parse("2026-11-08T12:00:00Z");
const seconds = NOW / 1000;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function sign(
  claims: Record<string, unknown>,
  {
    key = signing.privateKey,
    kid = "k1",
    alg = "RS256",
  }: { key?: KeyObject; kid?: string; alg?: string } = {},
): string {
  const data = `${b64({ alg, kid, typ: "JWT" })}.${b64(claims)}`;
  const signature = createSign("RSA-SHA256").update(data).sign(key).toString("base64url");
  return `${data}.${signature}`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  iss: GITHUB_OIDC_ISSUER,
  aud: AUDIENCE,
  iat: seconds - 10,
  nbf: seconds - 10,
  exp: seconds + 300,
  repository: "acme/acme-web",
  ref: "refs/pull/42/merge",
  event_name: "pull_request",
  run_id: "9001",
  workflow_ref: "acme/acme-web/.github/workflows/ci.yml@refs/pull/42/merge",
  sub: "repo:acme/acme-web:pull_request",
  ...over,
});

function issuer(keys: { kid: string; key: KeyObject }[] = [{ kid: "k1", key: signing.publicKey }]) {
  const fetched: string[] = [];
  const published = { keys };
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    fetched.push(url);
    if (url === `${GITHUB_OIDC_ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: GITHUB_OIDC_ISSUER,
        jwks_uri: `${GITHUB_OIDC_ISSUER}/.well-known/jwks`,
      });
    }
    if (url === `${GITHUB_OIDC_ISSUER}/.well-known/jwks`) {
      return Response.json({
        keys: published.keys.map(({ kid, key }) => ({
          ...key.export({ format: "jwk" }),
          kid,
          use: "sig",
          alg: "RS256",
        })),
      });
    }
    return new Response("not found", { status: 404 });
  };
  let now = NOW;
  const verifier = githubOidc({ fetch: fetcher, now: () => now });
  return {
    verifier,
    fetched,
    published,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("githubOidc", () => {
  it("accepts a token GitHub signed for this audience and returns its claims", async () => {
    const { verifier, fetched } = issuer();
    expect(await verifier.verify(sign(claims()), AUDIENCE)).toEqual({
      ok: true,
      claims: {
        repository: "acme/acme-web",
        ref: "refs/pull/42/merge",
        event_name: "pull_request",
        run_id: "9001",
        workflow_ref: "acme/acme-web/.github/workflows/ci.yml@refs/pull/42/merge",
      },
    });
    // The keys are fetched once and reused.
    await verifier.verify(sign(claims()), AUDIENCE);
    expect(fetched).toHaveLength(2);
  });

  it.each([
    [
      "another audience",
      claims({ aud: "https://elsewhere.example.com" }),
      "audience is not https://selfhost.example.com",
    ],
    [
      "another issuer",
      claims({ iss: "https://token.example.com" }),
      `issuer is not ${GITHUB_OIDC_ISSUER}`,
    ],
    ["an expired token", claims({ exp: seconds - 120 }), "expired"],
    ["a token not valid yet", claims({ nbf: seconds + 600 }), "nbf is in the future"],
    ["no repository", claims({ repository: undefined }), "no repository claim"],
  ])("refuses %s", async (_name, payload, reason) => {
    const { verifier } = issuer();
    expect(await verifier.verify(sign(payload), AUDIENCE)).toEqual({ ok: false, reason });
  });

  it("accepts the audience in a list", async () => {
    const { verifier } = issuer();
    const result = await verifier.verify(sign(claims({ aud: ["x", AUDIENCE] })), AUDIENCE);
    expect(result.ok).toBe(true);
  });

  it("refuses a token signed with a key the issuer does not publish", async () => {
    const { verifier } = issuer();
    expect(await verifier.verify(sign(claims(), { key: other.privateKey }), AUDIENCE)).toEqual({
      ok: false,
      reason: "bad signature",
    });
    expect(await verifier.verify(sign(claims(), { kid: "k9" }), AUDIENCE)).toEqual({
      ok: false,
      reason: "signed with a key the issuer does not publish",
    });
  });

  it("refuses tokens that are not RS256 JWTs", async () => {
    const { verifier } = issuer();
    const unsigned = `${b64({ alg: "none", kid: "k1" })}.${b64(claims())}.`;
    expect(await verifier.verify(unsigned, AUDIENCE)).toEqual({
      ok: false,
      reason: "expected an RS256 token with a key id",
    });
    expect(await verifier.verify("selfhost_admin_token", AUDIENCE)).toEqual({
      ok: false,
      reason: "not a JWT",
    });
  });

  it("refetches the keys for a new key id, at most once a minute", async () => {
    const { verifier, fetched, published, advance } = issuer();
    await verifier.verify(sign(claims()), AUDIENCE);
    published.keys = [{ kid: "k2", key: other.publicKey }];
    const rotated = sign(claims(), { key: other.privateKey, kid: "k2" });
    expect((await verifier.verify(rotated, AUDIENCE)).ok).toBe(false);
    expect(fetched).toHaveLength(2);
    advance(61_000);
    expect((await verifier.verify(rotated, AUDIENCE)).ok).toBe(true);
    expect(fetched).toHaveLength(4);
  });
});
