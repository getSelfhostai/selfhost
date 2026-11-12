import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { asSystem, databaseOf, isPostgresUrl, type Ledger } from "@selfhost/ledger";
import {
  createValidator,
  HOSTED_CLI_PARAMS,
  HOSTED_PROVIDERS,
  HostedExchangeRequestSchema,
  type HostedInfo,
  type HostedProvider,
  type JoinResponse,
} from "@selfhost/schema";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { apiError } from "./access.js";
import { limit, readBody, SMALL_BODY_BYTES } from "./http.js";
import { teamId } from "./ids.js";

/**
 * The hosted team server: SELFHOST_MODE=hosted on the same server and image as a self-hosted
 * install. What changes is configuration only:
 *
 * - Every org is isolated with Postgres row-level security (migration 0019): a person token's
 *   request runs with selfhost.org set to its org, so a query can neither read nor write another
 *   org's rows, whatever the route does. Each org has its own key for the secrets kept at rest.
 * - People sign in with GitHub or Google. The first sign-in of an email that is in no org makes
 *   an org and a team with them as owner; teammates come in with an invite, as on any server.
 * - It stores events and settings only. The AI gateway, background runs, the GitHub App, trace
 *   export and checks with the server's own keys are off, so no model traffic passes through it
 *   and no subscription login or provider key is ever asked for.
 * - An org of up to SELFHOST_HOSTED_FREE_SEATS people (default 10) gets every feature with no
 *   agent limit; the next person is refused with a notice about the paid plan.
 */

export const DEFAULT_FREE_SEATS = 10;
/** Open decision: the free plan's retention. Conservative until it is set. */
export const DEFAULT_RETENTION_DAYS = 30;
/** Open decision: the free plan's storage, as events kept per org. */
export const DEFAULT_MAX_EVENTS = 1_000_000;
export const DEFAULT_PAID_PLAN_NOTICE =
  "More people need the paid plan: ask the selfhost team to move your org to it.";

/** How long the sign-in page's state and the code the CLI exchanges stay good. */
const STATE_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 2 * 60_000;
const COOKIE = "selfhost_signin";
const MIN_SECRET_BYTES = 32;

export interface OAuthClient {
  id: string;
  secret: string;
}

export interface HostedConfig {
  /** Where people reach this server (SELFHOST_PUBLIC_URL); the OAuth apps redirect back to it. */
  publicUrl: string;
  /** SELFHOST_HOSTED_SECRET_KEY: signs sign-in state and wraps every org's key. */
  secretKey: Buffer;
  providers: Partial<Record<HostedProvider, OAuthClient>>;
  freeSeats: number;
  retentionDays: number;
  maxEvents: number;
  paidPlan: { notice: string; url: string | null };
}

const PROVIDER_ENV: Record<HostedProvider, string> = {
  github: "SELFHOST_OAUTH_GITHUB",
  google: "SELFHOST_OAUTH_GOOGLE",
};

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name}: expected a whole number of 1 or more, got "${raw}"`);
  }
  return value;
}

/** A key given as hex or base64; at least 32 bytes. */
function secretKey(raw: string | undefined): Buffer {
  const text = raw?.trim() ?? "";
  const bytes = /^[0-9a-f]+$/i.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  if (bytes.length < MIN_SECRET_BYTES) {
    throw new Error(
      `SELFHOST_MODE=hosted needs SELFHOST_HOSTED_SECRET_KEY: at least ${MIN_SECRET_BYTES} random bytes as hex or base64 (openssl rand -base64 32)`,
    );
  }
  return bytes;
}

function httpUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name}: expected an http or https URL, got "${raw}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name}: expected an http or https URL, got "${raw}"`);
  }
  return raw.replace(/\/+$/, "");
}

/**
 * The hosted configuration when SELFHOST_MODE=hosted, else undefined (a self-hosted server,
 * unchanged). Throws, naming the variable, when something hosted needs is missing.
 */
