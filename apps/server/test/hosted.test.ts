import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  asSystem,
  databaseOf,
  enforceRowSecurity,
  type Ledger,
  openLedger,
  rowSecurityProblem,
  withOrg,
} from "@selfhost/ledger";
import * as contracts from "@selfhost/schema";
import {
  type ApiError,
  EVENT_SCHEMA,
  type HostedInfo,
  type JoinResponse,
  type LedgerEvent,
} from "@selfhost/schema";
import type { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  DEFAULT_PAID_PLAN_NOTICE,
  type HostedConfig,
  hostedFromEnv,
  orgKeyWrapper,
  orgNameFor,
} from "../src/hosted.js";
import { caller, TOKEN } from "./helpers.js";

const CONFIG: HostedConfig = {
  publicUrl: "https://hosted.example",
  secretKey: Buffer.alloc(32, 7),
  providers: { github: { id: "gh-id", secret: "gh-secret" }, google: { id: "g", secret: "g" } },
  freeSeats: 10,
  retentionDays: 30,
  maxEvents: 1000,
  paidPlan: { notice: DEFAULT_PAID_PLAN_NOTICE, url: null },
};

/**
 * GitHub and Google as the tests need them: the one-time code is the email that signs in, and
 * the access token handed out is that email again.
 */
const providers = async (url: string, init?: RequestInit): Promise<Response> => {
  const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (url === "https://github.com/login/oauth/access_token") {
    const { code } = JSON.parse(String(init?.body)) as { code: string };
    return Response.json({ access_token: code });
  }
  if (url === "https://api.github.com/user/emails") {
    return Response.json([
      { email: `other-${bearer}`, primary: false, verified: true },
      { email: bearer, primary: true, verified: true },
    ]);
  }
  if (url === "https://api.github.com/user") {
    return Response.json({ login: bearer.split("@")[0], name: `Name of ${bearer}` });
  }
  if (url === "https://oauth2.googleapis.com/token") {
    return Response.json({ access_token: new URLSearchParams(String(init?.body)).get("code") });
  }
  if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
    return Response.json({ email: bearer, email_verified: !bearer.startsWith("unverified") });
  }
  return new Response("not found", { status: 404 });
};

function hostedApp(ledger: Ledger, config: HostedConfig = CONFIG): Hono {
  return createApp({ version: "test", ledger, token: TOKEN, hosted: { config, fetch: providers } });
}

/** Signs in through the browser flow: the sign-in redirect, then the provider's callback. */
async function browserSignIn(
  app: Hono,
  email: string,
  options: { provider?: "github" | "google"; invite?: string; query?: Record<string, string> } = {},
) {
  const provider = options.provider ?? "github";
  const query = new URLSearchParams({
    provider,
    ...(options.invite ? { invite: options.invite } : {}),
    ...options.query,
  });
  const start = await app.request(`/v1/hosted/signin?${query}`);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return app.request(
    `/v1/hosted/callback/${provider}?${new URLSearchParams({ code: email, state })}`,
    { headers: { cookie } },
  );
}

/** The person token a browser sign-in hands the console. */
async function consoleToken(app: Hono, email: string, invite?: string): Promise<string> {
  const res = await browserSignIn(app, email, invite ? { invite } : {});
  expect(res.status, await res.clone().text()).toBe(302);
  const match = /^\/#token=(.+)$/.exec(res.headers.get("location") ?? "");
  if (!match?.[1]) throw new Error(`no token in ${res.headers.get("location")}`);
  return decodeURIComponent(match[1]);
}

let n = 0;
const eventId = () => `019a7000-0000-7000-8000-${String(++n).padStart(12, "0")}`;

function event(person: string, overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    id: eventId(),
    schema: EVENT_SCHEMA,
    ts: new Date(Date.now() - 60_000).toISOString(),
    source: "hook",
    kind: "session.started",
    actor: { kind: "person", id: person },
    agent: { vendor: "claude_code" },
    ...overrides,
  } as LedgerEvent;
}

