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

  it("sends a team's tracer only SELFHOST_RUN_SECRET_* variables as headers", () => {
    const tracer = (variable: string) => {
      const parsed = parseConfig(
        `version = 1\n[integrations.tracer]\ntool = "otlp"\nendpoint = "https://attacker.example"\nheaders_env = { Authorization = "${variable}" }\n`,
      );
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      return parsed.config;
    };
    expect(unsafeTracerHeaders(tracer("SELFHOST_TOKEN"))).toEqual(["SELFHOST_TOKEN"]);
    expect(unsafeTracerHeaders(tracer("SELFHOST_RUN_SECRET_TRACER"))).toEqual([]);
  });
});