export function hostedFromEnv(env: NodeJS.ProcessEnv = process.env): HostedConfig | undefined {
  const mode = env.SELFHOST_MODE?.trim() || "self-hosted";
  if (mode === "self-hosted") return undefined;
  if (mode !== "hosted") {
    throw new Error(`SELFHOST_MODE: expected self-hosted or hosted, got "${mode}"`);
  }
  if (!isPostgresUrl(env.DATABASE_URL?.trim() ?? "")) {
    throw new Error(
      "SELFHOST_MODE=hosted needs Postgres in DATABASE_URL: the embedded database has no row-level security that binds it",
    );
  }
  const publicUrl = env.SELFHOST_PUBLIC_URL?.trim();
  if (!publicUrl) {
    throw new Error(
      "SELFHOST_MODE=hosted needs SELFHOST_PUBLIC_URL, the address people sign in at",
    );
  }
  const providers: HostedConfig["providers"] = {};
  for (const provider of HOSTED_PROVIDERS) {
    const prefix = PROVIDER_ENV[provider];
    const id = env[`${prefix}_CLIENT_ID`]?.trim();
    const secret = env[`${prefix}_CLIENT_SECRET`]?.trim();
    if (!id && !secret) continue;
    if (!id || !secret) {
      throw new Error(`${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET go together`);
    }
    providers[provider] = { id, secret };
  }
  if (Object.keys(providers).length === 0) {
    throw new Error(
      "SELFHOST_MODE=hosted needs a sign-in: SELFHOST_OAUTH_GITHUB_CLIENT_ID and _CLIENT_SECRET, or the SELFHOST_OAUTH_GOOGLE_ pair",
    );
  }
  const planUrl = env.SELFHOST_HOSTED_PAID_PLAN_URL?.trim();
  return {
    publicUrl: httpUrl("SELFHOST_PUBLIC_URL", publicUrl),
    secretKey: secretKey(env.SELFHOST_HOSTED_SECRET_KEY),
    providers,
    freeSeats: positive(env, "SELFHOST_HOSTED_FREE_SEATS", DEFAULT_FREE_SEATS),
    retentionDays: positive(env, "SELFHOST_HOSTED_RETENTION_DAYS", DEFAULT_RETENTION_DAYS),
    maxEvents: positive(env, "SELFHOST_HOSTED_MAX_EVENTS", DEFAULT_MAX_EVENTS),
    paidPlan: {
      notice: env.SELFHOST_HOSTED_PAID_PLAN_NOTICE?.trim() || DEFAULT_PAID_PLAN_NOTICE,
      url: planUrl ? httpUrl("SELFHOST_HOSTED_PAID_PLAN_URL", planUrl) : null,
    },
  };
}

/** A key for one purpose, from SELFHOST_HOSTED_SECRET_KEY. */
function derive(config: HostedConfig, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", config.secretKey, "", `selfhost hosted ${purpose}`, 32));
}

/** The key that wraps each org's own key (LedgerOptions.secretKey). */
export const orgKeyWrapper = (config: HostedConfig) => derive(config, "org keys");

/** What the person adding the next teammate to a full org is told. */
export function seatNotice(config: HostedConfig): string {
  const { notice, url } = config.paidPlan;
  return `The free plan covers up to ${config.freeSeats} people in an org, and this org is full. ${notice}${url ? ` ${url}` : ""}`;
}

/** What teams.ts asks of the hosted server on every request (see TeamRouteOptions.tenancy). */
export interface Tenancy {
  /** The seat limit for joins (an org's own orgs.seats wins). */
  seats: number;
  /** The 402 a join past the seat limit answers with. */
  seatRefusal(c: Context): Response;
  /** The answer to an event upload when the org keeps as many events as it may, else undefined. */
  ingestRefusal(c: Context, org: string): Promise<Response | undefined>;
}