describe("hostedFromEnv", () => {
  const env = {
    SELFHOST_MODE: "hosted",
    DATABASE_URL: "postgres://app@db/selfhost",
    SELFHOST_PUBLIC_URL: "https://hosted.example/",
    SELFHOST_HOSTED_SECRET_KEY: randomBytes(32).toString("base64"),
    SELFHOST_OAUTH_GITHUB_CLIENT_ID: "id",
    SELFHOST_OAUTH_GITHUB_CLIENT_SECRET: "secret",
  };

  it("is off unless SELFHOST_MODE=hosted, so a self-hosted server does not change", () => {
    expect(hostedFromEnv({})).toBeUndefined();
    expect(hostedFromEnv({ SELFHOST_MODE: "self-hosted" })).toBeUndefined();
    expect(() => hostedFromEnv({ SELFHOST_MODE: "cloud" })).toThrow(/self-hosted or hosted/);
  });

  it("defaults to 10 free seats with conservative limits and no price", () => {
    const config = hostedFromEnv(env);
    expect(config).toMatchObject({
      publicUrl: "https://hosted.example",
      providers: { github: { id: "id", secret: "secret" } },
      freeSeats: 10,
      retentionDays: 30,
      maxEvents: 1_000_000,
      paidPlan: { notice: DEFAULT_PAID_PLAN_NOTICE, url: null },
    });
    expect(DEFAULT_PAID_PLAN_NOTICE).not.toMatch(/\d|\$/);
    expect(
      hostedFromEnv({
        ...env,
        SELFHOST_HOSTED_FREE_SEATS: "3",
        SELFHOST_HOSTED_PAID_PLAN_URL: "https://selfhost.ai/pricing",
      }),
    ).toMatchObject({ freeSeats: 3, paidPlan: { url: "https://selfhost.ai/pricing" } });
  });

  it("refuses what hosted needs missing, naming the variable", () => {
    const { DATABASE_URL: _db, ...noDb } = env;
    expect(() => hostedFromEnv(noDb)).toThrow(/DATABASE_URL/);
    expect(() => hostedFromEnv({ ...env, DATABASE_URL: "" })).toThrow(/Postgres/);
    const { SELFHOST_PUBLIC_URL: _url, ...noUrl } = env;
    expect(() => hostedFromEnv(noUrl)).toThrow(/SELFHOST_PUBLIC_URL/);
    expect(() => hostedFromEnv({ ...env, SELFHOST_HOSTED_SECRET_KEY: "short" })).toThrow(
      /SELFHOST_HOSTED_SECRET_KEY/,
    );
    const { SELFHOST_OAUTH_GITHUB_CLIENT_SECRET: _s, ...half } = env;
    expect(() => hostedFromEnv(half)).toThrow(/go together/);
    const {
      SELFHOST_OAUTH_GITHUB_CLIENT_ID: _i,
      SELFHOST_OAUTH_GITHUB_CLIENT_SECRET: _j,
      ...none
    } = env;
    expect(() => hostedFromEnv(none)).toThrow(/needs a sign-in/);
    expect(() => hostedFromEnv({ ...env, SELFHOST_HOSTED_FREE_SEATS: "0" })).toThrow(
      /SELFHOST_HOSTED_FREE_SEATS/,
    );
  });

  it("names new orgs after a company domain, or the person for free mail", () => {
    expect(orgNameFor("ana@acme.io")).toBe("acme");
    expect(orgNameFor("ana@eng.acme.co")).toBe("eng.acme");
    expect(orgNameFor("ana.b@gmail.com")).toBe("ana.b");
  });
});

