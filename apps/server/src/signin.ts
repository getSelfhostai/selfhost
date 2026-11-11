import { createHash, timingSafeEqual } from "node:crypto";
import type { Person } from "@selfhost/schema";
import type { Context } from "hono";
import { apiError } from "./access.js";

/**
 * Console sign-in through a proxy, off unless the operator turns it on. With compose.signin.yml,
 * Caddy asks oauth2-proxy who a browser request comes from and passes the signed-in email on in
 * EMAIL_HEADER, with the shared secret in SECRET_HEADER. The server believes the email only when
 * the secret matches SELFHOST_SIGNIN_PROXY_SECRET, so a request that reaches port 4400 without
 * Caddy, or one that sets the headers itself (Caddy removes them from every request first),
 * signs in as nobody.
 *
 * It covers GET requests under /v1 only: reading, which is all the console does. Writing still
 * needs a token, so a page on another site cannot make a signed-in browser change anything.
 * The email must be the id of a person who still holds a person token on this server, as their
 * events carry it; they then read what their own token would.
 */

export const EMAIL_HEADER = "x-selfhost-email";
export const SECRET_HEADER = "x-selfhost-proxy-secret";

/** Shorter secrets are refused at startup: they could be guessed. */
export const MIN_SECRET_LENGTH = 32;

export interface SigninOptions {
  /** The secret Caddy sends with each signed-in request. */
  secret: string;
  /**
   * The org this sign-in is for (SELFHOST_SIGNIN_ORG). Person ids are unique within an org
   * only, so an email in teams of several orgs signs in to this one.
   */
  org?: string;
}

/**
 * SELFHOST_SIGNIN_PROXY_SECRET, checked, and SELFHOST_SIGNIN_ORG; undefined when sign-in
 * through a proxy is off.
 */
export function signinFromEnv(env: NodeJS.ProcessEnv = process.env): SigninOptions | undefined {
  const secret = env.SELFHOST_SIGNIN_PROXY_SECRET?.trim();
  if (!secret) return undefined;
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SELFHOST_SIGNIN_PROXY_SECRET must be at least ${MIN_SECRET_LENGTH} characters (openssl rand -hex 32)`,
    );
  }
  const org = env.SELFHOST_SIGNIN_ORG?.trim();
  return org ? { secret, org } : { secret };
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * The email a request was signed in with, when sign-in is on, the request is a GET under /v1
 * with no bearer token, and it carries the proxy's secret. Otherwise undefined.
 */
export function forwardedEmail(c: Context, options: SigninOptions | undefined): string | undefined {
  if (!options) return undefined;
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return undefined;
  if (!c.req.path.startsWith("/v1/")) return undefined;
  const secret = c.req.header(SECRET_HEADER);
  if (!secret || !timingSafeEqual(digest(secret), digest(options.secret))) return undefined;
  const email = c.req.header(EMAIL_HEADER)?.trim();
  return email || undefined;
}

/**
 * The person a signed-in email stands for, or the 403 explaining why there is none. An email in
 * teams of several orgs is the person of the sign-in's org (SELFHOST_SIGNIN_ORG), else of the
 * org where it joined first: a later join elsewhere under the same id is someone else's org.
 * `found` is oldest first, as peopleWithAccess lists it.
 */
export function signedInPerson(
  c: Context,
  email: string,
  found: { person: Person; org: string }[],
  org?: string,
): Person | Response {
  const inOrg = org === undefined ? found : found.filter((entry) => entry.org === org);
  const [first] = inOrg;
  if (!first) {
    return c.json(
      apiError(
        "forbidden",
        `You are signed in as ${email}, who has no access on this server. Ask a team admin for an invite for this email (selfhost team invite --email ${email}).`,
      ),
      403,
    );
  }
  return first.person;
}
