import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Receipt } from "@selfhost/schema";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Harness, harness, previewDeployment } from "./harness.js";
import { SAMPLE_APP } from "./helpers.js";

// The bundled action (action/index.mjs) end to end, with real Playwright screenshots of the
// sample app: once with a preview deployment and once without. It needs playwright-core and
// Chromium, so it runs in the receipt job in CI (SELFHOST_RECEIPT_E2E=1), not in pnpm test.
const enabled = process.env.SELFHOST_RECEIPT_E2E === "1";
const BUNDLE = join(import.meta.dirname, "..", "action", "index.mjs");
const PNG_SIGNATURE = "89504e470d0a1a0a";

const run = promisify(execFile);

async function action(h: Harness, command: "run" | "report") {
  try {
    const { stdout } = await run("node", [BUNDLE, command], { env: h.env, timeout: 120_000 });
    return { code: 0, stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "" };
  }
}

describe.skipIf(!enabled)("the bundled receipt action with Playwright", () => {
  let preview: ChildProcess;
  let previewUrl: string;
  const open: Harness[] = [];

  beforeAll(async () => {
    // A second copy of the sample app stands in for the preview deployment's host.
    preview = spawn("node", ["server.mjs"], {
      cwd: SAMPLE_APP,
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const port = await new Promise<number>((resolve) => {
      preview.stdout?.on("data", (chunk: Buffer) => {
        const match = /listening on (\d+)/.exec(chunk.toString());
        if (match) resolve(Number(match[1]));
      });
    });
    previewUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    preview?.kill();
  });

  afterEach(async () => {
    for (const h of open.splice(0)) await h.close();
  });

  function check(h: Harness): Receipt {
    const dir = h.outputs().dir ?? "";
    const receipt = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8")) as Receipt;
    expect(receipt.app.status).toBe("started");
    expect(receipt.tests.runs.map((r) => [r.files[0], r.status])).toEqual([
      ["src/greet.test.mjs", "passed"],
    ]);
    expect(receipt.screens.source).toBe("app");
    expect(receipt.screens.shots.map((s) => [s.path, s.status, s.http_status, s.image])).toEqual([
      ["/about", "captured", 200, "screens/about.png"],
      ["/", "captured", 200, "screens/home.png"],
    ]);
    for (const shot of receipt.screens.shots) {
      const file = join(dir, shot.image ?? "");
      expect(existsSync(file), shot.image).toBe(true);
      expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
    }
    const html = readFileSync(join(dir, "receipt.html"), "utf8");
    expect(html.match(/src="data:image\/png;base64,/g)).toHaveLength(2);
    return receipt;
  }

  it("includes the preview link, the screenshots and the test result", async () => {
    const h = await harness({
      github: { deployments: [previewDeployment(previewUrl)] },
      inputs: { SCREENSHOTS: "true" },
    });
    open.push(h);
    const ran = await action(h, "run");
    expect(ran.code, ran.stdout).toBe(0);
    const receipt = check(h);
    expect(receipt.verdict).toBe("passed");
    expect(receipt.preview).toMatchObject({ status: "ready", url: previewUrl, name: "Preview" });

    const reported = await action(h, "report");
    expect(reported.code, reported.stdout).toBe(0);
    const body = h.github.state.comments[0]?.body ?? "";
    expect(body).toContain(`[${previewUrl}](${previewUrl}), from the \`Preview\` deployment`);
    expect(body).toContain("captured as `screens/about.png`, HTTP 200");
  });

  it("falls back to screenshots and logs without a preview environment", async () => {
    const h = await harness({ inputs: { SCREENSHOTS: "true" } });
    open.push(h);
    const ran = await action(h, "run");
    expect(ran.code, ran.stdout).toBe(0);
    const receipt = check(h);
    expect(receipt.preview).toEqual({ status: "none" });
    expect(readFileSync(join(h.outputs().dir ?? "", "logs", "app.log"), "utf8")).toContain(
      "sample app listening on",
    );

    const reported = await action(h, "report");
    expect(reported.code, reported.stdout).toBe(0);
    const body = h.github.state.comments[0]?.body ?? "";
    expect(body).toContain("No preview environment for this commit");
    expect(body).toContain("| `/` | captured as `screens/home.png`, HTTP 200 |");
    expect(h.summary()).toContain("## Proof receipt");
  });
});
