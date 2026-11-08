import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConsoleReport } from "../src/console.js";
import { run, tempDir } from "./run.js";

describe("selfhost console", () => {
  it("serves the console and the API on the local ledger, signed in, until stopped", async () => {
    const data = tempDir("console-data");
    let stop = () => {};
    let report: ConsoleReport | undefined;
    const opened: string[] = [];
    const checks: Promise<void>[] = [];
    const result = run(["console", "--port", "0", "--data-dir", data.root, "--json"], {
      openBrowser: (url) => opened.push(url),
      untilStopped: () =>
        new Promise<void>((resolve) => {
          stop = resolve;
        }),
      write: (line) => {
        report = JSON.parse(line) as ConsoleReport;
        const signedIn = new URL(report.url);
        const token = decodeURIComponent(signedIn.hash.replace(/^#token=/, ""));
        const base = `${signedIn.origin}/`;
        checks.push(
          (async () => {
            expect(token).toBe(report?.token);
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
    expect(opened).toEqual([report?.url]);
  });

  it("refuses a port that is not one", async () => {
    const { code, err } = await run(["console", "--port", "http"]);
    expect(code).toBe(1);
    expect(err).toContain('--port: expected a port from 0 to 65535, got "http"');
  });
});
