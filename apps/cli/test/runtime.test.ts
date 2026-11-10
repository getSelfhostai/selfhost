import { mkdirSync } from "node:fs";
import { openLedger } from "@selfhost/ledger";
import { fakeRuntime, type RuntimeAdapter, sandboxEvent } from "@selfhost/runtime";
import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { runShell } from "../../../packages/runtime/test/shell.js";
import { createProgram } from "../src/program.js";
import { registerRuntime, runRuntimeReap } from "../src/runtime.js";
import { runSpend } from "../src/spend.js";
import { blockNetwork } from "./network.js";
import { run, tempDir } from "./run.js";

const POLICY = `version = 1

[runtime]
allow = ["e2b", "daytona", "opensandbox"]
default = "e2b"
policy = "cheapest_allowed"
region = "us"

[runtime.providers.opensandbox]
url = "http://localhost:8080"
usd_per_hour = 0.02

[budget]
runtime_daily_usd = 20
runtime_run_usd = 2
`;

function repo(text = POLICY) {
  const dir = tempDir("runtime-repo");
  mkdirSync(dir.path(".git"));
  dir.write("selfhost.toml", text);
  return dir;
}

const shell = (now?: () => Date) =>
  fakeRuntime({
    ...(now ? { now } : {}),
    usdPerSecond: 0.001,
    exec: (command, sandbox, options) => runShell(command, sandbox, options),
  });

