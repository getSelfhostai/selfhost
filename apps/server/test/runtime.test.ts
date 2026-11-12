import { openLedger } from "@selfhost/ledger";
import { fakeRuntime, isRefused, sandboxEvent } from "@selfhost/runtime";
import { parseConfig } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { unsafeTracerHeaders } from "../src/runs.js";
import { serverRuntime } from "../src/runtime.js";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const run = { id: "run-1", team: "web", person: "ana@example.com", runtime: "e2b" };

describe("the server's runtime seam", () => {
  it("writes sandbox lifecycle to the ledger and refuses a team over its daily runtime cap", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const log: string[] = [];
      const seam = serverRuntime(ledger, {
        env: { E2B_API_KEY: "k" },
        now: () => NOW,
        open: () => fakeRuntime({ now: () => NOW }),
        log: (line) => log.push(line),
      });
      const config = { budget: { runtime_daily_usd: 5 } };
      const adapter = await seam(run, config);
      if (isRefused(adapter)) throw new Error(adapter.refusal.message);
      const sandbox = await adapter.create({ timeoutMinutes: 10 });
      await sandbox?.stop();
      const stopped = await ledger.query({ kind: "sandbox.stopped", team: "web" });
      expect(stopped.events).toHaveLength(1);
      expect(stopped.events[0]?.run_id).toBe("run-1");

      const at = new Date(NOW.getTime() - 3_600_000);
      await ledger.append(
        [
          sandboxEvent(
            "sandbox.started",
            { runtime: "e2b", sandbox_id: "big", usd_per_hour: 6 },
            { team: "web", run_id: "run-0" },
            at,
          ),
        ],
        { team: "web" },
      );
      const refused = await seam({ ...run, id: "run-2" }, config);
      expect(refused).toMatchObject({ refusal: { rule: "budget.runtime_daily_usd" } });
      expect(log[0]).toContain("budget.runtime_daily_usd");
      expect(log[0]).toContain("$6.00");
    } finally {
      await ledger.close();
    }
  });

  it("answers a missing key with the variable to set on the team server", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const log: string[] = [];
      const seam = serverRuntime(ledger, { env: {}, now: () => NOW, log: (l) => log.push(l) });
      const refused = await seam(run, { runtime: { default: "e2b" } });
      expect(refused).toEqual({
        refusal: {
          rule: "runtime.key",
          message: expect.stringContaining(
            "Set the environment variable E2B_API_KEY (api_key_env) on the team server",
          ),
        },
      });
      expect(log[0]).toContain("E2B_API_KEY");
    } finally {
      await ledger.close();
    }
  });

  it("takes runtime urls and key variables from the server's config only, never a team's", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const opened: unknown[] = [];
      const seam = serverRuntime(ledger, {
        env: { SELFHOST_TOKEN: "admin", OPEN_SANDBOX_API_KEY: "k" },
        now: () => NOW,
        config: { runtime: { providers: { opensandbox: { url: "https://sandbox.acme.test" } } } },
        open: (_kind, config) => {
          opened.push(config.runtime?.providers?.opensandbox);
          return fakeRuntime({ kind: "opensandbox", now: () => NOW });
        },
      });
      const team = {
        runtime: {
          default: "opensandbox" as const,
          providers: {
            opensandbox: {
              url: "https://attacker.example",
              api_key_env: "SELFHOST_TOKEN",
              template: "node:22",
            },
          },
        },
      };
      const adapter = await seam({ ...run, runtime: "opensandbox" }, team);
      expect(isRefused(adapter)).toBe(false);
      expect(opened).toEqual([{ template: "node:22", url: "https://sandbox.acme.test" }]);
    } finally {
      await ledger.close();
    }
  });

  it("keeps the server config's pricing and timeouts, so the daily cap sees what a sandbox costs", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const opened: unknown[] = [];
      const seam = serverRuntime(ledger, {
        env: { OPEN_SANDBOX_API_KEY: "k" },
        now: () => NOW,
        config: {
          runtime: {
            providers: {
              opensandbox: {
                url: "http://opensandbox:8090",
                usd_per_hour: 2,
                create_timeout_seconds: 900,
                template: "node:20",
              },
            },
          },
        },
        open: (_kind, config) => {
          opened.push(config.runtime?.providers?.opensandbox);
          return fakeRuntime({ kind: "opensandbox", now: () => NOW });
        },
      });
      // No team policy for the provider: every server setting applies.
      expect(isRefused(await seam({ ...run, runtime: "opensandbox" }, {}))).toBe(false);
      // A team sets its own template and timeout, and tries to price sandboxes at nothing.
      const team = {
        runtime: {
          default: "opensandbox" as const,
          providers: {
            opensandbox: { template: "node:22", create_timeout_seconds: 60, usd_per_hour: 0 },
          },
        },
      };
      expect(isRefused(await seam({ ...run, runtime: "opensandbox" }, team))).toBe(false);
      expect(opened).toEqual([
        {
          url: "http://opensandbox:8090",
          usd_per_hour: 2,
          create_timeout_seconds: 900,
          template: "node:20",
        },
        {
          url: "http://opensandbox:8090",
          usd_per_hour: 2,
          create_timeout_seconds: 60,
          template: "node:22",
        },
      ]);
    } finally {
      await ledger.close();
    }
  });

  it("says a missing url goes in the server's config or environment, and takes it from there", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const team = {
        runtime: {
          default: "opensandbox" as const,
          providers: { opensandbox: { url: "http://opensandbox:8090" } },
        },
      };
      const refusing = serverRuntime(ledger, { env: {}, now: () => NOW });
      const refused = await refusing({ ...run, runtime: "opensandbox" }, team);
      if (!isRefused(refused)) throw new Error("expected a refusal");
      expect(refused.refusal.message).toMatch(
        /^Set url in \[runtime\.providers\.opensandbox\] of the server's own selfhost\.toml \(the file SELFHOST_CONFIG names in the server's environment\), or SELFHOST_RUNTIME_OPENSANDBOX_URL in the server's environment, such as http:\/\/localhost:8080\./,
      );
      expect(refused.refusal.message).toContain(
        "Team web's policy sets one, which the team server ignores",
      );

      const opened: unknown[] = [];
      const seam = serverRuntime(ledger, {
        env: {
          SELFHOST_RUNTIME_OPENSANDBOX_URL: "http://opensandbox:8090",
          OPEN_SANDBOX_API_KEY: "k",
        },
        now: () => NOW,
        open: (_kind, config) => {
          opened.push(config.runtime?.providers?.opensandbox);
          return fakeRuntime({ kind: "opensandbox", now: () => NOW });
        },
      });
      expect(isRefused(await seam({ ...run, runtime: "opensandbox" }, {}))).toBe(false);
      expect(opened).toEqual([{ url: "http://opensandbox:8090" }]);
    } finally {
      await ledger.close();
    }
  });

  it("sends a team's tracer only the team's own SELFHOST_RUN_SECRET_<TEAM>__* variables as headers", () => {
    const tracer = (variable: string) => {
      const parsed = parseConfig(
        `version = 1\n[integrations.tracer]\ntool = "otlp"\nendpoint = "https://attacker.example"\nheaders_env = { Authorization = "${variable}" }\n`,
      );
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      return parsed.config;
    };
    const scope = { pathPrefix: "selfhost/{team}/", sharedTeams: ["web"] };
    const unsafe = (variable: string, team = "web") =>
      unsafeTracerHeaders(tracer(variable), team, scope);
    expect(unsafe("SELFHOST_TOKEN")).toEqual(["SELFHOST_TOKEN"]);
    expect(unsafe("SELFHOST_RUN_SECRET_WEB__TRACER")).toEqual([]);
    expect(unsafe("SELFHOST_RUN_SECRET_SHARED__TRACER")).toEqual([]);
    // Another team's variable, the old single prefix, and shared ones the team is not allowed.
    expect(unsafe("SELFHOST_RUN_SECRET_API__TRACER")).toEqual(["SELFHOST_RUN_SECRET_API__TRACER"]);
    expect(unsafe("SELFHOST_RUN_SECRET_TRACER")).toEqual(["SELFHOST_RUN_SECRET_TRACER"]);
    expect(unsafe("SELFHOST_RUN_SECRET_SHARED__TRACER", "api")).toEqual([
      "SELFHOST_RUN_SECRET_SHARED__TRACER",
    ]);
  });
});