/**
 * How long an org's event count is reused before it is counted again, while it is more than
 * COUNT_SLACK events under the limit; closer to it, every upload counts.
 */
const COUNT_TTL_MS = 60_000;
const COUNT_SLACK = 10_000;

export function hostedTenancy(ledger: Ledger, config: HostedConfig, now = () => Date.now()) {
  const counted = new Map<string, { at: number; events: number }>();
  const db = databaseOf(ledger);
  return {
    seats: config.freeSeats,
    seatRefusal: (c) => c.json(apiError("seat_limit", seatNotice(config)), 402),
    async ingestRefusal(c, org) {
      let entry = counted.get(org);
      if (
        !entry ||
        now() - entry.at > COUNT_TTL_MS ||
        entry.events + COUNT_SLACK >= config.maxEvents
      ) {
        const [row] = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM events WHERE team IN (SELECT id FROM teams WHERE org_id = $1)",
          [org],
        );
        entry = { at: now(), events: Number(row?.n ?? 0) };
        counted.set(org, entry);
      }
      if (entry.events < config.maxEvents) return undefined;
      return c.json(
        apiError(
          "storage_limit",
          `This org keeps ${config.maxEvents} events, all the free plan stores; new events are refused until older ones expire (after ${config.retentionDays} days). ${config.paidPlan.notice}`,
        ),
        507,
      );
    },
  } satisfies Tenancy;
}

// ---------------------------------------------------------------------------------------------
// Sign-in with GitHub or Google

/** Who a provider says signed in: a verified email, and a display name when it has one. */
export interface Identity {
  email: string;
  name?: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

interface Provider {
  authorize(client: OAuthClient, redirect: string, state: string): string;
  identity(client: OAuthClient, redirect: string, code: string, fetch: Fetch): Promise<Identity>;
}

async function json(response: Response, what: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${what} answered ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "");

/**
 * The providers. Each code is exchanged for an access token that is used once, to read the
 * person's verified email, and then dropped: nothing a provider hands out is stored.
 */
export const PROVIDERS: Record<HostedProvider, Provider> = {
  github: {
    authorize(client, redirect, state) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: client.id,
        redirect_uri: redirect,
        scope: "read:user user:email",
        state,
        allow_signup: "true",
      }).toString();
      return url.toString();
    },
    async identity(client, redirect, code, fetch) {
      const token = text(
        (
          await json(
            await fetch("https://github.com/login/oauth/access_token", {
              method: "POST",
              headers: { accept: "application/json", "content-type": "application/json" },
              body: JSON.stringify({
                client_id: client.id,
                client_secret: client.secret,
                code,
                redirect_uri: redirect,
              }),
            }),
            "GitHub's token endpoint",
          )
        ).access_token,
      );
      if (!token) throw new Error("GitHub gave no access token");
      const headers = {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "selfhost",
      };
      const emails = (await (
        await fetch("https://api.github.com/user/emails", { headers })
      ).json()) as { email?: string; primary?: boolean; verified?: boolean }[];
      const primary = Array.isArray(emails)
        ? emails.find((e) => e.primary && e.verified && text(e.email))
        : undefined;
      if (!primary?.email) throw new Error("Your GitHub account has no verified primary email");
      const user = await json(await fetch("https://api.github.com/user", { headers }), "GitHub");
      const name = text(user.name) || text(user.login);
      return { email: primary.email.trim(), ...(name ? { name } : {}) };
    },
  },
  google: {
    authorize(client, redirect, state) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: client.id,
        redirect_uri: redirect,
        response_type: "code",
        scope: "openid email profile",
        state,
        prompt: "select_account",
      }).toString();
      return url.toString();
    },
    async identity(client, redirect, code, fetch) {
      const token = text(
        (
          await json(
            await fetch("https://oauth2.googleapis.com/token", {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                code,
                client_id: client.id,
                client_secret: client.secret,
                redirect_uri: redirect,
                grant_type: "authorization_code",
              }).toString(),
            }),
            "Google's token endpoint",
          )
        ).access_token,
      );
      if (!token) throw new Error("Google gave no access token");
      const info = await json(
        await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
          headers: { authorization: `Bearer ${token}` },
        }),
        "Google",
      );
      const email = text(info.email);
      if (!email || info.email_verified !== true) {
        throw new Error("Your Google account has no verified email");
      }
      const name = text(info.name);
      return { email, ...(name ? { name } : {}) };
    },
  },
};

