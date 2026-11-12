import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import { createApp } from "@selfhost/server/app";
import { afterEach, describe, expect, it } from "vitest";
import { joinSignedIn } from "../src/team/commands.js";
import { hostedSignin } from "../src/team/hosted.js";

const SERVER = "http://hosted.test";

/** GitHub as the server sees it here: the one-time code is the email that signs in. */
const github = async (url: string, init?: RequestInit): Promise<Response> => {
  const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (url.endsWith("/login/oauth/access_token")) {
    return Response.json({
      access_token: (JSON.parse(String(init?.body)) as { code: string }).code,
    });
  }
  if (url.endsWith("/user/emails"))
    return Response.json([{ email: bearer, primary: true, verified: true }]);
  return Response.json({ login: "x" });
};

const open: Ledger[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const ledger of open.splice(0)) await ledger.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

async function hostedServer(): Promise<App> {
  const ledger = await openLedger({ dataDir: "memory://" });
  open.push(ledger);
  return createApp({
    version: "test",
    ledger,
    token: "admin",
    hosted: {
      fetch: github,
      config: {
        publicUrl: SERVER,
        secretKey: Buffer.alloc(32, 3),
        providers: { github: { id: "id", secret: "secret" } },
        freeSeats: 10,
        retentionDays: 30,
        maxEvents: 1000,
        paidPlan: { notice: "More people need the paid plan.", url: null },
      },
    },
  });
}

/** A browser that signs in to GitHub as `email` and follows the redirect back to the CLI. */
function browser(app: App, email: string, seen: string[]) {
  return (page: string) => {
    void (async () => {
      const url = new URL(page);
      const start = await app.request(`${url.pathname}${url.search}&provider=github`);
      const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const back = await app.request(
        `/v1/hosted/callback/github?${new URLSearchParams({ code: email, state })}`,
        { headers: { cookie } },
      );
      const loopback = back.headers.get("location") ?? "";
      seen.push(loopback);
      await fetch(loopback);
    })();
  };
}

const appFetch = (app: App) => async (url: string, init: RequestInit) => app.request(url, init);

describe("selfhost init --hosted", () => {
  it("signs in in the browser and comes back to this machine's loopback only", async () => {
    const app = await hostedServer();
    const seen: string[] = [];
    const lines: string[] = [];
    const joined = await hostedSignin(SERVER, {
      fetch: appFetch(app),
      write: (line) => lines.push(line),
      openBrowser: browser(app, "owner@laptop.dev", seen),
    });
    expect(joined.person).toMatchObject({ id: "owner@laptop.dev", role: "owner" });
    expect(joined.token).toMatch(/^selfhost_pt_/);
    expect(seen[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\?state=[\w-]+&code=/);
    expect(seen[0]).not.toContain(joined.token);
    expect(lines[0]).toBe(`Sign in to ${SERVER} in your browser. If it does not open, go to:`);
    expect(lines[1]).toMatch(/\/v1\/hosted\/signin\?cli_port=\d+&cli_state=[\w-]+&cli_challenge=/);
  });

  it("saves the membership as joining with an invite does", async () => {
    const app = await hostedServer();
    const dir = mkdtempSync(join(tmpdir(), "selfhost-hosted-"));
    dirs.push(dir);
    const configPath = join(dir, "config.json");
    const report = await joinSignedIn(
      SERVER,
      (server) =>
        hostedSignin(server, {
          fetch: appFetch(app),
          write: () => {},
          openBrowser: browser(app, "dev@laptop.dev", []),
        }),
      { json: true },
      { env: {}, write: () => {}, configPath, fetch: appFetch(app) },
    );
    expect(report).toMatchObject({ server: SERVER, person: "dev@laptop.dev", role: "owner" });
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved).toMatchObject({ server: SERVER, person: "dev@laptop.dev", team: report.team.id });
    expect(saved.token).toMatch(/^selfhost_pt_/);
    await expect(
      joinSignedIn(
        SERVER,
        () => Promise.reject(new Error("not called")),
        {},
        {
          env: {},
          write: () => {},
          configPath,
          fetch: appFetch(app),
        },
      ),
    ).rejects.toThrow(/Already in team/);
  });

  it("says why when the sign-in is refused, and gives up after the timeout", async () => {
    const refusing = (page: string) => {
      const url = new URL(page);
      const port = url.searchParams.get("cli_port");
      const state = url.searchParams.get("cli_state") ?? "";
      void fetch(`http://127.0.0.1:${port}/callback?state=${state}&error=This%20org%20is%20full`);
    };
    await expect(
      hostedSignin(SERVER, {
        fetch: () => Promise.reject(new Error("no")),
        write: () => {},
        openBrowser: refusing,
      }),
    ).rejects.toThrow("Not signed in: This org is full");
    await expect(
      hostedSignin(SERVER, {
        fetch: () => Promise.reject(new Error("no")),
        write: () => {},
        openBrowser: () => {},
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/No sign-in within/);
  });
});
