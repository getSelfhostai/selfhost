import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScreenshotBrowser } from "../src/playwright.js";
import { givenPreview } from "../src/preview.js";
import { type RunReceiptOptions, runReceipt } from "../src/run.js";
import { receiptSettings } from "../src/settings.js";
import { config, SAMPLE_APP } from "./helpers.js";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const HEAD = "5786c5c9d81ca4218b7e44bf0007f5580f66c489";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the sample app in a temp folder, and a folder for the receipt's output. */
function sampleApp(): { root: string; outDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-receipt-"));
  dirs.push(dir);
  const root = join(dir, "repo");
  cpSync(SAMPLE_APP, root, { recursive: true });
  return { root, outDir: join(dir, "out") };
}

/** Writes a PNG for each page, with the status the page answered. */
function fakeBrowser(opened: string[]): () => Promise<ScreenshotBrowser> {
  return async () => ({
    async capture(url, file) {
      opened.push(url);
      const response = await fetch(url);
      await response.body?.cancel();
      writeFileSync(file, PNG);
      return { httpStatus: response.status, pageErrors: [] };
    },
    async close() {},
  });
}

function options(
  root: string,
  outDir: string,
  extra: Partial<RunReceiptOptions> & { toml?: string } = {},
): RunReceiptOptions {
  const { toml, ...rest } = extra;
  return {
    root,
    outDir,
    settings: receiptSettings(config(toml ?? readFileSync(join(root, "selfhost.toml"), "utf8"))),
    repo: "acme/sample-app",
    pull: { number: 7, url: "https://github.com/acme/sample-app/pull/7", head_sha: HEAD },
    changed: [
      { path: "src/greet.test.mjs", status: "modified" },
      { path: "pages/about.html", status: "modified" },
    ],
    branch: "agent/greeting",
    defaultBranch: "main",
    now: () => new Date("2026-11-08T12:00:00Z"),
    ...rest,
  };
}

