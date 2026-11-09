import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONNECT_CHECK, connectCheck, standInSession } from "../src/connect.js";
import { tempDir } from "../src/exec.js";
import type { VendorRun } from "../src/types.js";

// Stand-ins for the CLIs: each reads the settings selfhost gateway connect wrote the way the CLI
// does, and sends one model request. The real CLIs run in the vendor compatibility workflow.

const CLAUDE = `
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const env = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8")).env;
fetch(env.ANTHROPIC_BASE_URL + "/v1/messages", {
  method: "POST",
  headers: { authorization: "Bearer " + env.ANTHROPIC_AUTH_TOKEN },
  body: "{}",
}).then((res) => process.exit(res.status === 401 ? 1 : 0));
`;

const CODEX = `
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const text = readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8");
const pick = (key) => new RegExp(key + ' = "([^"]+)"').exec(text)[1];
fetch(pick("base_url") + "/responses", {
  method: "POST",
  headers: { authorization: "Bearer " + pick("experimental_bearer_token") },
  body: "{}",
}).then(() => process.exit(1));
`;

const HANGS = "setInterval(() => {}, 1000);";

function fakeCli(source: string): string {
  const file = join(tempDir("fake-cli"), "cli");
  writeFileSync(file, `#!${process.execPath}\n${source}`);
  chmodSync(file, 0o755);
  return file;
}

describe("gateway connect against a stand-in gateway", () => {
  it("passes when the model request carries the virtual key to the gateway's address", async () => {
    const installed: VendorRun = { vendor: "claude_code", version: "2.1.319", checks: [] };
    installed.bin = fakeCli(CLAUDE);
    await connectCheck(installed);
    expect(installed.checks).toEqual([
      {
        id: CONNECT_CHECK,
        status: "pass",
        detail: expect.stringContaining(
          "POST /llm/anthropic/v1/messages reached the stand-in gateway with the virtual key in authorization",
        ),
      },
    ]);
  });

  it("reads Codex's provider from the block at the top of config.toml", async () => {
    const installed: VendorRun = { vendor: "codex", version: "0.167.0", checks: [] };
    installed.bin = fakeCli(CODEX);
    await connectCheck(installed);
    expect(installed.checks[0]).toMatchObject({ status: "pass" });
  });

  it("fails a request without the key, and a CLI that sends none", async () => {
    const keyless = await standInSession(
      "claude_code",
      fakeCli(CLAUDE.replace("Bearer", "Basic")),
      [],
      {
        expect: "/llm/anthropic/v1/messages",
        timeoutMs: 10_000,
      },
    );
    expect(keyless.matched).toBe(false);
    expect(keyless.seen).toEqual([
      { method: "POST", path: "/llm/anthropic/v1/messages", keyIn: null },
    ]);

    const silent = await standInSession("claude_code", fakeCli(HANGS), [], {
      expect: "/llm/anthropic/v1/messages",
      timeoutMs: 1_000,
    });
    expect(silent).toMatchObject({ matched: false, seen: [], error: "no model request within 1s" });
  });

  it("adds no check for Cursor, which can't use a gateway", async () => {
    const installed: VendorRun = { vendor: "cursor", version: "2026.11.01-abc1234", checks: [] };
    installed.bin = fakeCli(HANGS);
    await connectCheck(installed);
    expect(installed.checks).toEqual([]);
  });
});
