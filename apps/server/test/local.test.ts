import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "@selfhost/ledger";
import { EVENT_SCHEMA, type LedgerEvent, parseConfig, type RunResponse } from "@selfhost/schema";
import { exportTraces, traceIdOf } from "@selfhost/traces";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalServer } from "../src/local.js";

const RUN = "5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a88";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const done of cleanup.splice(0)) await done();
});

let n = 0;
const event = (fields: Pick<LedgerEvent, "kind" | "ts">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  source: "hook",
  actor: { kind: "person", id: "dev@example.com" },
  agent: { vendor: "claude_code", version: "2.1.0" },
  session_id: RUN,
  ...fields,
});

describe("selfhost console on a laptop", () => {
  it("links a sent run to the tracer from the laptop's selfhost.toml", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "selfhost-local-"));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const parsed = parseConfig(
      [
        "version = 1",
        "[integrations.tracer]",
        'tool = "phoenix"',
        'endpoint = "http://127.0.0.1:6006/v1/traces"',
        'run_url = "http://127.0.0.1:6006/projects/default/traces/{trace_id}"',
        "",
      ].join("\n"),
    );
    if (!parsed.ok) throw new Error("invalid test policy");

    // `selfhost traces export` sent the run from this laptop's ledger.
    const ledger = await openLedger({ dataDir });
    try {
      await ledger.append([
        event({ kind: "session.started", ts: "2026-10-12T09:00:00.000Z" }),
        event({ kind: "session.ended", ts: "2026-10-12T09:10:00.000Z" }),
      ]);
      await exportTraces(ledger, {
        settingsFor: async () => ({
          tracer: { tool: "phoenix", endpoint: "http://127.0.0.1:6006/v1/traces" },
          logPrompts: false,
          patterns: [],
        }),
        sender: () => async () => {},
        now: new Date(Date.now() + 120_000),
      });
    } finally {
      await ledger.close();
    }

    const server = await startLocalServer({
      version: "1.2.3",
      dataDir,
      port: 0,
      env: {},
      config: parsed.config,
    });
    cleanup.push(() => server.close());
    const response = await fetch(`${server.url}v1/runs/${RUN}`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as RunResponse;
    expect(body.trace_url).toBe(`http://127.0.0.1:6006/projects/default/traces/${traceIdOf(RUN)}`);
  });
});