describe("runReceipt on the sample app", () => {
  it("starts the app, runs the changed test and captures the mapped screens", async () => {
    const { root, outDir } = sampleApp();
    const opened: string[] = [];
    const receipt = await runReceipt(options(root, outDir, { browser: fakeBrowser(opened) }));

    expect(receipt.verdict).toBe("passed");
    expect(receipt.app).toMatchObject({ status: "started", command: "node server.mjs" });
    expect(receipt.app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/health$/);
    expect(receipt.tests).toEqual({
      runs: [
        expect.objectContaining({
          files: ["src/greet.test.mjs"],
          runner: "node",
          command: "node --test src/greet.test.mjs",
          cwd: ".",
          status: "passed",
          exit_code: 0,
        }),
      ],
      not_run: [],
    });
    expect(receipt.tests.runs[0]?.log).toBeUndefined();
    const origin = new URL(receipt.app.url ?? "").origin;
    expect(receipt.screens).toEqual({
      base_url: origin,
      source: "app",
      shots: [
        {
          path: "/about",
          url: `${origin}/about`,
          files: ["pages/about.html", "src/greet.test.mjs"],
          status: "captured",
          http_status: 200,
          image: "screens/about.png",
        },
        {
          path: "/",
          url: `${origin}/`,
          files: ["src/greet.test.mjs"],
          status: "captured",
          http_status: 200,
          image: "screens/home.png",
        },
      ],
    });
    expect(opened).toEqual([`${origin}/about`, `${origin}/`]);
    expect(existsSync(join(outDir, "screens", "about.png"))).toBe(true);
    expect(readFileSync(join(outDir, "logs", "app.log"), "utf8")).toContain(
      "sample app listening on",
    );
    expect(receipt.preview).toEqual({ status: "none" });
    expect(receipt.created_at).toBe("2026-11-08T12:00:00.000Z");
    // The app is stopped once the receipt is done.
    await expect(fetch(receipt.app.url ?? "")).rejects.toThrow();
  });

  it("says when a test fails and the app does not start, with their logs, masked", async () => {
    const { root, outDir } = sampleApp();
    writeFileSync(
      join(root, "src", "broken.test.mjs"),
      `import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("adds", () => assert.equal(1 + 1, 3));\n`,
    );
    const secret = ["sk", "-ant-", "api03-", "x".repeat(40)].join("");
    const toml = `version = 1
[receipt]
start = "echo 'starting with ${secret}'; echo 'Error: config missing' >&2; exit 3"
`;
    const receipt = await runReceipt(
      options(root, outDir, {
        toml,
        changed: [
          { path: "src/greet.test.mjs", status: "modified" },
          { path: "src/broken.test.mjs", status: "added" },
        ],
        browser: fakeBrowser([]),
      }),
    );

    expect(receipt.verdict).toBe("failed");
    expect(receipt.app).toMatchObject({
      status: "failed",
      exit_code: 3,
      error: expect.stringMatching(/^The start command exited with code 3 before http:/),
      log: { file: "logs/app.log", lines: 2 },
    });
    expect(receipt.app.log?.tail).toBe("starting with [redacted]\nError: config missing");
    expect(readFileSync(join(outDir, "logs", "app.log"), "utf8")).not.toContain(secret);
    expect(receipt.tests.runs.map((run) => [run.files[0], run.status])).toEqual([
      ["src/greet.test.mjs", "passed"],
      ["src/broken.test.mjs", "failed"],
    ]);
    const failed = receipt.tests.runs[1];
    expect(failed?.log?.file).toBe("logs/test-2-src-broken-test-mjs.log");
    expect(failed?.log?.tail).toContain("expected");
    expect(receipt.screens).toEqual({ source: "none", shots: [] });
    expect(receipt.notes).toContain(
      "The app did not start and there is no ready preview, so no screenshots.",
    );
  });

  it("captures the screens on the preview when the app is not started", async () => {
    const { root, outDir } = sampleApp();
    // The sample app, started by hand, stands in for the preview deployment.
    const server = spawn("node", ["server.mjs"], {
      cwd: root,
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      const port = await new Promise<number>((resolve) => {
        server.stdout?.on("data", (chunk: Buffer) => {
          const match = /listening on (\d+)/.exec(chunk.toString());
          if (match) resolve(Number(match[1]));
        });
      });
      const url = `http://127.0.0.1:${port}`;
      const opened: string[] = [];
      const receipt = await runReceipt(
        options(root, outDir, {
          toml: 'version = 1\n[receipt.screens]\n"pages/**" = ["/about", "/missing"]\n',
          preview: async () => givenPreview(url),
          browser: fakeBrowser(opened),
        }),
      );
      expect(receipt.app).toEqual({ status: "not_configured" });
      expect(receipt.preview).toEqual({ status: "ready", url, source: "input" });
      expect(receipt.screens.source).toBe("preview");
      expect(receipt.screens.shots.map((shot) => [shot.url, shot.status, shot.error])).toEqual([
        [`${url}/about`, "captured", undefined],
        [`${url}/missing`, "failed", "The page answered HTTP 404."],
      ]);
      expect(receipt.verdict).toBe("failed");
    } finally {
      server.kill();
    }
  });

  it("records every shot as failed when the browser does not start", async () => {
    const { root, outDir } = sampleApp();
    const receipt = await runReceipt(
      options(root, outDir, {
        browser: async () => {
          throw new Error("Executable doesn't exist at /ms-playwright/chromium\nmore");
        },
      }),
    );
    expect(receipt.screens.shots.map((shot) => [shot.status, shot.error])).toEqual([
      ["failed", "The browser did not start: Executable doesn't exist at /ms-playwright/chromium"],
      ["failed", "The browser did not start: Executable doesn't exist at /ms-playwright/chromium"],
    ]);
  });

  it("stops after a failed setup without starting the app or running tests", async () => {
    const { root, outDir } = sampleApp();
    const receipt = await runReceipt(
      options(root, outDir, {
        toml: `version = 1
[runtime]
setup = """
echo installing
false
echo never
"""
[runtime.run.web]
command = "node server.mjs"
`,
      }),
    );
    expect(receipt.verdict).toBe("failed");
    expect(receipt.setup).toMatchObject({ status: "failed", exit_code: 1 });
    expect(receipt.setup?.log?.tail).toBe("installing");
    expect(receipt.app).toEqual({
      status: "failed",
      command: "node server.mjs",
      error: "Not started, because setup failed.",
    });
    expect(receipt.tests).toEqual({
      runs: [],
      not_run: [{ path: "src/greet.test.mjs", reason: "Setup failed." }],
    });
  });

  it("does not start the app when the ready URL is not a URL", async () => {
    const { root, outDir } = sampleApp();
    const receipt = await runReceipt(
      options(root, outDir, {
        toml: 'version = 1\n[receipt]\nstart = "node server.mjs"\nready_url = "localhost:$SELFHOST_PORT"\n',
      }),
    );
    expect(receipt.app).toMatchObject({
      status: "failed",
      error: expect.stringMatching(
        /^Not started: the ready URL localhost:\d+ is not an http or https URL\.$/,
      ),
    });
  });

  it("gives up on an app that never answers and stops a test that runs too long", async () => {
    const { root, outDir } = sampleApp();
    const receipt = await runReceipt(
      options(root, outDir, {
        toml: `version = 1
[receipt]
start = "sleep 30"
ready_timeout_seconds = 1
test_command = "sleep 30"
test_timeout_seconds = 1
`,
      }),
    );
    expect(receipt.app).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/did not answer within 1 s\.$/),
    });
    expect(receipt.tests.runs).toEqual([
      expect.objectContaining({ runner: "custom", command: "sleep 30", status: "timed_out" }),
    ]);
  });
});
