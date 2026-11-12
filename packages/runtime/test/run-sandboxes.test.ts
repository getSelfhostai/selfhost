import type { LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { outputJoiner } from "../src/adapters/opensandbox.js";
import {
  envSecrets,
  fakeRuntime,
  isRefused,
  labelValue,
  openSandboxRuntime,
  type RuntimeAdapter,
  runtimeFor,
} from "../src/index.js";
import { Cloud, fakeOpenSandbox } from "./fakes.js";

const credentials = { key: "k", keyEnv: "K" };

function openSandbox(cloud: Cloud, settings = {}) {
  return openSandboxRuntime({
    settings: { url: "http://localhost:8080", ...settings },
    credentials,
    secrets: envSecrets({}),
    load: async () => fakeOpenSandbox(cloud),
  });
}

describe("secrets the credential broker issued", () => {
  it("reach the sandbox through the spec's resolver, for refs the adapter cannot read", async () => {
    const cloud = new Cloud("osb");
    const adapter = openSandbox(cloud);
    const secrets = [
      { name: "ANTHROPIC_AUTH_TOKEN", from: "gateway:run" },
      { name: "GITHUB_TOKEN", from: "github-app:repo" },
      { name: "NPM_TOKEN", from: "vault:kv/npm#token" },
    ];
    await expect(adapter.create({ timeoutMinutes: 5, secrets })).rejects.toThrow(
      "which this runtime cannot read",
    );
    const issued: Record<string, string> = {
      ANTHROPIC_AUTH_TOKEN: "vk-run",
      GITHUB_TOKEN: "ghs_run",
      NPM_TOKEN: "npm_run",
    };
    await adapter.create({
      timeoutMinutes: 5,
      secrets,
      resolveSecret: (ref) => issued[ref.name],
    });
    const box = [...cloud.boxes.values()].at(-1);
    expect(box?.env).toMatchObject(issued);
  });
});

describe("OpenSandbox output", () => {
  it("keeps the line breaks the server drops between messages", async () => {
    const cloud = new Cloud("osb");
    const sandbox = await openSandbox(cloud).create({ timeoutMinutes: 5 });
    const chunks: string[] = [];
    const result = await sandbox.exec("printf 'a\\nb\\n\\nc'", {
      onOutput: ({ text }) => chunks.push(text),
    });
    expect(result.stdout).toBe("a\nb\n\nc");
    expect(chunks.join("")).toBe("a\nb\n\nc");
    const next = outputJoiner();
    expect(["x\n", "y", "z"].map(next).join("")).toBe("x\ny\nz");
  });
});

describe("label values", () => {
  it("are hashed when a provider would refuse them, and lists still match", async () => {
    expect(labelValue("web")).toBe("web");
    expect(labelValue("alice@example.com")).toMatch(/^h-[0-9a-f]{32}$/);
    expect(labelValue(labelValue("alice@example.com"))).toBe(labelValue("alice@example.com"));
    expect(labelValue("x".repeat(64))).toMatch(/^h-/);

    const cloud = new Cloud("osb");
    const adapter = openSandbox(cloud);
    const sandbox = await adapter.create({
      timeoutMinutes: 5,
      labels: { selfhost_person: "alice@example.com", selfhost_team: "web" },
    });
    const box = cloud.boxes.get(sandbox.id);
    expect(Object.values(box?.labels ?? {})).not.toContain("alice@example.com");
    expect(await adapter.list({ selfhost_person: "alice@example.com" })).toEqual([
      { id: sandbox.id, state: "running" },
    ]);
    expect(await adapter.list({ selfhost_person: "bob@example.com" })).toEqual([]);
  });
});

describe("creating an OpenSandbox sandbox", () => {
  it("gets a long create timeout, reports the id before readiness, and stops it if not ready", async () => {
    const cloud = new Cloud("osb");
    const sdk = fakeOpenSandbox(cloud);
    const order: string[] = [];
    let ready = false;
    const create = sdk.Sandbox.create.bind(sdk.Sandbox);
    sdk.Sandbox.create = async (opts) => {
      order.push(`create:${JSON.stringify(opts.connectionConfig)}:${opts.skipHealthCheck}`);
      const box = await create(opts);
      return {
        ...box,
        async waitUntilReady() {
          order.push("ready");
          if (!ready) throw new Error("not ready in time");
        },
      };
    };
    const adapter = openSandboxRuntime({
      settings: { url: "http://localhost:8080", create_timeout_seconds: 900 },
      credentials,
      secrets: envSecrets({}),
      load: async () => sdk,
    });
    await expect(
      adapter.create({ timeoutMinutes: 5, onCreated: (id) => void order.push(`id:${id}`) }),
    ).rejects.toThrow("not ready in time");
    expect(order[0]).toContain('"requestTimeoutSeconds":900');
    expect(order[0]).toMatch(/:true$/);
    expect(order.slice(1)).toEqual(["id:osb-1", "ready"]);
    expect(cloud.boxes.get("osb-1")?.alive).toBe(false);

    ready = true;
    const defaults = openSandboxRuntime({
      settings: { url: "http://localhost:8080" },
      credentials,
      secrets: envSecrets({}),
      load: async () => sdk,
    });
    order.length = 0;
    await defaults.create({ timeoutMinutes: 5 });
    expect(order[0]).toContain('"requestTimeoutSeconds":600');
  });
});

describe("runtimeFor", () => {
  const run = { id: "run-5", team: "web", person: "alice@example.com", runtime: "e2b" };

  it("stops what a failed create left running, by its reported id and the run's label", async () => {
    const inner = fakeRuntime();
    let reported = true;
    // The provider made the sandbox, but the create call failed on this side (a client timeout).
    const flaky: RuntimeAdapter = {
      ...inner,
      async create(spec) {
        await inner.create(reported ? spec : { ...spec, onCreated: undefined });
        throw new Error("[http] Request timed out (timeoutSeconds=30)");
      },
    };
    const seam = runtimeFor({ env: { E2B_API_KEY: "k" }, open: () => flaky });
    const adapter = await seam(run, {});
    if (isRefused(adapter)) throw new Error(adapter.refusal.message);
    const ids: string[] = [];
    await expect(
      adapter.create({ timeoutMinutes: 5, onCreated: (id) => void ids.push(id) }),
    ).rejects.toThrow("timed out");
    expect(ids).toEqual(["fake-e2b-1"]);
    reported = false;
    await expect(adapter.create({ timeoutMinutes: 5 })).rejects.toThrow("timed out");
    for (const sandbox of inner.sandboxes.values()) {
      expect(await sandbox.status()).toBe("stopped");
    }
    expect(inner.sandboxes.size).toBe(2);
  });

  it("reads the team's runtime caps from each run's policy, not the first one", async () => {
    const events: LedgerEvent[] = [];
    const seam = runtimeFor({
      env: { E2B_API_KEY: "k" },
      open: () => fakeRuntime(),
      spentToday: async () => 0.03,
      emit: (event) => void events.push(event),
    });
    expect(isRefused(await seam(run, { budget: { runtime_daily_usd: 5 } }))).toBe(false);
    expect(await seam(run, { budget: { runtime_daily_usd: 0.01 } })).toMatchObject({
      refusal: { rule: "budget.runtime_daily_usd" },
    });
    expect(isRefused(await seam(run, {}))).toBe(false);
  });
});
