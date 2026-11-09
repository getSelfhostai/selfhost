import { type LedgerEvent, validateConfig, validateEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import {
  daytonaRuntime,
  e2bRuntime,
  envSecrets,
  fakeRuntime,
  findLeftovers,
  hourlyPrice,
  modalRuntime,
  openRuntime,
  openSandboxRuntime,
  pickRuntime,
  RuntimeCapError,
  RuntimeGuard,
  RuntimeKeyError,
  reapLeftovers,
  runtimeCaps,
  runtimeFor,
  runtimeKey,
  sandboxEvent,
  trackSandbox,
  unionMs,
} from "../src/index.js";
import { Cloud, fakeDaytona, fakeE2B, fakeModal, fakeOpenSandbox } from "./fakes.js";
import { runShell } from "./shell.js";

const HOUR = 3_600_000;
const secrets = envSecrets({});
const credentials = { key: "k", keyEnv: "K" };

function clock(start = "2026-11-09T10:00:00Z") {
  let time = Date.parse(start);
  return {
    now: () => new Date(time),
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("list prices", () => {
  it("are each provider's published per-second rates for the size", () => {
    // E2B: $0.000014 per vCPU-second and $0.0000045 per GiB-second.
    expect(hourlyPrice("e2b", { cpu: 2, memoryGiB: 4 })).toBeCloseTo(
      (2 * 0.000014 + 4 * 0.0000045) * 3600,
      9,
    );
    // Daytona: $0.0504 per vCPU-hour, $0.0162 per GiB-hour, disk past 5 GiB at $0.000108.
    expect(hourlyPrice("daytona", { cpu: 1, memoryGiB: 1 }, { diskGiB: 3 })).toBeCloseTo(0.0666, 9);
    expect(hourlyPrice("daytona", { cpu: 1, memoryGiB: 1 }, { diskGiB: 15 })).toBeCloseTo(
      0.0666 + 10 * 0.000108,
      9,
    );
    // Modal sandboxes: $0.00003942 per core-second (2 vCPUs), $0.00000667 per GiB-second.
    expect(hourlyPrice("modal", { cpu: 2, memoryGiB: 4 })).toBeCloseTo(
      (0.00003942 + 4 * 0.00000667) * 3600,
      9,
    );
    expect(hourlyPrice("modal", { cpu: 2, memoryGiB: 4 }, { region: "us-east" })).toBeCloseTo(
      (0.00003942 + 4 * 0.00000667) * 3600 * 1.15,
      9,
    );
    // The team's own infrastructure has no rate unless the team sets one.
    expect(hourlyPrice("opensandbox", { cpu: 1, memoryGiB: 2 })).toBeUndefined();
    expect(hourlyPrice("coder", { cpu: 2, memoryGiB: 4 }, { usdPerHour: 0.3 })).toBe(0.3);
  });

  it("make each adapter's cost the rate times the running time", async () => {
    const cases = [
      {
        kind: "e2b",
        build: (cloud: Cloud, now: () => Date) =>
          e2bRuntime({ settings: {}, credentials, secrets, now, load: async () => fakeE2B(cloud) }),
        hourly: 0.1656,
      },
      {
        kind: "daytona",
        build: (cloud: Cloud, now: () => Date) =>
          daytonaRuntime({
            settings: {},
            credentials,
            secrets,
            now,
            load: async () => fakeDaytona(cloud),
          }),
        hourly: 0.0666,
      },
      {
        kind: "modal",
        build: (cloud: Cloud, now: () => Date) =>
          modalRuntime({
            settings: {},
            credentials,
            secrets,
            now,
            load: async () => fakeModal(cloud),
          }),
        hourly: 0.23796,
      },
      {
        kind: "opensandbox",
        build: (cloud: Cloud, now: () => Date) =>
          openSandboxRuntime({
            settings: { url: "http://localhost:8080", usd_per_hour: 0.05 },
            credentials,
            secrets,
            now,
            load: async () => fakeOpenSandbox(cloud),
          }),
        hourly: 0.05,
      },
    ];
    for (const { kind, build, hourly } of cases) {
      const time = clock();
      const cloud = new Cloud(kind, time.now);
      const sandbox = await build(cloud, time.now).create({ timeoutMinutes: 60 });
      time.advance(2 * HOUR);
      await sandbox.stop();
      time.advance(HOUR);
      const cost = await sandbox.cost();
      expect([kind, cost.seconds, cost.source]).toEqual([kind, 7200, "list_price"]);
      expect(cost.usd).toBeCloseTo(hourly * 2, 5);
    }
  });

  it("passes the size, region, egress and secrets to the provider", async () => {
    const cloud = new Cloud("modal");
    const modal = modalRuntime({
      settings: {},
      credentials,
      secrets: envSecrets({ GH: "ghp_x" }),
      load: async () => fakeModal(cloud),
    });
    await modal.create({
      timeoutMinutes: 30,
      size: { cpu: 4, memoryGiB: 8 },
      region: "eu-west",
      egress: { allow: ["github.com"] },
      secrets: [{ name: "GITHUB_TOKEN", from: "env:GH" }],
    });
    const box = [...cloud.boxes.values()][0];
    expect(box?.params).toMatchObject({
      cpu: 2,
      memoryMiB: 8192,
      timeoutMs: 1_800_000,
      regions: ["eu-west"],
      outboundDomainAllowlist: ["github.com"],
    });
    expect(box?.env.GITHUB_TOKEN).toBe("ghp_x");
    await expect(
      modal.create({ timeoutMinutes: 5, secrets: [{ name: "X", from: "vault:kv#x" }] }),
    ).rejects.toThrow("cannot read");
  });
});

describe("native egress and secrets", () => {
  it("applies each provider's own settings from @selfhost/credentials as given", async () => {
    const e2bCloud = new Cloud("e2b");
    const daytonaCloud = new Cloud("daytona");
    const modalCloud = new Cloud("modal");
    const osbCloud = new Cloud("osb");
    const base = { settings: {}, credentials, secrets };
    const spec = { timeoutMinutes: 5, egress: { allow: ["github.com"] } };
    await e2bRuntime({ ...base, load: async () => fakeE2B(e2bCloud) }).create({
      ...spec,
      native: {
        create: { network: { allowOut: ["github.com", "10.0.0.0/8"], denyOut: ["0.0.0.0/0"] } },
      },
    });
    await daytonaRuntime({ ...base, load: async () => fakeDaytona(daytonaCloud) }).create({
      ...spec,
      native: { create: { networkAllowList: "10.0.0.0/8" } },
    });
    await modalRuntime({ ...base, load: async () => fakeModal(modalCloud) }).create({
      ...spec,
      native: { create: { cidrAllowlist: ["10.0.0.0/8"] } },
    });
    const vault = {
      credentials: [{ name: "GH", source: { value: "ghp_x" } }],
      bindings: [
        {
          name: "GH",
          match: { schemes: ["https"], hosts: ["api.github.com"] },
          auth: { type: "apiKey", name: "authorization", credential: "GH" },
        },
      ],
    };
    await openSandboxRuntime({
      ...base,
      settings: { url: "http://localhost:8080" },
      load: async () => fakeOpenSandbox(osbCloud),
    }).create({
      ...spec,
      native: {
        create: {
          networkPolicy: {
            defaultAction: "deny",
            egress: [{ action: "allow", target: "api.github.com" }],
          },
        },
        credentialVault: vault,
      },
    });
    const params = (cloud: Cloud) => [...cloud.boxes.values()][0]?.params;
    expect(params(e2bCloud)?.network).toEqual({
      allowOut: ["github.com", "10.0.0.0/8"],
      denyOut: ["0.0.0.0/0"],
    });
    expect(params(daytonaCloud)).toMatchObject({ networkAllowList: "10.0.0.0/8" });
    expect(params(daytonaCloud)?.domainAllowList).toBeUndefined();
    expect(params(modalCloud)).toMatchObject({ outboundCidrAllowlist: ["10.0.0.0/8"] });
    expect(params(modalCloud)?.outboundDomainAllowlist).toBeUndefined();
    expect(params(osbCloud)).toMatchObject({
      networkPolicy: { egress: [{ target: "api.github.com" }] },
      credentialProxy: { enabled: true },
      credentialVault: vault,
    });
  });
});

describe("pickRuntime", () => {
  it("refuses a runtime the policy does not allow, naming the rule", () => {
    const config = { runtime: { allow: ["e2b", "daytona"] as const } };
    const choice = pickRuntime({ runtime: { allow: ["e2b", "daytona"] } }, { kind: "modal" });
    expect(choice).toMatchObject({ ok: false, rule: "runtime.allow" });
    expect(choice.ok ? "" : choice.message).toContain("allows e2b, daytona");
    expect(
      pickRuntime(
        { runtime: { ...config.runtime, allow: [...config.runtime.allow] } },
        { kind: "e2b" },
      ),
    ).toMatchObject({ ok: true, kind: "e2b" });
  });

  it("refuses a size over max_size and a region the runtime cannot serve", () => {
    const config = { runtime: { max_size: { cpu: 4, memory_gib: 8 }, region: "eu" } };
    expect(pickRuntime(config, { kind: "daytona", size: { cpu: 8 } })).toMatchObject({
      ok: false,
      rule: "runtime.max_size",
    });
    expect(pickRuntime(config, { kind: "daytona", size: { memoryGiB: 16 } })).toMatchObject({
      ok: false,
      rule: "runtime.max_size",
    });
    expect(pickRuntime(config, { kind: "e2b" })).toMatchObject({
      ok: false,
      rule: "runtime.region",
    });
    expect(pickRuntime(config, { kind: "daytona", region: "us" })).toMatchObject({
      ok: false,
      rule: "runtime.region",
    });
    expect(pickRuntime(config, { kind: "daytona", size: { cpu: 2 } })).toMatchObject({
      ok: true,
      kind: "daytona",
      region: "eu",
      size: { cpu: 2, memoryGiB: 1 },
    });
  });

  it("cheapest_allowed takes the allowed runtime with a key and the lowest list price", () => {
    const config = {
      runtime: {
        policy: "cheapest_allowed" as const,
        allow: ["e2b", "modal", "daytona"] as ("e2b" | "modal" | "daytona")[],
      },
    };
    expect(pickRuntime(config)).toMatchObject({ ok: true, kind: "daytona" });
    expect(
      pickRuntime(
        config,
        {},
        { env: { E2B_API_KEY: "k", MODAL_TOKEN_ID: "ak-1", MODAL_TOKEN_SECRET: "as-1" } },
      ),
    ).toMatchObject({ ok: true, kind: "e2b" });
    expect(pickRuntime(config, {}, { env: {} })).toMatchObject({
      ok: false,
      rule: "runtime.allow",
    });
    const own = {
      runtime: {
        policy: "cheapest_allowed" as const,
        providers: { opensandbox: { url: "http://localhost:8080", usd_per_hour: 0.01 } },
      },
    };
    expect(pickRuntime(own, {}, { env: { DAYTONA_API_KEY: "k" } })).toMatchObject({
      ok: true,
      kind: "opensandbox",
      usdPerHour: 0.01,
    });
  });

  it("default policy uses runtime.default, then the integrations tool", () => {
    expect(pickRuntime({ runtime: { default: "modal" } })).toMatchObject({
      ok: true,
      kind: "modal",
    });
    expect(pickRuntime({ integrations: { runtime: { tool: "e2b" } } })).toMatchObject({
      ok: true,
      kind: "e2b",
      why: "[integrations.runtime] tool is e2b.",
    });
    expect(pickRuntime({})).toMatchObject({ ok: false, rule: "runtime.default" });
    expect(
      pickRuntime({ runtime: { allow: ["daytona"] }, integrations: { runtime: { tool: "e2b" } } }),
    ).toMatchObject({ ok: false, rule: "runtime.allow" });
  });

  it("selfhost.toml rejects a default the allow list leaves out", () => {
    const result = validateConfig({ version: 1, runtime: { default: "modal", allow: ["e2b"] } });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.map((error) => error.message)).toContain(
      "runtime.default is modal, which runtime.allow does not list",
    );
  });
});

describe("keys", () => {
  it("come from the environment variable the settings name, and a run without one does not start", () => {
    expect(runtimeKey("e2b", { api_key_env: "TEAM_E2B" }, { TEAM_E2B: "e2b_x" })).toEqual({
      key: "e2b_x",
      keyEnv: "TEAM_E2B",
    });
    expect(() => runtimeKey("daytona", {}, {})).toThrow(RuntimeKeyError);
    expect(() => runtimeKey("daytona", {}, {})).toThrow(/DAYTONA_API_KEY.*the team's own key/s);
    expect(() => openRuntime("e2b", {}, { env: {} })).toThrow("E2B_API_KEY");
    expect(() => runtimeKey("coder", {}, { CODER_SESSION_TOKEN: "t" })).toThrow("Set url");
    expect(runtimeKey("opensandbox", { url: "http://127.0.0.1:8080" }, {}).key).toBe("");
    expect(() => runtimeKey("opensandbox", { url: "https://sandbox.example.com" }, {})).toThrow(
      "OPEN_SANDBOX_API_KEY",
    );
  });

  it("[runtime.providers] wins over [integrations.runtime]", () => {
    const config = {
      integrations: { runtime: { tool: "e2b" as const, api_key_env: "A" } },
      runtime: { providers: { e2b: { api_key_env: "B" } } },
    };
    expect(openRuntime("e2b", config, { env: { B: "key" } }).kind).toBe("e2b");
    expect(() => openRuntime("e2b", config, { env: { A: "key" } })).toThrow("B");
  });
});

const shellRuntime = (now: () => Date) =>
  fakeRuntime({
    now,
    usdPerSecond: 0.001,
    exec: (command, sandbox, options) => runShell(command, sandbox, options),
  });

describe("trackSandbox", () => {
  it("writes valid lifecycle events with billed, busy and idle seconds", async () => {
    const time = clock();
    const events: LedgerEvent[] = [];
    const runtime = shellRuntime(time.now);
    const tracked = await trackSandbox(await runtime.create({ timeoutMinutes: 60 }), {
      emit: (event) => {
        events.push(event);
      },
      context: { run_id: "run-1", team: "core", owner: "ana@example.com" },
      size: { cpu: 2, memoryGiB: 4 },
      usdPerHour: 3.6,
      now: time.now,
    });
    time.advance(60_000);
    await tracked.exec("echo hi");
    // A command that takes 30 seconds of the clock: the agent working.
    const running = tracked.exec("echo work");
    time.advance(30_000);
    await running;
    time.advance(90_000);
    tracked.markRunEnded();
    time.advance(60_000);
    await tracked.stop();
    expect(events.map((event) => event.kind)).toEqual(["sandbox.started", "sandbox.stopped"]);
    for (const event of events) expect(validateEvent(event).ok).toBe(true);
    const stopped = events[1];
    expect(stopped?.data?.sandbox).toMatchObject({
      reason: "run_ended",
      billed_seconds: 240,
      busy_seconds: 30,
      idle_seconds: 210,
      after_run_seconds: 60,
      usd_per_hour: 3.6,
    });
    expect(stopped?.cost).toMatchObject({ usd: 0.24, estimated: true, input_tokens: 0 });
    expect(stopped?.data?.owner).toBe("ana@example.com");
  });

  it("counts overlapping commands once", () => {
    expect(
      unionMs([
        [0, 10],
        [5, 20],
        [30, 40],
        [40, 45],
      ]),
    ).toBe(35);
  });
});

describe("runtime caps", () => {
  it("stops a run's sandbox at runtime_run_usd and names the cap", async () => {
    const time = clock();
    const events: LedgerEvent[] = [];
    const emit = (event: LedgerEvent) => {
      events.push(event);
    };
    const runtime = shellRuntime(time.now);
    const guard = new RuntimeGuard({
      caps: runtimeCaps({ runtime_run_usd: 1, runtime_daily_usd: 100 }),
      spentToday: async () => 0,
      emit,
      now: time.now,
    });
    const tracked = await trackSandbox(await runtime.create({ timeoutMinutes: 60 }), {
      emit,
      context: { run_id: "run-2", owner: "ana@example.com" },
      now: time.now,
    });
    guard.watch(tracked);
    time.advance(500_000);
    expect(await guard.check()).toEqual([]);
    time.advance(600_000);
    expect(await guard.check()).toEqual([
      { sandboxId: tracked.id, runId: "run-2", cap: "runtime_run_usd" },
    ]);
    expect(await tracked.status()).toBe("stopped");
    const alert = events.find((event) => event.kind === "alert.raised");
    expect(alert?.data).toMatchObject({
      alert: "budget_exceeded",
      cap: "runtime_run_usd",
      owner: "ana@example.com",
    });
    expect(String(alert?.data?.message)).toContain("[budget] runtime_run_usd");
    expect(events.find((event) => event.kind === "sandbox.stopped")?.data?.sandbox).toMatchObject({
      reason: "cap",
      cap: "runtime_run_usd",
    });
    for (const event of events) expect(validateEvent(event).ok).toBe(true);
  });

  it("refuses new runs and stops the running ones once the day's spend reaches runtime_daily_usd", async () => {
    const time = clock();
    const events: LedgerEvent[] = [];
    const emit = (event: LedgerEvent) => {
      events.push(event);
    };
    let ledger = 4;
    const guard = new RuntimeGuard({
      caps: runtimeCaps({ runtime_daily_usd: 5 }),
      spentToday: async () => ledger,
      emit,
      now: time.now,
    });
    await guard.admit();
    const runtime = shellRuntime(time.now);
    const a = await trackSandbox(await runtime.create({ timeoutMinutes: 60 }), {
      emit,
      context: { run_id: "a", team: "core" },
      now: time.now,
    });
    const b = await trackSandbox(await runtime.create({ timeoutMinutes: 60 }), {
      emit,
      context: { run_id: "b", team: "core" },
      now: time.now,
    });
    guard.watch(a);
    guard.watch(b);
    time.advance(400_000);
    expect(await guard.check()).toEqual([]);
    time.advance(200_000);
    const stops = await guard.check();
    expect(stops.map((stop) => stop.cap)).toEqual(["runtime_daily_usd", "runtime_daily_usd"]);
    const alert = events.filter((event) => event.kind === "alert.raised");
    expect(alert).toHaveLength(1);
    expect(alert[0]?.team).toBe("core");
    expect(alert[0]?.run_id).toBeUndefined();
    ledger = 6.2;
    await expect(guard.admit()).rejects.toThrow(RuntimeCapError);
    await expect(guard.admit()).rejects.toThrow("runtime_daily_usd");
  });
});

describe("reaper", () => {
  it("finds sandboxes left running after their run and stops them with events", async () => {
    const time = clock();
    const runtime = shellRuntime(time.now);
    const kept = await runtime.create({ timeoutMinutes: 60, labels: { selfhost: "managed" } });
    const left = await runtime.create({ timeoutMinutes: 60, labels: { selfhost: "managed" } });
    const stray = await runtime.create({ timeoutMinutes: 60, labels: { selfhost: "managed" } });
    const at = time.now();
    const started = (id: string, run: string) =>
      sandboxEvent(
        "sandbox.started",
        { runtime: "e2b", sandbox_id: id, usd_per_hour: 3.6, billing: "reserved" },
        { run_id: run, owner: "ana@example.com" },
        at,
      );
    time.advance(40 * 60_000);
    const ended = (run: string, minutesAgo: number): LedgerEvent => ({
      id: `01930000-0000-7000-8000-00000000000${run === "r-left" ? "1" : "2"}`,
      schema: "selfhost.event/v1",
      ts: new Date(time.now().getTime() - minutesAgo * 60_000).toISOString(),
      source: "hook",
      kind: "session.ended",
      actor: { kind: "agent", id: run },
      run_id: run,
    });
    const events = [
      started(kept.id, "r-kept"),
      started(left.id, "r-left"),
      ended("r-left", 20),
      ended("r-kept", 5),
    ];
    const found = await findLeftovers({ adapters: [runtime], events, now: time.now() });
    expect(found.errors).toEqual([]);
    expect(found.leftovers.map((leftover) => [leftover.sandboxId, leftover.reason])).toEqual([
      [left.id, "run_ended"],
      [stray.id, "unknown"],
    ]);
    expect(found.leftovers[0]?.why).toContain("Run r-left ended 20 minutes ago");

    const written: LedgerEvent[] = [];
    const reaped = await reapLeftovers({
      adapters: [runtime],
      leftovers: found.leftovers,
      emit: (event) => {
        written.push(event);
      },
      now: time.now,
    });
    expect(reaped.map((entry) => entry.stopped)).toEqual([true, false]);
    expect(await left.status()).toBe("stopped");
    expect(await stray.status()).toBe("running");
    expect(written.map((event) => event.kind)).toEqual(["sandbox.stopped", "alert.raised"]);
    expect(written[0]?.data?.sandbox).toMatchObject({ reason: "reaped", after_run_seconds: 1200 });
    expect(written[1]?.data).toMatchObject({
      alert: "sandbox_left_running",
      owner: "ana@example.com",
    });
    for (const event of written) expect(validateEvent(event).ok).toBe(true);
  });
});

describe("runtimeFor", () => {
  const run = {
    id: "run-9",
    team: "web",
    repo: "acme/site",
    person: "ana@example.com",
    runtime: "e2b",
  };

  it("opens the picked runtime and tracks its sandboxes in the ledger until the run ends", async () => {
    const time = clock();
    const events: LedgerEvent[] = [];
    const opened: string[] = [];
    const seam = runtimeFor({
      env: { E2B_API_KEY: "k" },
      now: time.now,
      emit: (event) => {
        events.push(event);
      },
      open: (kind) => {
        opened.push(kind);
        return shellRuntime(time.now);
      },
    });
    const adapter = await seam(run, { runtime: { allow: ["e2b"] } });
    expect(adapter?.kind).toBe("e2b");
    const sandbox = await adapter?.create({ timeoutMinutes: 30 });
    time.advance(60_000);
    await sandbox?.exec("echo hi");
    await sandbox?.stop();
    expect(opened).toEqual(["e2b"]);
    expect(events.map((event) => event.kind)).toEqual(["sandbox.started", "sandbox.stopped"]);
    expect(events[1]).toMatchObject({ run_id: "run-9", team: "web", repo: "acme/site" });
    expect(events[1]?.data).toMatchObject({
      owner: "ana@example.com",
      sandbox: { reason: "run_ended", billed_seconds: 60 },
    });
  });

  it("refuses with the rule that blocked it: allow, a missing key, the daily cap", async () => {
    const refused: string[] = [];
    const seam = runtimeFor({
      env: {},
      onRefused: (_run, refusal) => refused.push(`${refusal.rule}: ${refusal.message}`),
      spentToday: async () => 9,
      open: (kind, config) => openRuntime(kind, config, { env: { DAYTONA_API_KEY: "k" } }),
    });
    expect(
      await seam({ ...run, runtime: "modal" }, { runtime: { allow: ["e2b"] } }),
    ).toBeUndefined();
    expect(await seam(run, {})).toBeUndefined();
    expect(
      await seam({ ...run, runtime: "daytona" }, { budget: { runtime_daily_usd: 5 } }),
    ).toBeUndefined();
    expect(refused[0]).toMatch(/^runtime.allow: The task asks for modal/);
    expect(refused[1]).toMatch(/^runtime.key: .*E2B_API_KEY/);
    expect(refused[2]).toMatch(/^budget.runtime_daily_usd: Sandbox spend today is \$9.00/);
  });
});
