import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import type { CreateTeamResponse, JoinResponse, MeResponse } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { findConsoleDir } from "../src/console.js";
import { EMAIL_HEADER, SECRET_HEADER, signinFromEnv } from "../src/signin.js";
import { caller, TOKEN } from "./helpers.js";

const SECRET = "s".repeat(40);

function builtConsole(): string {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-console-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>selfhost console</title>");
  writeFileSync(join(dir, "assets", "index-abc.js"), "console.log('hi')");
  return dir;
}

describe("the console", () => {
  let ledger: Ledger;
  const dir = builtConsole();

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
  });

  afterAll(async () => {
    await ledger.close();
  });

  it("is served at / with no token, never cached, under a strict policy", async () => {
    const app = createApp({ version: "test", ledger, token: TOKEN, console: { dir } });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>selfhost console</title>");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // A bookmarked view with its filters is the same page.
    expect((await app.request("/?view=model&team=web")).status).toBe(200);
  });

  it("serves its hashed assets for a year, and nothing outside its folder", async () => {
    const app = createApp({ version: "test", ledger, token: TOKEN, console: { dir } });
    const asset = await app.request("/assets/index-abc.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    expect((await app.request("/assets/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
  });

  it("sends an older /runs/<id> link to the run view, where the page's assets load", async () => {
    const app = createApp({ version: "test", ledger, token: TOKEN, console: { dir } });
    const res = await app.request("/runs/0199f2a4-6c1d-7e3b-9f20-5b8c7d6e4a31");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe("../?screen=run&run=0199f2a4-6c1d-7e3b-9f20-5b8c7d6e4a31");
    const target = new URL(location, "http://127.0.0.1:4400/runs/0199f2a4");
    expect(`${target.pathname}${target.search}`).toBe(
      "/?screen=run&run=0199f2a4-6c1d-7e3b-9f20-5b8c7d6e4a31",
    );
    expect((await app.request("/runs/sess%201")).headers.get("location")).toBe(
      "../?screen=run&run=sess%201",
    );
    // A run's link is the console's own route for its run view.
    const { runViewUrl } = await import("@selfhost/traces");
    expect(runViewUrl("http://127.0.0.1:4400/", "abc")).toBe(
      "http://127.0.0.1:4400/?screen=run&run=abc",
    );
  });

  it("keeps /v1 behind its tokens", async () => {
    const app = createApp({ version: "test", ledger, token: TOKEN, console: { dir } });
    expect((await app.request("/v1/events")).status).toBe(401);
    expect((await app.request("/v1/nope")).status).toBe(401);
    expect((await caller(app, TOKEN)("/v1/nope")).status).toBe(404);
  });

  it("says so when it is not built, and is off without the option", async () => {
    const missing = createApp({
      version: "test",
      ledger,
      token: TOKEN,
      console: { dir: undefined },
    });
    const res = await missing.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("the web console is not built");
    const off = createApp({ version: "test", ledger, token: TOKEN });
    expect((await off.request("/")).status).toBe(401);
  });

  it("is found from SELFHOST_CONSOLE_DIR first", () => {
    expect(findConsoleDir({ SELFHOST_CONSOLE_DIR: dir })).toBe(dir);
    expect(findConsoleDir({ SELFHOST_CONSOLE_DIR: join(dir, "assets") })).not.toBe(
      join(dir, "assets"),
    );
  });
});

describe("console sign-in through a proxy", () => {
  let ledger: Ledger;
  let alice: string;

  const signedIn = (email: string, secret = SECRET) => ({
    [EMAIL_HEADER]: email,
    [SECRET_HEADER]: secret,
  });

  const appWith = (signin = true) =>
    createApp({
      version: "test",
      ledger,
      token: TOKEN,
      ...(signin ? { signin: { secret: SECRET } } : {}),
    });

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    const app = appWith();
    const admin = caller(app, TOKEN);
    const team = (await (
      await admin("/v1/teams", "POST", { name: "Web" })
    ).json()) as CreateTeamResponse;
    const join = async (person: string) => {
      const res = await app.request("/v1/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite: team.invite, person }),
      });
      return ((await res.json()) as JoinResponse).token;
    };
    alice = await join("alice@example.com");
    const bob = await join("bob@example.com");
    expect((await caller(app, bob)("/v1/me/token", "DELETE")).status).toBe(200);
  });

  afterAll(async () => {
    await ledger.close();
  });

  it("reads as the person the proxy names, ignoring case", async () => {
    const app = appWith();
    const res = await app.request("/v1/me", { headers: signedIn("Alice@Example.com") });
    expect(res.status).toBe(200);
    const me = (await res.json()) as MeResponse;
    expect(me).toMatchObject({
      kind: "person",
      person: { id: "alice@example.com" },
      role: "owner",
    });
    const usage = await app.request("/v1/usage", { headers: signedIn("alice@example.com") });
    expect(usage.status).toBe(200);
    expect(((await usage.json()) as { teams: string[] }).teams).toEqual(["web"]);
  });

  it("trusts the email only with the proxy's secret", async () => {
    const app = appWith();
    expect(
      (await app.request("/v1/me", { headers: signedIn("alice@example.com", "x".repeat(40)) }))
        .status,
    ).toBe(401);
    expect(
      (await app.request("/v1/me", { headers: { [EMAIL_HEADER]: "alice@example.com" } })).status,
    ).toBe(401);
    expect(
      (await appWith(false).request("/v1/me", { headers: signedIn("alice@example.com") })).status,
    ).toBe(401);
  });

  it("only reads: writes still need a token", async () => {
    const app = appWith();
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { ...signedIn("alice@example.com"), "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses someone with no access, or whose tokens were all revoked", async () => {
    const app = appWith();
    for (const email of ["mallory@example.com", "bob@example.com"]) {
      const res = await app.request("/v1/me", { headers: signedIn(email) });
      expect(res.status, email).toBe(403);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
        `signed in as ${email}`,
      );
    }
  });

  it("lets a bearer token win over the forwarded email", async () => {
    const app = appWith();
    const res = await app.request("/v1/me", {
      headers: { ...signedIn("bob@example.com"), authorization: `Bearer ${alice}` },
    });
    expect(((await res.json()) as MeResponse).person?.id).toBe("alice@example.com");
  });

  it("needs a long secret to turn on", () => {
    expect(signinFromEnv({})).toBeUndefined();
    expect(signinFromEnv({ SELFHOST_SIGNIN_PROXY_SECRET: SECRET })).toEqual({ secret: SECRET });
    expect(() => signinFromEnv({ SELFHOST_SIGNIN_PROXY_SECRET: "short" })).toThrow(/at least 32/);
  });
});