describe("selfhost runtime", () => {
  it("has list, check and reap", () => {
    const runtime = createProgram().commands.find((command) => command.name() === "runtime");
    expect(runtime?.commands.map((command) => command.name()).sort()).toEqual([
      "check",
      "list",
      "reap",
    ]);
  });

  it("joins an existing runtime check as --reach and --conformance instead of a second one", async () => {
    const program = new Command();
    program.exitOverride();
    const seen: string[] = [];
    program
      .command("runtime")
      .command("check")
      .argument("[targets...]")
      .option("--json")
      .action((targets: string[]) => {
        seen.push(`egress check: ${targets.join(" ")}`);
      });
    const lines: string[] = [];
    const dir = repo();
    registerRuntime(
      program,
      () => ({
        env: { E2B_API_KEY: "k" },
        cwd: dir.root,
        write: (line) => lines.push(line),
        setExitCode: () => {},
        fetch: async () => new Response("[]", { status: 200 }),
      }),
      (error) => {
        throw error;
      },
    );
    const runtime = program.commands.find((command) => command.name() === "runtime");
    expect(runtime?.commands.map((command) => command.name())).toEqual(["check", "list", "reap"]);
    await program.parseAsync(["node", "selfhost", "runtime", "check", "e2b", "laptop"]);
    expect(seen).toEqual(["egress check: e2b laptop"]);
    expect(lines).toEqual([]);
    await program.parseAsync(["node", "selfhost", "runtime", "check", "e2b", "laptop", "--reach"]);
    expect(lines).toEqual([
      "e2b: connected. E2B at https://api.e2b.app accepts the key in E2B_API_KEY.",
    ]);
  });

  it("lists each runtime with the policy, its key and list price, and no key value", async () => {
    const dir = repo();
    const attempts = blockNetwork();
    const listed = await run(["runtime", "list", "--json"], {
      cwd: dir.root,
      env: { E2B_API_KEY: "secret-e2b-value" },
    });
    expect(listed.code).toBe(0);
    expect(listed.out).not.toContain("secret-e2b-value");
    const report = JSON.parse(listed.out);
    expect(report).toMatchObject({ policy: "cheapest_allowed", region: "us" });
    const rows = Object.fromEntries(
      report.runtimes.map((row: { runtime: string }) => [row.runtime, row]),
    );
    expect(rows.e2b).toMatchObject({
      allowed: true,
      default: true,
      key_set: true,
      key_env: ["E2B_API_KEY"],
      usd_per_hour: 0.1656,
      sdk: "e2b@2.59.0",
    });
    expect(rows.daytona).toMatchObject({ allowed: true, key_set: false, usd_per_hour: 0.0666 });
    expect(rows.modal).toMatchObject({
      allowed: false,
      key_env: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
    });
    expect(rows.opensandbox).toMatchObject({
      key_set: true,
      key: "not_needed",
      usd_per_hour: 0.02,
    });
    expect(rows.coder).toMatchObject({ usd_per_hour: null, sdk: null });
    expect(attempts).toHaveLength(0);

    const text = await run(["runtime", "list"], { cwd: dir.root, env: {} });
    expect(text.out).toContain("not set: DAYTONA_API_KEY");
    expect(text.out).toContain("your rate");
    // A local OpenSandbox server runs without a key; never "set" for a variable that is not.
    expect(text.out).toMatch(/opensandbox +yes +no key needed for a local server/);
    expect(text.out).not.toContain("set (OPEN_SANDBOX_API_KEY)");
    const remote = repo(
      'version = 1\n[runtime.providers.opensandbox]\nurl = "https://sandbox.example.com"\napi_key_env = "OPENSANDBOX_KEY"\n',
    );
    const unset = await run(["runtime", "list"], { cwd: remote.root, env: {} });
    expect(unset.out).toMatch(/opensandbox +yes +not set: OPENSANDBOX_KEY/);
  });

  it("says a deprecated [integrations.runtime] once, and uses it as [runtime] default", async () => {
    const dir = repo('version = 1\n[integrations.runtime]\ntool = "e2b"\n');
    const listed = await run(["runtime", "list"], { cwd: dir.root, env: {} });
    expect(listed.out.split("\n")[0]).toBe(
      'Warning: [integrations.runtime] is deprecated: it is read as [runtime] default = "e2b"; move it there.',
    );
    expect(listed.out).toContain("e2b (default)");
    const json = JSON.parse((await run(["runtime", "list", "--json"], { cwd: dir.root })).out);
    expect(json.runtimes[0]).toMatchObject({ runtime: "e2b", default: true });
  });

  it("exits 1 when a reach check fails, with no runtimes named", async () => {
    const dir = repo('version = 1\n[runtime]\nallow = ["e2b", "daytona"]\n');
    const checked = await run(["runtime", "check", "--reach"], {
      cwd: dir.root,
      env: {},
      fetch: async () => new Response("{}", { status: 401 }),
    });
    expect(checked.out).toContain("e2b: error.");
    expect(checked.code).toBe(1);
  });

  it("checks each allowed runtime's key, and runs the conformance suite on request", async () => {
    const dir = repo();
    const fetch = async (url: string) =>
      url === "https://api.e2b.app/v2/sandboxes?limit=1"
        ? new Response("[]", { status: 200 })
        : url === "http://localhost:8080/v1/sandboxes?pageSize=1"
          ? new Response('{"items":[]}', { status: 200 })
          : new Response("{}", { status: 401 });
    const opened: string[] = [];
    const checked = await run(["runtime", "check", "--conformance", "--json"], {
      cwd: dir.root,
      env: { E2B_API_KEY: "k" },
      fetch,
      openRuntime: (kind) => {
        opened.push(kind);
        return shell() as unknown as RuntimeAdapter;
      },
    });
    // With the [egress] check on the same command, its report comes first: take this one.
    const report = JSON.parse(
      checked.out.slice(checked.out.lastIndexOf('{\n  "schema": "selfhost.runtime_reach/v1"')),
    );
    expect(report.schema).toBe("selfhost.runtime_reach/v1");
    const rows = Object.fromEntries(
      report.runtimes.map((row: { runtime: string }) => [row.runtime, row]),
    );
    expect(rows.e2b).toMatchObject({ status: "connected", conformance: { ok: true } });
    expect(rows.opensandbox).toMatchObject({ status: "connected", conformance: { ok: true } });
    expect(rows.daytona).toMatchObject({ status: "error" });
    expect(rows.daytona.detail).toContain("DAYTONA_API_KEY");
    expect(opened).toEqual(["e2b", "opensandbox"]);
    expect(checked.code).toBe(1);
  }, 60_000);
});

