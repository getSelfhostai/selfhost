import type { LedgerEvent } from "@selfhost/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Ledger, openLedger } from "../../src/ledger.js";
import { mapGatewayLog } from "../../src/sources/gateway.js";
import { mapClaudeCodeHook, mapCodexHook } from "../../src/sources/hooks.js";
import { mapOtelLogs } from "../../src/sources/otel.js";
import { mapVendorAudit } from "../../src/sources/vendor-audit.js";
import { listJson, readJson, readJsonLines } from "../helpers.js";

const person = { person: "dev@example.com" };

function hookEvents(): LedgerEvent[] {
  // Hook payloads carry no time, so give each one its own second.
  let second = 0;
  const at = (base: string) => ({
    ...person,
    ts: `${base}${String(second++ % 60).padStart(2, "0")}.000Z`,
  });
  return [
    ...listJson("hooks", "claude-code").flatMap((file) =>
      mapClaudeCodeHook(readJson("hooks", "claude-code", file), at("2026-10-05T09:14:")),
    ),
    ...listJson("hooks", "codex")
      .filter((file) => !file.startsWith("notify-"))
      .flatMap((file) => mapCodexHook(readJson("hooks", "codex", file), at("2026-10-05T17:20:"))),
  ];
}

describe("one ledger across every source", () => {
  let ledger: Ledger;
  const sessions = {
    vendorAudit: "665bce74-4bdc-4164-8bb1-cc4246de2400",
    bedrock: "538b2156-9f52-495c-82d4-2bae253bfac6",
    codex: "01a10ca6-8deb-75c0-92f6-bb789b300b1a",
    otel: "a20d0d4b-8ee2-4416-b55d-ae9364eb8461",
  };

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    const batch = [
      ...hookEvents(),
      ...mapOtelLogs(readJson("sources", "otel", "claude-code-logs.json")),
      ...readJsonLines("sources", "gateway", "litellm-requests.jsonl").flatMap((l) =>
        mapGatewayLog(l),
      ),
      ...mapVendorAudit(
        readJson("sources", "vendor-audit", "anthropic-compliance-activities.json"),
      ),
    ];
    const result = await ledger.append(batch);
    expect(result.duplicates).toEqual([]);
  });

  afterAll(async () => {
    await ledger.close();
  });

  const sourcesOf = async (session: string) =>
    [...new Set((await ledger.query({ session, limit: 1000 })).events.map((e) => e.source))].sort();

  it("labels every event with where it came from", async () => {
    const { events } = await ledger.query({ person: "dev@example.com", limit: 1000 });
    expect([...new Set(events.map((e) => e.source))].sort()).toEqual([
      "gateway",
      "hook",
      "otel",
      "vendor_api",
    ]);
  });

  it("shows sessions the vendor audit feed misses, from hooks and the gateway", async () => {
    const audited = mapVendorAudit(
      readJson("sources", "vendor-audit", "anthropic-compliance-activities.json"),
    ).map((e) => e.session_id);
    expect(audited).not.toContain(sessions.bedrock);
    expect(audited).not.toContain(sessions.codex);
    expect(await sourcesOf(sessions.bedrock)).toEqual(["gateway"]);
    expect(await sourcesOf(sessions.codex)).toEqual(["gateway", "hook"]);
  });

  it("keeps both views of a session that several sources saw", async () => {
    expect(await sourcesOf(sessions.vendorAudit)).toEqual(["hook", "vendor_api"]);
    expect(await sourcesOf(sessions.otel)).toEqual(["otel"]);
  });

  it("answers by agent and model across sources", async () => {
    const codex = await ledger.query({ agent: "codex", model: "gpt-5.5", kind: "cost.recorded" });
    expect(codex.events.map((e) => e.source).sort()).toEqual(["gateway", "hook"]);
  });
});
