import type { LedgerEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { isVendorRollup, oneSourcePerSession } from "../src/index.js";
import { cost } from "./helpers.js";

describe("oneSourcePerSession", () => {
  const ts = "2026-10-28T10:00:00.000Z";

  it("keeps one source per session, OpenTelemetry first", () => {
    const local = cost({ ts, usd: 1, session: "s1", source: "local_log" });
    const otel = cost({ ts, usd: 1.2, session: "s1", source: "otel" });
    const gateway = cost({ ts, usd: 2, session: "s2", source: "gateway" });
    const hook = cost({ ts, usd: 2, session: "s2", source: "hook" });
    expect(oneSourcePerSession([local, otel, gateway, hook])).toEqual([otel, hook]);
  });

  it("keeps sessions of different agents apart, and events without a session", () => {
    const claude = cost({ ts, usd: 1, session: "s1", source: "local_log" });
    const codex = cost({ ts, usd: 1, session: "s1", source: "otel", vendor: "codex" });
    const loose = cost({ ts, usd: 1, source: "gateway" });
    expect(oneSourcePerSession([claude, codex, loose])).toEqual([claude, codex, loose]);
  });

  it("counts a vendor-reported daily total only for a person-day no other source reported", () => {
    const rollup = (
      person: string,
      day: string,
      vendor: "claude_code" | "codex" = "claude_code",
    ) => {
      const event = cost({
        ts: `${day}T00:00:00.000Z`,
        usd: 5,
        person,
        source: "vendor_api",
        vendor,
      });
      return { ...event, data: { rollup: "day", vendor_api: "anthropic" } } satisfies LedgerEvent;
    };
    const adaLog = cost({ ts: "2026-10-28T15:00:00.000Z", usd: 1, person: "ada", session: "s1" });
    const adaDay = rollup("ada", "2026-10-28");
    const adaCodex = rollup("ada", "2026-10-28", "codex");
    const adaNextDay = rollup("ada", "2026-10-29");
    const benDay = rollup("ben", "2026-10-28");
    expect(isVendorRollup(adaDay)).toBe(true);
    expect(isVendorRollup(adaLog)).toBe(false);
    expect(oneSourcePerSession([adaLog, adaDay, adaCodex, adaNextDay, benDay])).toEqual([
      adaLog,
      adaCodex,
      adaNextDay,
      benDay,
    ]);
  });
});