describe("hosted mode on one server", () => {
  let ledger: Ledger;
  let app: Hono;
  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://", secretKey: orgKeyWrapper(CONFIG) });
    app = hostedApp(ledger);
  });
  afterAll(() => ledger.close());

  it("refuses a gateway, background runs, the GitHub App and the sign-in proxy", () => {
    const options = { version: "test", ledger, token: TOKEN, hosted: { config: CONFIG } };
    const gateway = { client: { tool: "bifrost" }, baseUrl: "http://bifrost" } as never;
    expect(() => createApp({ ...options, gateway })).toThrow(/the AI gateway/);
    expect(() => createApp({ ...options, background: {} as never })).toThrow(/background runs/);
    expect(() => createApp({ ...options, github: { app: {} as never } })).toThrow(/GitHub App/);
    expect(() => createApp({ ...options, signin: { secret: "x".repeat(32) } })).toThrow(
      /sign-in through a proxy/,
    );
  });

  it("tells the console and the CLI how to sign in, with no price", async () => {
    const res = await app.request("/v1/hosted");
    expect(res.status).toBe(200);
    expect((await res.json()) as HostedInfo).toEqual({
      schema: "selfhost.hosted/v1",
      providers: ["github", "google"],
      free_seats: 10,
      retention_days: 30,
      max_events: 1000,
      paid_plan: { notice: DEFAULT_PAID_PLAN_NOTICE, url: null },
    });
    const chooser = await app.request("/v1/hosted/signin");
    expect(chooser.status).toBe(200);
    const html = await chooser.text();
    expect(html).toContain("Continue with GitHub");
    expect(html).toContain("Continue with Google");
  });

  it("has no /v1/hosted on a self-hosted server", async () => {
    const plain = createApp({ version: "test", ledger, token: TOKEN });
    expect((await plain.request("/v1/hosted")).status).toBe(401);
    expect((await caller(plain, TOKEN)("/v1/hosted")).status).toBe(404);
    expect((await plain.request("/v1/hosted/signin?provider=github")).status).toBe(401);
  });

  it("makes an org and a team on the first sign-in, and signs the same person in again later", async () => {
    const token = await consoleToken(app, "founder@startup.dev");
    const me = await caller(app, token)("/v1/me");
    const body = (await me.json()) as {
      person: { id: string; role: string; name?: string };
      team: { id: string; org: string; name: string };
    };
    expect(body.person).toMatchObject({
      id: "founder@startup.dev",
      role: "owner",
      name: "Name of founder@startup.dev",
    });
    expect(body.team.name).toBe("startup");
    expect(body.team.org).toBe(body.team.id);
    expect(body.team.id).toMatch(/^startup-[0-9a-f]{6}$/);

    const again = await consoleToken(app, "FOUNDER@startup.dev");
    expect(again).not.toBe(token);
    const second = (await (await caller(app, again)("/v1/me")).json()) as typeof body;
    expect(second.team.id).toBe(body.team.id);
    expect(second.person.role).toBe("owner");
  });

  it("signs in with Google too, and only with a verified email", async () => {
    const res = await browserSignIn(app, "ana@google-user.dev", { provider: "google" });
    expect(res.status).toBe(302);
    const refused = await browserSignIn(app, "unverified@x.dev", { provider: "google" });
    expect(refused.status).toBe(502);
    expect(await refused.text()).toContain("no verified email");
  });

  it("refuses a callback from another browser or with a forged state", async () => {
    const start = await app.request("/v1/hosted/signin?provider=github");
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const noCookie = await app.request(`/v1/hosted/callback/github?code=x@y.dev&state=${state}`);
    expect(noCookie.status).toBe(400);
    const forged = await app.request(
      `/v1/hosted/callback/github?code=x@y.dev&state=${state.slice(0, -2)}xx`,
      { headers: { cookie: (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "" } },
    );
    expect(forged.status).toBe(400);
  });

  it("hands the CLI a code on its loopback address that only its verifier exchanges", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const res = await browserSignIn(app, "laptop@cli.dev", {
      query: { cli_port: "49152", cli_state: "s".repeat(24), cli_challenge: challenge },
    });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location") ?? "");
    expect(back.origin).toBe("http://127.0.0.1:49152");
    expect(back.pathname).toBe("/callback");
    expect(back.searchParams.get("state")).toBe("s".repeat(24));
    const code = back.searchParams.get("code") ?? "";
    expect(code).not.toContain("selfhost_pt_");
    const exchange = (body: unknown) =>
      app.request("/v1/hosted/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const wrong = await exchange({ code, verifier: randomBytes(32).toString("base64url") });
    expect(wrong.status).toBe(401);
    const ok = await exchange({ code, verifier });
    expect(ok.status).toBe(200);
    const joined = (await ok.json()) as JoinResponse;
    expect(joined.person.id).toBe("laptop@cli.dev");
    expect((await caller(app, joined.token)("/v1/me")).status).toBe(200);
  });

  it("sends a refusal to the CLI's loopback address instead of a page", async () => {
    const challenge = createHash("sha256").update("v".repeat(43)).digest("base64url");
    const res = await browserSignIn(app, "a@b.dev", {
      invite: "selfhost_inv_unknown",
      query: { cli_port: "49153", cli_state: "t".repeat(24), cli_challenge: challenge },
    });
    const back = new URL(res.headers.get("location") ?? "");
    expect(back.searchParams.get("error")).toBe("Unknown invite code");
  });

  it("lets an org have 10 people with every feature and blocks the 11th with the paid plan notice", async () => {
    const owner = caller(app, await consoleToken(app, "owner@ten.dev"));
    const { team } = (await (await owner("/v1/me")).json()) as { team: { id: string } };
    const invite = async (email?: string) =>
      (
        (await (
          await owner(`/v1/teams/${team.id}/invites`, "POST", email ? { email } : {})
        ).json()) as { invite: string }
      ).invite;
    // Five join in the browser with email invites, four with a team-wide invite and the CLI.
    for (let i = 1; i <= 5; i++)
      await consoleToken(app, `p${i}@ten.dev`, await invite(`p${i}@ten.dev`));
    const shared = await invite();
    for (let i = 6; i <= 9; i++) {
      const res = await app.request("/v1/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite: shared, person: `p${i}@ten.dev` }),
      });
      expect(res.status).toBe(200);
    }
    const people = (await (await owner(`/v1/teams/${team.id}/people`)).json()) as {
      people: unknown[];
    };
    expect(people.people).toHaveLength(10);

    const eleventh = await app.request("/v1/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: shared, person: "p11@ten.dev" }),
    });
    expect(eleventh.status).toBe(402);
    const refused = (await eleventh.json()) as ApiError;
    expect(refused.error.code).toBe("seat_limit");
    expect(refused.error.message).toContain("up to 10 people");
    expect(refused.error.message).toContain("paid plan");

    const browser = await browserSignIn(app, "p12@ten.dev", {
      invite: await invite("p12@ten.dev"),
    });
    expect(browser.status).toBe(402);
    expect(await browser.text()).toContain("paid plan");

    // Someone already in the org signs in again, and a revoked seat is free again.
    expect((await browserSignIn(app, "p3@ten.dev")).status).toBe(302);
    expect((await owner(`/v1/teams/${team.id}/people/p9@ten.dev/tokens`, "DELETE")).status).toBe(
      200,
    );
    expect(
      (await browserSignIn(app, "p12@ten.dev", { invite: await invite("p12@ten.dev") })).status,
    ).toBe(302);
  });

  it("serves no model traffic and runs no background runs", async () => {
    const token = await consoleToken(app, "dev@nomodel.dev");
    const person = caller(app, token);
    for (const path of ["/llm/v1/chat/completions", "/llm/v1/messages"]) {
      const res = await app.request(path, { method: "POST", body: "{}" });
      expect(res.status, path).not.toBe(200);
      expect([401, 404]).toContain(res.status);
    }
    expect((await person("/v1/gateway/keys", "POST", {})).status).toBe(404);
    const { team } = (await (await person("/v1/me")).json()) as { team: { id: string } };
    const run = await person("/v1/background-runs", "POST", {
      team: team.id,
      repo: "a/b",
      prompt: "x",
    });
    expect(run.status).toBe(503);
  });

  it("keeps notification targets on hosted services and sealed with the org's key", async () => {
    const token = await consoleToken(app, "owner@notify.dev");
    const person = caller(app, token);
    const open = await person("/v1/notify/targets", "POST", {
      name: "hook",
      url: "json://10.0.0.5/x",
    });
    expect(open.status).toBe(403);
    expect(((await open.json()) as ApiError).error.message).toContain("hosted server");
    const ok = await person("/v1/notify/targets", "POST", {
      name: "tg",
      url: "tgram://123456:secret-bot-token/987",
    });
    expect(ok.status).toBe(201);
    const [row] = await databaseOf(ledger).query<{ url: string }>(
      "SELECT url FROM notify_targets WHERE person = 'owner@notify.dev'",
    );
    expect(row?.url).toMatch(/^sealed:v1:/);
    expect(row?.url).not.toContain("secret-bot-token");
    const listed = (await (await person("/v1/notify")).json()) as { targets: { name: string }[] };
    expect(listed.targets.map((t) => t.name)).toEqual(["tg"]);
  });

  it("refuses uploads once an org keeps as many events as its plan stores", async () => {
    const small = createApp({
      version: "test",
      ledger,
      token: TOKEN,
      hosted: { config: { ...CONFIG, maxEvents: 2 }, fetch: providers },
    });
    const token = await consoleToken(small, "full@storage.dev");
    const person = caller(small, token);
    const post = (events: LedgerEvent[]) => person("/v1/events", "POST", { events });
    expect((await post([event("full@storage.dev"), event("full@storage.dev")])).status).toBe(200);
    const full = await post([event("full@storage.dev")]);
    expect(full.status).toBe(507);
    expect(((await full.json()) as ApiError).error.code).toBe("storage_limit");
  });
});

