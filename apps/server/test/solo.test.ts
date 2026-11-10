import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { SoloResponse } from "../src/solo.js";
import { caller, TOKEN } from "./helpers.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const done of cleanup.splice(0)) await done();
});

async function app(solo?: { policyPath?: string }) {
  const ledger: Ledger = await openLedger({ dataDir: "memory://" });
  cleanup.push(() => ledger.close());
  return caller(
    createApp({ version: "1.2.3", ledger, token: TOKEN, ...(solo ? { solo } : {}) }),
    TOKEN,
  );
}

describe("GET /v1/solo", () => {
  it("shows the laptop's selfhost.toml rules and integrations, read again on each request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "selfhost-solo-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "selfhost.toml");
    writeFileSync(
      path,
      [
        "version = 1",
        "[[rules]]",
        'id = "no-npm-publish"',
        "match = { command = 'npm publish' }",
        'action = "block"',
        'message = "CI publishes."',
        "[integrations.runtime]",
        'tool = "e2b"',
        "",
      ].join("\n"),
    );
    const admin = await app({ policyPath: path });
    const body = (await (await admin("/v1/solo")).json()) as SoloResponse;
    expect(body).toMatchObject({
      schema: "selfhost.solo/v1",
      team_init: "selfhost team init",
      policy: {
        path,
        valid: true,
        rules: [{ id: "no-npm-publish", mode: "observe", action: "block" }],
        guardrails: { mode: "enforce", disable: [] },
        integrations: { runtime: { tool: "e2b" } },
      },
    });
    writeFileSync(path, 'version = 1\n[guardrails]\nmode = "loud"\n');
    const invalid = (await (await admin("/v1/solo")).json()) as SoloResponse;
    expect(invalid.policy).toMatchObject({ path, valid: false });
    expect((await (await (await app({}))("/v1/solo")).json()) as SoloResponse).toMatchObject({
      policy: null,
    });
  });

  it("is not a route on a team server", async () => {
    expect((await (await app())("/v1/solo")).status).toBe(404);
  });
});
