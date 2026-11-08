import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Receipt } from "@selfhost/schema";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/action/main.js";
import { RECEIPT_MARKER } from "../src/render.js";
import { OIDC_TOKEN } from "./fake-github.js";
import {
  type Harness,
  type HarnessOptions,
  HEAD,
  harness,
  PULL,
  previewDeployment,
  REPO,
} from "./harness.js";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function setup(options: HarnessOptions = {}): Promise<Harness> {
  const h = await harness(options);
  open.push(h);
  return h;
}

async function action(h: Harness, command: "run" | "report", env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const code = await main(command, { env: { ...h.env, ...env }, log: (line) => lines.push(line) });
  return { code, lines };
}

const receiptOf = (h: Harness): Receipt =>
  JSON.parse(readFileSync(join(h.outputs().dir ?? "", "receipt.json"), "utf8"));

describe("the receipt action", () => {
  it("makes a receipt with the preview link and comments it on the pull request", async () => {
    const h = await setup({
      github: { deployments: [previewDeployment("https://sample-app-git-greeting.vercel.app")] },
    });
    const ran = await action(h, "run");
    expect(ran.code).toBe(0);
    expect(h.outputs()).toMatchObject({ verdict: "passed" });
    const dir = h.outputs().dir ?? "";
    for (const file of ["receipt.json", "receipt.md", "receipt.html", "logs/app.log"]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    const receipt = receiptOf(h);
    expect(receipt).toMatchObject({
      repo: REPO,
      pull: { number: PULL, head_sha: HEAD },
      verdict: "passed",
      ci: {
        run_url: `https://github.com/${REPO}/actions/runs/9001/attempts/1`,
        run_id: "9001",
        attempt: 1,
        workflow: "CI",
      },
      artifact: { name: "selfhost-receipt" },
      app: { status: "started", command: "node server.mjs" },
      preview: {
        status: "ready",
        url: "https://sample-app-git-greeting.vercel.app",
        source: "deployment",
        provider: "vercel",
      },
    });
    expect(receipt.tests.runs.map((run) => [run.files, run.status])).toEqual([
      [["src/greet.test.mjs"], "passed"],
    ]);
    expect(receipt.notes).toContain("Screenshots are turned off.");

    const reported = await action(h, "report", {
      SELFHOST_RECEIPT_ARTIFACT_URL: `https://github.com/${REPO}/actions/runs/9001/artifacts/5`,
    });
    expect(reported.code).toBe(0);
    const [comment] = h.github.state.comments;
    expect(h.github.state.comments).toHaveLength(1);
    expect(comment?.body.startsWith(`${RECEIPT_MARKER}\n## Proof receipt`)).toBe(true);
    expect(comment?.body).toContain("https://sample-app-git-greeting.vercel.app");
    expect(comment?.body).toContain(
      `[selfhost-receipt](https://github.com/${REPO}/actions/runs/9001/artifacts/5)`,
    );
    expect(h.outputs()["comment-url"]).toBe(comment?.html_url);
    expect(h.summary()).toContain("## Proof receipt");
    expect(h.summary()).not.toContain(RECEIPT_MARKER);

    // A second report edits the same comment.
    await action(h, "report");
    expect(h.github.state.comments).toHaveLength(1);
    expect(h.github.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });

  it("says there is no preview when the commit has no deployment", async () => {
    const h = await setup();
    await action(h, "run");
    expect(receiptOf(h).preview).toEqual({ status: "none" });
    await action(h, "report");
    expect(h.github.state.comments[0]?.body).toContain("No preview environment for this commit");
  });

  it("posts the receipt to the selfhost server with the job's OIDC token", async () => {
    const h = await setup({
      github: {
        receipts: {
          status: 201,
          body: {
            id: "0193f0a0-0000-4000-8000-000000000001",
            url: "https://selfhost.example.com/v1/receipts/0193f0a0-0000-4000-8000-000000000001",
            comment_url: `https://github.com/${REPO}/pull/${PULL}#issuecomment-1`,
            brief: "updated",
          },
        },
      },
    });
    await action(h, "run");
    const reported = await action(h, "report", {
      INPUT_SERVER_URL: `${h.github.url}/`,
    });
    expect(reported.code).toBe(0);
    expect(h.github.state.posted).toHaveLength(1);
    expect(h.github.state.posted[0]?.authorization).toBe(`Bearer ${OIDC_TOKEN}:${h.github.url}`);
    expect(h.github.state.posted[0]?.body).toMatchObject({ repo: REPO, verdict: "passed" });
    // The server's App commented, so the workflow token does not.
    expect(h.github.state.comments).toEqual([]);
    expect(h.outputs()["comment-url"]).toBe(
      `https://github.com/${REPO}/pull/${PULL}#issuecomment-1`,
    );
  });

  it("leaves a receipt for an older commit to the server, with no comment", async () => {
    const h = await setup({
      github: {
        receipts: {
          status: 202,
          body: { id: "0193f0a0-0000-4000-8000-000000000002", url: "u", brief: "stale" },
        },
      },
    });
    await action(h, "run");
    const reported = await action(h, "report", { INPUT_SERVER_URL: h.github.url });
    expect(reported.lines).toContain(
      "receipt: the pull request has a newer head commit, so the server only stored it",
    );
    expect(h.github.state.comments).toEqual([]);
  });

  it("comments with the workflow token when the server refuses the receipt", async () => {
    const h = await setup({
      github: {
        receipts: {
          status: 403,
          body: {
            error: { code: "forbidden", message: "The App is not installed on acme/sample-app" },
          },
        },
      },
    });
    await action(h, "run");
    const reported = await action(h, "report", { INPUT_SERVER_URL: h.github.url });
    expect(reported.lines.join("\n")).toContain("::warning::Could not post the receipt to");
    expect(reported.lines.join("\n")).toContain("The App is not installed on acme/sample-app");
    expect(h.github.state.comments).toHaveLength(1);
  });

  it("fails the job when a test fails, unless fail-on-failure is false", async () => {
    const h = await setup({
      prepare: (root) =>
        writeFileSync(
          join(root, "src", "greet.test.mjs"),
          `import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("greets", () => assert.equal(1, 2));\n`,
        ),
    });
    await action(h, "run");
    expect(h.outputs().verdict).toBe("failed");
    const reported = await action(h, "report");
    expect(reported.code).toBe(1);
    expect(reported.lines.at(-1)).toBe("::error::Proof receipt: Failed. 1 of 1 test run failed.");
    expect(h.github.state.comments[0]?.body).toContain("| **failed** | `src/greet.test.mjs` |");
    expect((await action(h, "report", { INPUT_FAIL_ON_FAILURE: "false" })).code).toBe(0);
  });

  it("skips pull requests that are not an agent's, and events that are not pull requests", async () => {
    const person = await setup({ headRef: "feature/greeting" });
    const ran = await action(person, "run");
    expect(ran.code).toBe(0);
    expect(person.outputs()).toEqual({ skipped: "true" });
    expect(person.summary()).toContain("is not an agent pull request");
    expect(person.github.requests).toEqual([]);

    const all = await setup({ headRef: "feature/greeting", inputs: { AGENT_ONLY: "false" } });
    await action(all, "run");
    expect(all.outputs().verdict).toBe("passed");

    const push = await setup({ event: "push" });
    await action(push, "run");
    expect(push.outputs()).toEqual({ skipped: "true" });
  });

  it("notes an invalid selfhost.toml and falls back to the inputs", async () => {
    const h = await setup({
      prepare: (root) =>
        writeFileSync(join(root, "selfhost.toml"), "version = 1\n[receipt]\nport = 0\n"),
      inputs: { START: "node server.mjs", READY_URL: "http://127.0.0.1:$SELFHOST_PORT/health" },
    });
    const ran = await action(h, "run");
    expect(ran.lines).toContain(
      "::error file=selfhost.toml,line=3::receipt.port: Expected integer to be greater or equal to 1",
    );
    const receipt = receiptOf(h);
    expect(receipt.notes[0]).toMatch(/^selfhost\.toml is not valid \(receipt\.port: /);
    expect(receipt.app.status).toBe("started");
    expect(receipt.screens.shots).toEqual([]);
  });
});
