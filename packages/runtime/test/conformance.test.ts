import { describe, expect, it } from "vitest";
import { PTY_BOOTSTRAP } from "../src/adapters/coder.js";
import {
  CONFORMANCE_CHECKS,
  coderRuntime,
  conformanceFailures,
  daytonaRuntime,
  e2bRuntime,
  envSecrets,
  fakeRuntime,
  modalRuntime,
  openSandboxRuntime,
  type RuntimeAdapter,
  runConformance,
} from "../src/index.js";
import {
  Cloud,
  e2bLogs,
  fakeCoder,
  fakeDaytona,
  fakeE2B,
  fakeModal,
  fakeOpenSandbox,
} from "./fakes.js";
import { runShell } from "./shell.js";

const secrets = envSecrets({});
const credentials = { key: "test-key", keyEnv: "TEST_KEY" };
const fast = { execTimeoutMs: 200, readyTimeoutMs: 2000 };

async function conforms(adapter: RuntimeAdapter) {
  const report = await runConformance(adapter, fast);
  expect(conformanceFailures(report)).toBe("");
  expect(report.checks.map((check) => check.name)).toEqual([...CONFORMANCE_CHECKS]);
  return report;
}

describe("conformance", () => {
  it("fakeRuntime passes every check", async () => {
    const runtime = fakeRuntime({
      exec: (command, sandbox, options) => runShell(command, sandbox, options),
    });
    const report = await conforms(runtime);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("the E2B adapter passes against the SDK's shape", async () => {
    const cloud = new Cloud("e2b");
    await conforms(
      e2bRuntime({
        settings: {},
        credentials,
        secrets,
        load: async () => fakeE2B(cloud),
        fetch: e2bLogs,
        logPollMs: 10,
      }),
    );
  });

  it("the Daytona adapter passes against the SDK's shape", async () => {
    const cloud = new Cloud("daytona");
    await conforms(
      daytonaRuntime({ settings: {}, credentials, secrets, load: async () => fakeDaytona(cloud) }),
    );
  });

  it("the Modal adapter passes against the SDK's shape", async () => {
    const cloud = new Cloud("modal");
    await conforms(
      modalRuntime({
        settings: {},
        credentials: { ...credentials, secret: "as-test" },
        secrets,
        load: async () => fakeModal(cloud),
        logPollMs: 10,
      }),
    );
  });

  it("the OpenSandbox adapter passes against the SDK's shape", async () => {
    const cloud = new Cloud("osb");
    await conforms(
      openSandboxRuntime({
        settings: { url: "http://localhost:8080" },
        credentials: { key: "", keyEnv: "OPEN_SANDBOX_API_KEY" },
        secrets,
        load: async () => fakeOpenSandbox(cloud),
      }),
    );
  });

  it("the Coder adapter passes over the REST API and the agent PTY", async () => {
    const cloud = new Cloud("ws");
    const coder = fakeCoder(cloud);
    const report = await conforms(
      coderRuntime({
        settings: { url: coder.base, template: "docker" },
        credentials: { key: coder.token, keyEnv: "CODER_SESSION_TOKEN" },
        secrets,
        fetch: coder.fetch,
        webSocket: coder.webSocket,
        logPollMs: 5,
      }),
    );
    const skipped = report.checks.filter((check) => check.status === "skip").map((c) => c.name);
    expect(skipped).toEqual(["list.labels", "snapshot"]);
    // Commands and their environment go over the socket, never in a URL.
    expect(coder.urls.length).toBeGreaterThan(0);
    for (const url of coder.urls) {
      expect(new URL(url).searchParams.get("command")).toBe(PTY_BOOTSTRAP);
    }
    expect(coder.urls.join("\n")).not.toContain("SELFHOST_CONFORMANCE");
  });

  it("reports a failing adapter instead of throwing, and still stops the sandbox", async () => {
    const runtime = fakeRuntime(); // answers every command with exit 0 and no output
    const report = await runConformance(runtime, fast);
    expect(report.ok).toBe(false);
    expect(conformanceFailures(report)).toContain("exec.stdout");
    expect(await runtime.list()).toEqual([]);
  });
});

/**
 * The same suite against real provider accounts. Each runs only when its credentials are set
 * where the tests run, so CI and laptops without them skip it; it makes one small sandbox and
 * stops it.
 */
const env = process.env;
const real: [string, boolean, () => Promise<RuntimeAdapter>][] = [
  [
    "e2b",
    Boolean(env.E2B_API_KEY),
    async () => (await import("../src/open.js")).openRuntime("e2b", {}, { env }),
  ],
  [
    "daytona",
    Boolean(env.DAYTONA_API_KEY),
    async () => (await import("../src/open.js")).openRuntime("daytona", {}, { env }),
  ],
  [
    "modal",
    Boolean(env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET),
    async () => (await import("../src/open.js")).openRuntime("modal", {}, { env }),
  ],
  [
    "coder",
    Boolean(env.CODER_URL && env.CODER_SESSION_TOKEN && env.CODER_TEMPLATE),
    async () =>
      (await import("../src/open.js")).openRuntime(
        "coder",
        { runtime: { providers: { coder: { url: env.CODER_URL, template: env.CODER_TEMPLATE } } } },
        { env },
      ),
  ],
  [
    "opensandbox",
    Boolean(env.OPENSANDBOX_URL),
    async () =>
      (await import("../src/open.js")).openRuntime(
        "opensandbox",
        { runtime: { providers: { opensandbox: { url: env.OPENSANDBOX_URL } } } },
        { env },
      ),
  ],
];

describe("conformance against real providers", () => {
  for (const [kind, enabled, open] of real) {
    it.skipIf(!enabled)(`${kind} passes`, { timeout: 600_000 }, async () => {
      const report = await runConformance(await open(), {
        log: (line) => console.log(`${kind} ${line}`),
      });
      expect(conformanceFailures(report)).toBe("");
    });
  }
});
