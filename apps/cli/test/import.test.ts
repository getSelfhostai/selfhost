import { join } from "node:path";
import { openLedger } from "@selfhost/ledger";
import { describe, expect, it } from "vitest";
import { parseSince, parseVendor, runImport } from "../src/import.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const sources = {
  claudeDir: join(fixtures, "claude-code"),
  codexDir: join(fixtures, "codex"),
  since: "2026-10-01",
  person: "dev@example.com",
};

describe("parseSince", () => {
  const now = new Date("2026-11-07T00:00:00Z");

  it("reads day and hour durations", () => {
    expect(parseSince("30d", now)?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(parseSince("12h", now)?.toISOString()).toBe("2026-11-06T12:00:00.000Z");
  });

  it("reads dates and rejects nonsense", () => {
    expect(parseSince("2026-10-01", now)?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(() => parseSince("soon", now)).toThrow(/--since/);
  });
});

describe("parseVendor", () => {
  it("maps the names people type", () => {
    expect(parseVendor("claude")).toBe("claude_code");
    expect(parseVendor("Codex")).toBe("codex");
    expect(parseVendor(undefined)).toBeUndefined();
    expect(() => parseVendor("copilot")).toThrow(/--vendor/);
  });
});

describe("selfhost import", () => {
  it("imports the fixture logs once and finds only duplicates the second time", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    const lines: string[] = [];
    const io = { env: {}, write: (line: string) => lines.push(line) };
    try {
      const first = await runImport(sources, io, ledger);
      expect(first.files).toBeGreaterThanOrEqual(6);
      expect(first.accepted).toBeGreaterThan(0);

      const second = await runImport(sources, io, ledger);
      expect(second.accepted).toBe(0);
      expect(second.duplicates).toBe(first.accepted);

      const page = await ledger.query({ person: "dev@example.com", kind: "cost.recorded" });
      expect(page.events.length).toBeGreaterThan(0);
      expect(lines[0]).toMatch(/^Imported \d+ new events from \d+ log files/);
    } finally {
      await ledger.close();
    }
  });

  it("prints one JSON object with --json", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    const lines: string[] = [];
    try {
      await runImport(
        { ...sources, json: true },
        { env: {}, write: (line) => lines.push(line) },
        ledger,
      );
      expect(lines).toHaveLength(1);
      const report = JSON.parse(lines[0] ?? "");
      expect(report).toMatchObject({ schema: "selfhost.import/v1", duplicates: 0 });
      expect(report.accepted).toBeGreaterThan(0);
    } finally {
      await ledger.close();
    }
  });
});