// -------------------------------------------------------------------------------------------
// Events and settings only: no table or API field for subscription logins or provider keys.

/** Names that would hold a login or a key. */
const KEY_LIKE =
  /(api_?key|secret|password|passwd|credential|oauth|access_token|refresh_token|subscription|login|cookie|bearer|private_key)/i;

/**
 * API fields whose names match KEY_LIKE and hold no secret, each with why. Anything new that
 * matches fails until it is either renamed or added here with its reason.
 */
const KEY_LIKE_FIELDS: Record<string, string> = {
  api_key_env: "the NAME of an environment variable, never its value; hosted reads none",
  api_secret_env: "the NAME of an environment variable, never its value; hosted reads none",
  webhook_secret_env: "the NAME of an environment variable, never its value",
  credential: "which kind of short-lived credential a background run got (off in hosted)",
  secrets: "the guardrail that blocks secrets in tool calls",
  prod_credentials: "the guardrail that blocks production credentials in tool calls",
  github_logins: "GitHub usernames of reviewers",
};

/** Every property name of a TypeBox schema, with the schema it is in. */
function fieldNames(root: unknown): string[] {
  const names = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const props = (node as { properties?: Record<string, unknown> }).properties;
    if (props) for (const key of Object.keys(props)) names.add(key);
    for (const value of Object.values(node)) walk(value);
  };
  walk(root);
  return [...names];
}

