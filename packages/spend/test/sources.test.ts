import { describe, expect, it } from "vitest";
import { oneSourcePerSession } from "../src/index.js";
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
});
