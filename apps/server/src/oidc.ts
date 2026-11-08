import { createPublicKey, type JsonWebKey, type KeyObject, verify } from "node:crypto";

/** The issuer of GitHub Actions OIDC tokens on github.com. GHES uses https://HOST/_services/token. */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/** The claims of a GitHub Actions OIDC token the receipt route reads. */
export interface ActionsClaims {
  /** owner/name of the repository whose workflow asked for the token. */
  repository: string;
  /** Such as refs/pull/42/merge on a pull_request run. */
  ref?: string;
  event_name?: string;
  run_id?: string;
  workflow_ref?: string;
}

export type OidcResult = { ok: true; claims: ActionsClaims } | { ok: false; reason: string };

export interface OidcVerifier {
  /** Checks the signature against the issuer's keys, then iss, aud, exp, nbf and iat. */
  verify(token: string, audience: string): Promise<OidcResult>;
}

export interface OidcOptions {
  issuer?: string;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

/** Clock skew allowed on exp, nbf and iat. */
const LEEWAY_S = 60;
/** How long fetched keys are trusted, and how often an unknown key id may refetch them. */
const KEYS_TTL_MS = 60 * 60_000;
const REFETCH_MS = 60_000;

const decode = (part: string): unknown =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/**
 * Verifies GitHub Actions OIDC tokens: RS256 signatures checked against the issuer's published
 * keys (found through its OpenID configuration, cached for an hour and refetched for a key id
 * it has not seen, at most once a minute), then the issuer, the audience and the token's time.
 * Only a token that passes all of it yields claims.
 */
export function githubOidc(options: OidcOptions = {}): OidcVerifier {
  const issuer = (options.issuer ?? GITHUB_OIDC_ISSUER).replace(/\/+$/, "");
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let keys = new Map<string, KeyObject>();
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let loading: Promise<void> | undefined;

  async function load(): Promise<void> {
    const get = async (url: string) => {
      const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      return response.json() as Promise<unknown>;
    };
    const config = (await get(`${issuer}/.well-known/openid-configuration`)) as {
      jwks_uri?: string;
    };
    if (!config.jwks_uri) throw new Error("The issuer's OpenID configuration has no jwks_uri");
    const jwks = (await get(config.jwks_uri)) as { keys?: (JsonWebKey & { kid?: string })[] };
    const next = new Map<string, KeyObject>();
    for (const jwk of jwks.keys ?? []) {
      if (!jwk.kid || jwk.kty !== "RSA") continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
      } catch {
        // A key that cannot be read signs nothing we accept.
      }
    }
    keys = next;
    fetchedAt = now();
  }

  async function keyFor(kid: string): Promise<KeyObject | undefined> {
    const stale = now() - fetchedAt > KEYS_TTL_MS;
    const unknown = !keys.has(kid) && now() - fetchedAt > REFETCH_MS;
    if (stale || unknown) {
      loading ??= load().finally(() => {
        loading = undefined;
      });
      await loading;
    }
    return keys.get(kid);
  }

  return {
    async verify(token, audience) {
      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false, reason: "not a JWT" };
      const [head = "", body = "", signature = ""] = parts;
      let header: { alg?: string; kid?: string };
      let claims: Record<string, unknown>;
      try {
        header = decode(head) as typeof header;
        claims = decode(body) as typeof claims;
      } catch {
        return { ok: false, reason: "not a JWT" };
      }
      if (header.alg !== "RS256" || !header.kid) {
        return { ok: false, reason: "expected an RS256 token with a key id" };
      }
      let key: KeyObject | undefined;
      try {
        key = await keyFor(header.kid);
      } catch (error) {
        return {
          ok: false,
          reason: `could not read the issuer's keys: ${(error as Error).message}`,
        };
      }
      if (!key) return { ok: false, reason: "signed with a key the issuer does not publish" };
      const signed = verify(
        "RSA-SHA256",
        Buffer.from(`${head}.${body}`),
        key,
        Buffer.from(signature, "base64url"),
      );
      if (!signed) return { ok: false, reason: "bad signature" };

      if (claims.iss !== issuer) return { ok: false, reason: `issuer is not ${issuer}` };
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audiences.includes(audience)) {
        return { ok: false, reason: `audience is not ${audience}` };
      }
      const seconds = now() / 1000;
      if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S < seconds) {
        return { ok: false, reason: "expired" };
      }
      for (const name of ["nbf", "iat"] as const) {
        const value = claims[name];
        if (typeof value === "number" && value - LEEWAY_S > seconds) {
          return { ok: false, reason: `${name} is in the future` };
        }
      }
      if (typeof claims.repository !== "string" || !claims.repository.includes("/")) {
        return { ok: false, reason: "no repository claim" };
      }
      const text = (name: string) =>
        typeof claims[name] === "string" ? { [name]: claims[name] as string } : {};
      return {
        ok: true,
        claims: {
          repository: claims.repository,
          ...text("ref"),
          ...text("event_name"),
          ...text("run_id"),
          ...text("workflow_ref"),
        },
      };
    },
  };
}