describe("hosted stores events and settings only", () => {
  it("has no API field that holds a subscription login or a provider key", () => {
    const found = new Set<string>();
    for (const [name, value] of Object.entries(contracts)) {
      if (!name.endsWith("Schema")) continue;
      for (const field of fieldNames(value)) if (KEY_LIKE.test(field)) found.add(field);
    }
    expect([...found].filter((field) => !(field in KEY_LIKE_FIELDS))).toEqual([]);
  });

  it("has no table column that holds one", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const columns = await databaseOf(ledger).query<{ name: string }>(
        `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
         WHERE table_schema = current_schema()`,
      );
      expect(columns.length).toBeGreaterThan(50);
      expect(columns.map((c) => c.name).filter((name) => KEY_LIKE.test(name))).toEqual([]);
    } finally {
      await ledger.close();
    }
  });
});

// -------------------------------------------------------------------------------------------
// Two orgs: no API endpoint returns or changes the other org's rows.

/** Every operation in openapi.yaml, as method and path template. */
function operations(): { method: string; path: string }[] {
  const text = readFileSync(
    join(import.meta.dirname, "../../../packages/schema/openapi.yaml"),
    "utf8",
  );
  const found: { method: string; path: string }[] = [];
  let path: string | undefined;
  for (const line of text.split("\n")) {
    const p = /^ {2}(\/v1\/\S+):$/.exec(line);
    if (p?.[1]) {
      path = p[1];
      continue;
    }
    if (/^\S/.test(line)) path = undefined;
    const m = /^ {4}(get|post|put|patch|delete):$/.exec(line);
    if (path && m?.[1]) found.push({ method: m[1].toUpperCase(), path });
  }
  return found;
}

/** Strings only org B's data holds; no request of org A's carries them. */
const B_SECRETS = [
  "b-event-marker-7f3a",
  "b-policy-marker-91c2",
  "Bea Secretname",
  "b-bot-token-55e1",
];