// Sign-in state and the CLI's code: signed and sealed with keys from SELFHOST_HOSTED_SECRET_KEY,
// so the server keeps nothing between the redirect and the callback.

interface CliHandoff {
  port: number;
  state: string;
  challenge: string;
}

interface SigninState {
  provider: HostedProvider;
  /** sha256 of the nonce in the browser's cookie: the callback must come from that browser. */
  nonce: string;
  invite?: string;
  cli?: CliHandoff;
  expires: number;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

function sign(config: HostedConfig, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", derive(config, "state")).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify<T>(config: HostedConfig, signed: string): T | undefined {
  const [body, mac] = signed.split(".");
  if (!body || !mac) return undefined;
  const expected = createHmac("sha256", derive(config, "state")).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

function seal(config: HostedConfig, payload: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(config, "cli code"), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
}

function unseal<T>(config: HostedConfig, sealed: string): T | undefined {
  const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !body || iv.length !== 12 || tag.length !== 16) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", derive(config, "cli code"), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"),
    ) as T;
  } catch {
    return undefined;
  }
}

interface CliCode {
  joined: JoinResponse;
  challenge: string;
  expires: number;
}

/** Free email domains: an org named after one would be named after everyone's. */
const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "users.noreply.github.com",
]);

/** The name a new org and its first team get from the email that made them. */
export function orgNameFor(email: string): string {
  const [local = "", domain = ""] = email.toLowerCase().split("@");
  if (domain && !FREE_MAIL.has(domain)) return domain.split(".").slice(0, -1).join(".") || domain;
  return local || "team";
}

export type SignInRefusal = { refused: string; status: 401 | 402; message: string };

/**
 * Who a verified email is on this server, with a new person token: the team an invite names
 * (when given), else the team they joined first, else a new org and team with them as owner.
 * Runs as the server's own work: the email's org is not known until it is found.
 */
export function signIn(
  ledger: Ledger,
  config: HostedConfig,
  identity: Identity,
  invite?: string,
): Promise<JoinResponse | SignInRefusal> {
  return asSystem(async (): Promise<JoinResponse | SignInRefusal> => {
    const { teams, orgs, hosted } = ledger;
    const as = { id: identity.email, ...(identity.name ? { name: identity.name } : {}) };
    if (invite) {
      const joined = await teams.join(invite, as, { seats: config.freeSeats });
      if (!("refused" in joined)) return joined;
      if (joined.refused === "seat_limit") {
        return { refused: "seat_limit", status: 402, message: seatNotice(config) };
      }
      // Someone already in the invite's org signs in to their own membership below.
      if (joined.refused !== "existing_person") {
        return {
          refused: "invalid_invite",
          status: 401,
          message: INVITE_REFUSALS[joined.refused] ?? "This invite does not work",
        };
      }
    }
    const [own] = await hosted.memberships(identity.email);
    if (own) {
      const [token, team] = await Promise.all([
        hosted.issueToken(own.person.team, own.person.id),
        teams.getTeam(own.person.team),
      ]);
      if (token && team) return { token, person: own.person, team };
    }
    const name = orgNameFor(identity.email);
    const id = `${(teamId(name) ?? "org").slice(0, 50)}-${randomBytes(3).toString("hex")}`;
    if (!(await orgs.createOrg({ id, name }))) throw new Error(`org ${id} exists already`);
    const created = await teams.createTeam({ id, name, org: id });
    if (!created) throw new Error(`team ${id} exists already`);
    const joined = await teams.join(created.invite, as);
    if ("refused" in joined)
      throw new Error(`the new team's invite was refused: ${joined.refused}`);
    return joined;
  });
}