describe("selfhost runtime reap", () => {
  const NOW = new Date("2026-11-09T12:00:00Z");
  const ended = (run: string, minutesAgo: number): LedgerEvent => ({
    id: `01930000-0000-7000-8000-${String(minutesAgo).padStart(12, "0")}`,
    schema: EVENT_SCHEMA,
    ts: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    source: "hook",
    kind: "session.ended",
    actor: { kind: "agent", id: run },
    run_id: run,
  });

  it("lists leftovers on a dry run, then stops them and writes the stops to the ledger", async () => {
    const dir = repo();
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const runtime = shell(() => NOW);
      const left = await runtime.create({ timeoutMinutes: 60, labels: { selfhost: "managed" } });
      const started = new Date(NOW.getTime() - 60 * 60_000);
      await ledger.append([
        sandboxEvent(
          "sandbox.started",
          { runtime: "e2b", sandbox_id: left.id, usd_per_hour: 0.1656, billing: "reserved" },
          { run_id: "run-7", owner: "ana@example.com" },
          started,
        ),
        ended("run-7", 25),
      ]);
      const lines: string[] = [];
      const io = {
        env: { E2B_API_KEY: "k" },
        cwd: dir.root,
        write: (line: string) => lines.push(line),
        setExitCode: () => {},
        now: () => NOW,
        // The local OpenSandbox server needs no key, so it is listed too, and has nothing running.
        openAdapter: (kind: string) =>
          (kind === "e2b" ? runtime : shell(() => NOW)) as unknown as RuntimeAdapter,
      };
      const dry = await runRuntimeReap({ dryRun: true }, io, ledger);
      expect(dry.leftovers.map((row) => [row.sandboxId, row.reason, row.stopped])).toEqual([
        [left.id, "run_ended", false],
      ]);
      expect(lines.join("\n")).toContain("would be stopped");
      expect(await left.status()).toBe("running");

      // A runtime with a key that the team set up nowhere, and has no sandboxes on, is not
      // opened: its SDK is never loaded.
      const opened: string[] = [];
      const quiet = await runRuntimeReap(
        { dryRun: true },
        {
          ...io,
          env: { E2B_API_KEY: "k", DAYTONA_API_KEY: "d" },
          openAdapter: (kind: string) => {
            opened.push(kind);
            return io.openAdapter(kind);
          },
        },
        ledger,
      );
      expect(quiet.errors).toEqual([]);
      expect(opened.sort()).toEqual(["e2b", "opensandbox"]);

      const done = await runRuntimeReap({}, io, ledger);
      expect(done.leftovers[0]?.stopped).toBe(true);
      expect(await left.status()).toBe("stopped");
      const stops = await ledger.query({ kind: "sandbox.stopped" });
      expect(stops.events[0]?.data?.sandbox).toMatchObject({
        reason: "reaped",
        after_run_seconds: 1500,
      });
      const alerts = await ledger.query({ kind: "alert.raised" });
      expect(alerts.events[0]?.data).toMatchObject({
        alert: "sandbox_left_running",
        owner: "ana@example.com",
      });

      // selfhost spend shows the sandbox cost and that it ran past its run.
      const spend = await runSpend({ since: "7d" }, { env: {}, write: () => {}, now: NOW }, ledger);
      expect(spend.sandboxes.leftovers).toMatchObject([
        { sandbox_id: left.id, run_id: "run-7", minutes_after_run: 25 },
      ]);
      expect(spend.sandboxes.windows[0]?.by_runtime[0]).toMatchObject({
        runtime: "e2b",
        sandboxes: 1,
      });
    } finally {
      await ledger.close();
    }
  });
});
