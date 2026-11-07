import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { importAll } from "@selfhost/importers";
import { type Ledger, openLedger } from "@selfhost/ledger";
import type { LedgerEvent } from "@selfhost/schema";
import { describe, expect, it, vi } from "vitest";
import { plantedValues, readPlanted } from "../../../fixtures/redaction/planted.js";
import { runImport } from "../src/import.js";
import { agentCountPrompt } from "../src/scan/telemetry.js";
import { run, tempDir } from "./run.js";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const DAY = 86_400_000;

const aged = (n: number, days: number): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-8d3e-${n.toString(16).padStart(12, "0")}`,
  schema: "selfhost.event/v1",
  ts: new Date(NOW.getTime() - days * DAY).toISOString(),
  source: "cli",
  kind: "session.started",
  actor: { kind: "person", id: "dev@example.com" },
});

async function withLedger<T>(dataDir: string, fn: (ledger: Ledger) => Promise<T>): Promise<T> {
  const ledger = await openLedger({ dataDir });
  try {
    return await fn(ledger);
  } finally {
    await ledger.close();
  }
}

const storedIds = (dataDir: string) =>
  withLedger(dataDir, async (ledger) => (await ledger.query({})).events.map((e) => e.id).sort());

describe("selfhost ledger prune", () => {
  async function seed() {
    const data = tempDir("prune").path("data");
    await withLedger(data, (ledger) =>
      ledger.append([aged(1, 400), aged(2, 45), aged(3, 20), aged(4, 1)]),
    );
    const repo = tempDir("prune-repo");
    mkdirSync(repo.path(".git"));
    return { data, repo };
  }

  it("keeps ledger.retention_days from selfhost.toml", async () => {
    const { data, repo } = await seed();
    repo.write("selfhost.toml", "version = 1\n[ledger]\nretention_days = 30\n");
    const result = await run(["ledger", "prune", "--data-dir", data, "--json"], {
      cwd: repo.root,
      now: NOW,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({
      schema: "selfhost.ledger_prune/v1",
      days: 30,
      days_from: repo.path("selfhost.toml"),
      before: new Date(NOW.getTime() - 30 * DAY).toISOString(),
      deleted: 2,
      ledger: data,
    });
    expect(await storedIds(data)).toEqual([aged(3, 20).id, aged(4, 1).id].sort());
  });

  it("defaults to 90 days and takes --days over the file", async () => {
    const { data, repo } = await seed();
    const first = await run(["ledger", "prune", "--data-dir", data], { cwd: repo.root, now: NOW });
    expect(first.out).toContain("Deleted 1 events from before");
    expect(first.out).toContain("(retention 90 days, from default)");
    repo.write("selfhost.toml", "version = 1\n[ledger]\nretention_days = 30\n");
    const second = await run(["ledger", "prune", "--data-dir", data, "--days", "10", "--json"], {
      cwd: repo.root,
      now: NOW,
    });
    expect(JSON.parse(second.out)).toMatchObject({ days: 10, days_from: "--days", deleted: 2 });
    expect(await storedIds(data)).toEqual([aged(4, 1).id]);
  });

  it("refuses a bad --days or an invalid selfhost.toml", async () => {
    const { data, repo } = await seed();
    const days = await run(["ledger", "prune", "--data-dir", data, "--days", "0"], {
      cwd: repo.root,
    });
    expect(days).toMatchObject({
      code: 1,
      err: '--days: expected a whole number of 1 or more, got "0"',
    });
    repo.write("selfhost.toml", "version = 1\n[ledger]\nretention_days = 0\n");
    const invalid = await run(["ledger", "prune", "--data-dir", data, "--json"], {
      cwd: repo.root,
    });
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.out).error).toContain("selfhost.toml:3: ledger.retention_days");
    expect(await storedIds(data)).toHaveLength(4);
  });
});

describe("the local log importer", () => {
  const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");

  /** Session logs that carry the planted secrets, in the Claude Code and Codex layouts. */
  function plantedLogs() {
    const dir = tempDir("planted");
    const lines = readPlanted("events-with-secrets.jsonl").split("\n").filter(Boolean);
    const codex = lines.filter((line) => line.includes('"response_item"'));
    dir.write(
      "claude/projects/-home-dev-acme-api/00000000-0000-4000-8000-000000000099.jsonl",
      `${lines.filter((line) => !codex.includes(line)).join("\n")}\n`,
    );
    dir.write(
      "codex/sessions/2026/10/10/rollout-2026-10-10T12-05-00-01a12000-0000-7000-8000-000000000002.jsonl",
      `${codex.join("\n")}\n`,
    );
    return { claudeDir: dir.path("claude"), codexDir: dir.path("codex") };
  }

  const io = () => ({ env: {}, write: () => {}, configPath: tempDir("io").path("config.json") });

  it("stores prompt text only with --prompts, and masks secrets either way", async () => {
    for (const prompts of [false, true]) {
      const data = tempDir("import").path("data");
      await runImport({ ...plantedLogs(), since: "2026-01-01", prompts, dataDir: data }, io());
      const events = await withLedger(data, async (ledger) => (await ledger.query({})).events);
      const json = JSON.stringify(events);
      for (const { kind, value } of plantedValues()) expect(json, kind).not.toContain(value);
      const prompt = events.find((event) => event.kind === "prompt.submitted");
      if (prompts) expect(prompt?.data?.prompt).toContain("[redacted]");
      else expect(json).not.toContain("Use this key");
    }
  });

  it("cannot store prompt text in a ledger that has prompt logging off", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      await importAll(ledger, {
        claudeDir: join(fixtures, "claude-code"),
        codexDir: join(fixtures, "codex"),
        since: new Date("2026-01-01T00:00:00Z"),
        logPrompts: true,
      });
      const { events } = await ledger.query({ kind: "prompt.submitted", limit: 1000 });
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.data).not.toHaveProperty("prompt");
        expect(event.redacted).toContain("data.prompt");
      }
    } finally {
      await ledger.close();
    }
  });
});

describe("telemetry", () => {
  it("stays off until someone answers yes and sets an endpoint", async () => {
    const send = vi.fn(async () => {});
    const configPath = tempDir("telemetry").path("config.json");
    const env = { SELFHOST_TELEMETRY_URL: "http://127.0.0.1:9/count" };
    expect(await agentCountPrompt(3, { env, configPath, send })).toBe("not_asked");
    const yes = async () => true;
    expect(await agentCountPrompt(3, { env: {}, configPath, ask: yes, send })).toBe("no_endpoint");
    expect(send).not.toHaveBeenCalled();
  });
});
