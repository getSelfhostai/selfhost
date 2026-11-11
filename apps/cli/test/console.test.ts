import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConsoleReport } from "../src/console.js";
import { saveMembership } from "../src/team/config.js";
import { run, tempDir } from "./run.js";

describe("selfhost console", () => {
  it("serves the console and the API on the local ledger, signed in, until stopped", async () => {
    const data = tempDir("console-data");
    let stop = () => {};
    let report: ConsoleReport | undefined;
    const opened: string[] = [];
    const checks: Promise<void>[] = [];
    const args = ["console", "--port", "0", "--data-dir", data.root, "--json", "--show-token"];
    const result = run(args, {
      openBrowser: (url) => opened.push(url),
      untilStopped: () =>
        new Promise<void>((resolve) => {
          stop = resolve;
        }),
      write: (line) => {
        report = JSON.parse(line) as ConsoleReport;
        const signedIn = new URL(report.signed_in_url ?? "");
        const token = decodeURIComponent(signedIn.hash.replace(/^#token=/, ""));
        const base = `${signedIn.origin}/`;
        checks.push(
          (async () => {
            expect(token).toBe(report?.token);
            expect(report?.url).toBe(`${signedIn.origin}/`);
            expect(readFileSync(data.path("token"), "utf8").trim()).toBe(token);
            expect(signedIn.hostname).toBe("127.0.0.1");
            const page = await fetch(base);
            expect(page.status).toBe(200);
            expect(page.headers.get("content-type")).toMatch(/text\/html/);
            expect((await fetch(`${base}v1/usage`)).status).toBe(401);
            const usage = await fetch(`${base}v1/usage?group_by=person`, {
              headers: { authorization: `Bearer ${token}` },
            });
            expect(usage.status).toBe(200);
            expect(await usage.json()).toMatchObject({ org: "default", teams: null, rows: [] });
          })().finally(() => stop()),
        );
      },
    });
    const { code, err } = await result;
    await Promise.all(checks);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(report).toMatchObject({ schema: "selfhost.console/v1", token_file: data.path("token") });
    expect(opened).toEqual([report?.signed_in_url]);
  });

  it("in a team, opens the team server's console signed in with the person token", async () => {
    const home = tempDir("console-team");
    const configPath = home.path("config.json");
    saveMembership(configPath, {
      server: "https://selfhost.acme.dev",
      token: "selfhost_person_abc",
      person: "dev@acme.dev",
      team: "web",
    });
    const opened: string[] = [];
    const { code, out } = await run(["console"], {
      configPath,
      openBrowser: (url) => opened.push(url),
    });
    expect(code).toBe(0);
    const link = "https://selfhost.acme.dev/#token=selfhost_person_abc";
    expect(out).toContain(
      "Team web console at https://selfhost.acme.dev/, signed in as dev@acme.dev.",
    );
    expect(out).toContain(`Signed-in link: ${link}`);
    expect(opened).toEqual([link]);
    // JSON lands in logs and scripts: no token in it unless --show-token asks.
    const json = await run(["console", "--json", "--no-open"], { configPath });
    expect(json.out).not.toContain("selfhost_person_abc");
    const report = JSON.parse(json.out) as ConsoleReport;
    expect(report).toMatchObject({ mode: "team", url: "https://selfhost.acme.dev/" });
    expect(report).not.toHaveProperty("token");
    expect(report).not.toHaveProperty("signed_in_url");
    const shown = await run(["console", "--json", "--show-token", "--no-open"], { configPath });
    expect(JSON.parse(shown.out)).toMatchObject({
      token: "selfhost_person_abc",
      signed_in_url: link,
    });
  });

  it("refuses a port that is not one", async () => {
    const { code, err } = await run(["console", "--port", "http"]);
    expect(code).toBe(1);
    expect(err).toContain('--port: expected a port from 0 to 65535, got "http"');
  });
});