const INVITE_REFUSALS: Record<string, string> = {
  unknown: "Unknown invite code",
  expired: "This invite has expired. Ask a team admin for a new one.",
  revoked: "This invite was revoked. Ask a team admin for a new one.",
  wrong_person:
    "This invite is for someone else. Sign in with the account of the email it was sent to.",
};

// ---------------------------------------------------------------------------------------------
// Routes

export interface HostedRouteOptions {
  config: HostedConfig;
  /** For the providers' token and profile calls. Default: the global fetch. */
  fetch?: Fetch;
  now?: () => number;
}

const exchangeBody = createValidator(HostedExchangeRequestSchema);

const htmlText = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );

const PROVIDER_NAMES: Record<HostedProvider, string> = { github: "GitHub", google: "Google" };

function page(c: Context, title: string, body: string, status: 200 | 400 | 401 | 402 | 403 | 502) {
  c.header("cache-control", "no-store");
  c.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${htmlText(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}a.button{display:block;margin:.75rem 0;padding:.6rem 1rem;border:1px solid #888;border-radius:.4rem;text-align:center;text-decoration:none;color:inherit}</style></head><body><h1>${htmlText(title)}</h1>${body}</body></html>`,
    status,
  );
}

function cliHandoff(query: Record<string, string>): CliHandoff | undefined | "invalid" {
  const port = query[HOSTED_CLI_PARAMS.port];
  const state = query[HOSTED_CLI_PARAMS.state];
  const challenge = query[HOSTED_CLI_PARAMS.challenge];
  if (port === undefined && state === undefined && challenge === undefined) return undefined;
  const number = Number(port);
  if (
    !Number.isInteger(number) ||
    number < 1024 ||
    number > 65535 ||
    !state ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(state) ||
    !challenge ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge)
  ) {
    return "invalid";
  }
  return { port: number, state, challenge };
}

const loopback = (cli: CliHandoff, params: Record<string, string>) =>
  `http://127.0.0.1:${cli.port}/callback?${new URLSearchParams({ state: cli.state, ...params })}`;

/**
 * The public hosted routes, before any token check:
 *
 * - GET /v1/hosted: providers, seats and the plan's limits, for the console and the CLI.
 * - GET /v1/hosted/signin: picks a provider (provider=github or google, else a page to pick one)
 *   and sends the browser there. invite= joins that invite's team; cli_port, cli_state and
 *   cli_challenge come from `selfhost init --hosted`, which waits on its loopback address.
 * - GET /v1/hosted/callback/{provider}: where the provider sends the browser back. The console
 *   gets the new person token in the URL fragment, as `selfhost console` hands one over; the
 *   CLI gets a code for POST /v1/hosted/exchange on its loopback address.
 * - POST /v1/hosted/exchange: the CLI's code and verifier for the person token.
 */