/** Tables that hold org rows, with how to pick org B's. */
const B_ROWS: Record<string, string> = {
  orgs: "id = $1",
  teams: "org_id = $1",
  team_repos: "org_id = $1",
  people: "team_id IN (SELECT id FROM teams WHERE org_id = $1)",
  tokens: "team_id IN (SELECT id FROM teams WHERE org_id = $1)",
  events: "team IN (SELECT id FROM teams WHERE org_id = $1)",
  review_items: "team IN (SELECT id FROM teams WHERE org_id = $1)",
  context_proposals: "team_id IN (SELECT id FROM teams WHERE org_id = $1)",
  notify_targets: "org = $1",
  notify_settings: "org = $1",
  handoffs: "team IN (SELECT id FROM teams WHERE org_id = $1)",
  exception_grants: "team IN (SELECT id FROM teams WHERE org_id = $1)",
  roi_baselines: "team IN (SELECT id FROM teams WHERE org_id = $1)",
  org_keys: "org_id = $1",
};

async function rowsOf(ledger: Ledger, org: string): Promise<string> {
  const db = databaseOf(ledger);
  const out: Record<string, unknown> = {};
  for (const [table, where] of Object.entries(B_ROWS)) {
    out[table] = await asSystem(() =>
      db.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE ${where} ORDER BY 1`, [org]),
    );
  }
  return JSON.stringify(out);
}

interface TwoOrgs {
  app: Hono;
  ledger: Ledger;
  a: { token: string; team: string; org: string };
  b: { token: string; team: string; org: string; invite: string; session: string };
}

async function twoOrgs(ledger: Ledger): Promise<TwoOrgs> {
  const app = hostedApp(ledger);
  const aToken = await consoleToken(app, "alice@org-a.dev");
  const bToken = await consoleToken(app, "bob@org-b.dev");
  const me = async (token: string) =>
    ((await (await caller(app, token)("/v1/me")).json()) as { team: { id: string; org: string } })
      .team;
  const aTeam = await me(aToken);
  const bTeam = await me(bToken);
  const b = caller(app, bToken);
  const session = "b-session-1";
  // Org B's own data, written as org B does: through the API with its owner's token.
  expect(
    (
      await b(`/v1/policy?team=${bTeam.id}`, "PUT", {
        text: `# b-policy-marker-91c2\nversion = 1\n`,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await b(`/v1/teams/${bTeam.id}/repos`, "POST", {
        remote: "https://github.com/borg/secret-repo.git",
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await b("/v1/events", "POST", {
        events: [
          event("bob@org-b.dev", {
            session_id: session,
            repo: "borg/secret-repo",
            data: { note: "b-event-marker-7f3a" },
          }),
          event("bob@org-b.dev", {
            session_id: session,
            kind: "tool.called",
            tool: { name: "Bash", input_summary: "echo b-event-marker-7f3a" },
          }),
        ],
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await b("/v1/notify/targets", "POST", {
        name: "secret-repo",
        url: "tgram://123:b-bot-token-55e1/9",
      })
    ).status,
  ).toBe(201);
  const invite = (await (
    await b(`/v1/teams/${bTeam.id}/invites`, "POST", { email: "bea@org-b.dev" })
  ).json()) as { id: string; invite: string };
  // A second person in B, whose display name only B's rows hold.
  const bea = await consoleToken(app, "bea@org-b.dev", invite.invite);
  expect(bea).toBeTruthy();
  await databaseOf(ledger).query(
    "UPDATE people SET name = 'Bea Secretname' WHERE id = 'bea@org-b.dev'",
  );
  const second = (await (await b(`/v1/teams/${bTeam.id}/invites`, "POST", {})).json()) as {
    id: string;
  };
  return {
    app,
    ledger,
    a: { token: aToken, team: aTeam.id, org: aTeam.org },
    b: { token: bToken, team: bTeam.id, org: bTeam.org, invite: second.id, session },
  };
}

/** The body each write gets: enough to pass validation, so the route gets to the team check. */
const BODIES: Record<string, (h: TwoOrgs) => unknown> = {
  "POST /v1/events": (h) => ({
    events: [event("alice@org-a.dev", { team: h.b.team, session_id: h.b.session })],
  }),
  "PUT /v1/policy": () => ({ text: "version = 1\n" }),
  "PUT /v1/orgs/{org}/policy": () => ({ text: "version = 1\n" }),
  "PUT /v1/context": () => ({ files: [] }),
  "PUT /v1/orgs/{org}/context": () => ({ files: [] }),
  "POST /v1/teams/{team}/invites": () => ({}),
  "POST /v1/teams/{team}/repos": () => ({ remote: "https://github.com/attacker/taken.git" }),
  "POST /v1/teams/{team}/people": () => ({ person: "alice@org-a.dev", role: "owner" }),
  "PUT /v1/teams/{team}/people/{person}/role": () => ({ role: "member" }),
  "PATCH /v1/teams/{team}": () => ({ name: "taken over" }),
  "PUT /v1/integrations/{kind}": () => ({ tool: null }),
  "POST /v1/background-runs/kill": () => ({ scope: "team" }),
};

/** Set to see every response the sweep got. */
const SWEEP_LOG: ((line: string) => void) | undefined = undefined;

async function sweep(h: TwoOrgs): Promise<{ checked: number; leaks: string[] }> {
  const params: Record<string, string> = {
    team: h.b.team,
    org: h.b.org,
    person: "bob@org-b.dev",
    owner: "borg",
    name: "secret-repo",
    id: h.b.invite,
    run_id: h.b.session,
    provider: "github",
    kind: "tracer",
  };
  const ops = operations().sort((x, y) =>
    // Leaving the server last, so A's token works for every other call.
    x.path === "/v1/me/token" ? 1 : y.path === "/v1/me/token" ? -1 : 0,
  );
  const leaks: string[] = [];
  const a = caller(h.app, h.a.token);
  // Strict query validators refuse unknown parameters, so each route is tried with each of these.
  const queries = [
    "",
    `team=${h.b.team}`,
    `team=${h.b.team}&repo=borg/secret-repo`,
    `person=bob%40org-b.dev`,
    `session=${h.b.session}`,
    `org=${h.b.org}`,
  ];
  for (const { method, path } of ops) {
    const filled = path.replace(/\{(\w+)\}/g, (_, key: string) =>
      encodeURIComponent(params[key] ?? "x"),
    );
    const body =
      method === "GET" || method === "DELETE"
        ? undefined
        : (BODIES[`${method} ${path}`]?.(h) ?? {});
    for (const query of queries) {
      const res = await a(query ? `${filled}?${query}` : filled, method, body);
      const text = await res.text();
      SWEEP_LOG?.(`${res.status} ${method} ${path}?${query} ${text.slice(0, 100)}`);
      for (const secret of B_SECRETS) {
        if (text.includes(secret)) {
          leaks.push(`${method} ${path}?${query} (${res.status}) returned "${secret}"`);
        }
      }
    }
  }
  return { checked: ops.length, leaks };
}

async function expectIsolated(ledger: Ledger) {
  const h = await twoOrgs(ledger);
  const before = await rowsOf(ledger, h.b.org);
  for (const secret of B_SECRETS.slice(0, 3)) expect(before).toContain(secret);
  const { checked, leaks } = await sweep(h);
  expect(checked).toBeGreaterThanOrEqual(80);
  expect(leaks).toEqual([]);
  expect(await rowsOf(ledger, h.b.org)).toBe(before);
  // B still works as before.
  expect((await caller(h.app, h.b.token)("/v1/me")).status).toBe(200);
  return h;
}

describe("two orgs on a hosted server, app checks only (PGlite)", () => {
  it("no API endpoint returns or changes the other org's rows", async () => {
    const ledger = await openLedger({ dataDir: "memory://", secretKey: orgKeyWrapper(CONFIG) });
    try {
      await expectIsolated(ledger);
    } finally {
      await ledger.close();
    }
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
if (process.env.SELFHOST_TEST_REQUIRE_POSTGRES === "1" && !DATABASE_URL) {
  throw new Error("SELFHOST_TEST_REQUIRE_POSTGRES=1: set DATABASE_URL so the isolation test runs");
}

/**
 * Postgres as hosted runs it: the server connects as a role row-level security binds (not a
 * superuser, no BYPASSRLS) that owns the selfhost tables, in a schema of its own.
 */
describe.skipIf(!DATABASE_URL)(
  "two orgs on a hosted server, with row-level security (Postgres)",
  () => {
    const suffix = randomBytes(5).toString("hex");
    const role = `selfhost_tenant_${suffix}`;
    const password = randomBytes(12).toString("hex");
    let admin: postgres.Sql;
    let ledger: Ledger;

    beforeAll(async () => {
      admin = postgres(DATABASE_URL ?? "", { onnotice: () => {} });
      await admin.unsafe(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.unsafe(`CREATE SCHEMA ${role} AUTHORIZATION ${role}`);
      const url = new URL(DATABASE_URL ?? "");
      url.username = role;
      url.password = password;
      url.searchParams.set("search_path", role);
      ledger = await openLedger({ url: url.toString(), secretKey: orgKeyWrapper(CONFIG) });
      // As the hosted server does on start.
      expect(await enforceRowSecurity(databaseOf(ledger))).toBeUndefined();
    });

    afterAll(async () => {
      await ledger?.close();
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${role} CASCADE`);
      await admin.unsafe(`DROP OWNED BY ${role}`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    });

    it("starts only as a role row-level security binds, with FORCE on every table with policies", async () => {
      expect(await rowSecurityProblem(databaseOf(ledger))).toBeUndefined();
      const loose = await databaseOf(ledger).query<{ name: string }>(
        `SELECT relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relrowsecurity AND NOT c.relforcerowsecurity`,
      );
      expect(loose).toEqual([]);
      const forced = await databaseOf(ledger).query<{ name: string }>(
        `SELECT relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relforcerowsecurity`,
      );
      expect(forced).toHaveLength(18);
      expect(await enforceRowSecurity(databaseOf(ledger))).toBeUndefined();
      const superuser = await openLedger({
        url: `${DATABASE_URL}${DATABASE_URL?.includes("?") ? "&" : "?"}search_path=${role}`,
      });
      try {
        const [me] = await databaseOf(superuser).query<{ bypass: boolean }>(
          "SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user",
        );
        if (me?.bypass)
          expect(await rowSecurityProblem(databaseOf(superuser))).toMatch(/BYPASSRLS/);
      } finally {
        await superuser.close();
      }
    });

    it("no API endpoint returns or changes the other org's rows", async () => {
      const h = await expectIsolated(ledger);
      const db = databaseOf(ledger);

      // Under org A's scope the database itself shows none of B's rows, whatever the query.
      await withOrg(h.a.org, async () => {
        for (const [table, where] of Object.entries(B_ROWS)) {
          const [row] = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
            [h.b.org],
          );
          expect(Number(row?.n), table).toBe(0);
        }
        const [all] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM teams");
        expect(Number(all?.n)).toBe(1);
        // Writes into B's rows change nothing, and new rows for B are refused.
        expect(
          await db.query("UPDATE teams SET name = 'x' WHERE id = $1 RETURNING id", [h.b.team]),
        ).toEqual([]);
        expect(
          await db.query("DELETE FROM tokens WHERE team_id = $1 RETURNING hash", [h.b.team]),
        ).toEqual([]);
        await expect(
          db.query(
            "INSERT INTO people (team_id, id, role) VALUES ($1, 'mallory@evil.dev', 'owner')",
            [h.b.team],
          ),
        ).rejects.toThrow(/row-level security/);
        await expect(
          db.query(
            `INSERT INTO events (id, ts, source, kind, actor_kind, actor_id, body, team)
           VALUES (gen_random_uuid(), now(), 'hook', 'x', 'person', 'm', '{}', $1)`,
            [h.b.team],
          ),
        ).rejects.toThrow(/row-level security/);
        // A's own rows are there.
        const [own] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM people");
        expect(Number(own?.n)).toBe(1);
      });

      // With no scope (the server's own jobs, the admin token) every org's rows are there.
      const [teams] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM teams");
      expect(Number(teams?.n)).toBeGreaterThanOrEqual(2);
    });
  },
);
