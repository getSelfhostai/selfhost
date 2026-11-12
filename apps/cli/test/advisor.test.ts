import { writeFileSync } from "node:fs";
import { openLedger } from "@selfhost/ledger";
import { type AdvisorReport, EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { run, tempDir } from "./run.js";

const NOW = new Date("2026-11-12T10:30:00.000Z");

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  ts: "2026-11-10T10:20:00.000Z",
  source: "hook",
  actor: { kind: "person", id: "ada@example.com" },
  agent: { vendor: "claude_code" },
  repo: "acme/web",
  session_id: "s-ada",
  ...fields,
});

describe("selfhost advisor", () => {
  it("prints the week of this laptop's ledger", async () => {
    const data = tempDir("advisor-data");
    const ledger = await openLedger({ dataDir: data.root });
    await ledger.append([
      event({ kind: "session.started" }),
      event({
        kind: "cost.recorded",
        source: "otel",
        cost: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_tokens: 300,
          cache_write_tokens: 0,
          usd: 1.25,
          estimated: false,
        },
      }),
      ...[1, 2, 3].map(() =>
        event({
          kind: "policy.evaluated",
          decision: { verdict: "block", rule_id: "secret-files" },
        }),
      ),
    ]);
    await ledger.close();

    const text = await run(["advisor", "--data-dir", data.root], { now: NOW });
    expect(text.code).toBe(0);
    const lines = text.out.split("\n");
    expect(lines[0]).toBe("Agents, 2026-11-05 to 2026-11-12.");
    expect(lines).toContain(
      "1. Ask ada@example.com why their agents keep hitting secret-files. It stopped their agents 3 times this week. Repeated hits mean the task needs another approach or the rule a narrower match.",
    );
    expect(lines).toContain("Where money went: $1.25 on models, cache hit rate 75%.");
    expect(lines).toContain("- ada@example.com: acme/web (1)");

    const json = await run(["advisor", "--data-dir", data.root, "--json"], { now: NOW });
    const report = JSON.parse(json.out) as AdvisorReport;
    expect(report).toMatchObject({ schema: "selfhost.advisor/v1", scope: "team", teams: null });
    expect(report.blocked.blocked).toBe(3);
  });

  it("asks the team server in a team", async () => {
    const config = tempDir("advisor-config");
    const configPath = config.path("config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        server: "https://selfhost.example.com",
        token: "person-token",
        person: "lead@example.com",
        team: "web",
      }),
    );
    const asked: string[] = [];
    const empty = { blocked: 0, asked: 0, would_block: 0, would_ask: 0 };
    const answer: AdvisorReport = {
      schema: "selfhost.advisor/v1",
      from: "2026-11-05T10:30:00.000Z",
      to: NOW.toISOString(),
      scope: "self",
      person: "lead@example.com",
      teams: ["web"],
      shipped: { opened: 0, merged: 0, by: [] },
      blocked: {
        ...empty,
        rules: [],
        exceptions: { requested: 0, approved: 0, denied: 0, used: 0 },
      },
      spend: { usd: 0, vendor_usd: 0, cache_hit_rate: null, by: [], billing: [], sandbox: null },
      quality: { merged: 0, reverted: 0, reworked: 0, reverts: [], signals: [] },
      presence: { work: [], overlaps: [] },
      recommendations: [],
    };
    const result = await run(["advisor", "--team", "web"], {
      configPath,
      now: NOW,
      fetch: async (url, init) => {
        asked.push(`${init.method} ${url} ${new Headers(init.headers).get("authorization")}`);
        return new Response(JSON.stringify(answer), { status: 200 });
      },
    });
    expect(asked).toEqual([
      `GET https://selfhost.example.com/v1/advisor?team=web&to=${encodeURIComponent(NOW.toISOString())} Bearer person-token`,
    ]);
    expect(result.out.split("\n")[0]).toBe("Your agents, 2026-11-05 to 2026-11-12.");
  });
});