export function hostedRoutes(app: Hono, ledger: Ledger, options: HostedRouteOptions): void {
  const { config } = options;
  const send: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => Date.now());
  const providers = HOSTED_PROVIDERS.filter((p) => config.providers[p] !== undefined);
  const redirectFor = (provider: HostedProvider) =>
    `${config.publicUrl}/v1/hosted/callback/${provider}`;
  const secure = config.publicUrl.startsWith("https:");

  app.get("/v1/hosted", (c) =>
    c.json({
      schema: "selfhost.hosted/v1",
      providers,
      free_seats: config.freeSeats,
      retention_days: config.retentionDays,
      max_events: config.maxEvents,
      paid_plan: config.paidPlan,
    } satisfies HostedInfo),
  );

  app.get("/v1/hosted/signin", (c) => {
    const query = c.req.query();
    const cli = cliHandoff(query);
    if (cli === "invalid") {
      return page(c, "Sign-in link is broken", "<p>Run selfhost init --hosted again.</p>", 400);
    }
    const invite = query.invite?.trim() || undefined;
    const provider = query.provider as HostedProvider | undefined;
    if (provider === undefined || !providers.includes(provider)) {
      const links = providers
        .map((p) => {
          const params = new URLSearchParams({ ...query, provider: p });
          return `<a class="button" href="/v1/hosted/signin?${htmlText(params.toString())}">Continue with ${PROVIDER_NAMES[p]}</a>`;
        })
        .join("");
      const why = invite
        ? "<p>Sign in to join the team you were invited to.</p>"
        : "<p>Sign in to your team. The first sign-in of a new email makes an org and a team for it.</p>";
      return page(c, "Sign in to selfhost", `${why}${links}`, 200);
    }
    const client = config.providers[provider];
    if (!client) return page(c, "Unknown sign-in", "", 400);
    const nonce = randomBytes(24).toString("base64url");
    setCookie(c, COOKIE, nonce, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/v1/hosted",
      maxAge: STATE_TTL_MS / 1000,
    });
    const state = sign(config, {
      provider,
      nonce: sha256(nonce),
      ...(invite ? { invite } : {}),
      ...(cli ? { cli } : {}),
      expires: now() + STATE_TTL_MS,
    } satisfies SigninState);
    return c.redirect(PROVIDERS[provider].authorize(client, redirectFor(provider), state), 302);
  });

  app.get("/v1/hosted/callback/:provider", async (c) => {
    const provider = c.req.param("provider") as HostedProvider;
    const client = config.providers[provider];
    const state = verify<SigninState>(config, c.req.query("state") ?? "");
    const nonce = getCookie(c, COOKIE);
    if (
      !client ||
      !state ||
      state.provider !== provider ||
      state.expires < now() ||
      !nonce ||
      sha256(nonce) !== state.nonce
    ) {
      return page(
        c,
        "Sign-in expired",
        '<p>This sign-in was started somewhere else or too long ago. <a href="/v1/hosted/signin">Start again</a>.</p>',
        400,
      );
    }
    setCookie(c, COOKIE, "", { path: "/v1/hosted", maxAge: 0 });
    const { cli } = state;
    const code = c.req.query("code");
    const failed = (message: string, status: 400 | 401 | 402 | 403 | 502) =>
      cli
        ? c.redirect(loopback(cli, { error: message }), 302)
        : page(c, "Not signed in", `<p>${htmlText(message)}</p>`, status);
    if (!code) return failed(`${PROVIDER_NAMES[provider]} did not sign you in.`, 401);
    let identity: Identity;
    try {
      identity = await PROVIDERS[provider].identity(client, redirectFor(provider), code, send);
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error), 502);
    }
    const signed = await signIn(ledger, config, identity, state.invite);
    if ("refused" in signed) return failed(signed.message, signed.status);
    if (cli) {
      const sealed = seal(config, {
        joined: signed,
        challenge: cli.challenge,
        expires: now() + CODE_TTL_MS,
      } satisfies CliCode);
      return c.redirect(loopback(cli, { code: sealed }), 302);
    }
    c.header("cache-control", "no-store");
    return c.redirect(`/#token=${encodeURIComponent(signed.token)}`, 302);
  });

  app.post("/v1/hosted/exchange", limit(SMALL_BODY_BYTES), async (c) => {
    const body = await readBody(c, exchangeBody);
    if (body instanceof Response) return body;
    const code = unseal<CliCode>(config, body.code);
    if (!code || code.expires < now() || sha256(body.verifier) !== code.challenge) {
      return c.json(
        apiError("invalid_code", "This sign-in code is unknown or expired. Sign in again."),
        401,
      );
    }
    return c.json(code.joined satisfies JoinResponse);
  });
}
