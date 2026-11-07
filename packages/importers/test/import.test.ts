import { appendFileSync, cpSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateEvent } from "@selfhost/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverLogFiles, importAll, parseLogFile } from "../src/index.js";
import {
  ALL_TIME,
  assistantToolLine,
  CLAUDE_DIR,
  CODEX_DIR,
  MemoryWriter,
  readJson,
  seedHome,
  tempDir,
} from "./helpers.js";

const FIXTURE_OPTS = { claudeDir: CLAUDE_DIR, codexDir: CODEX_DIR, since: ALL_TIME };

const CLAUDE_FILE = join(
  CLAUDE_DIR,
  "projects/-home-dev-acme-api/665bce74-4bdc-4164-8bb1-cc4246de2400.jsonl",
);

describe("importAll", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("reads the last 30 days of Claude Code and Codex logs with no setup", async () => {
    const home = tempDir("home");
    try {
      seedHome(home.path);
      vi.stubEnv("HOME", home.path);
      for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) {
        vi.stubEnv(name, undefined);
      }
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-10T12:00:00Z") });
      const writer = new MemoryWriter();
      const result = await importAll(writer, {});

      expect(result).toMatchObject({ files: 6, duplicates: 0 });
      expect(result.accepted).toBe(writer.events.size);
      const sessions = writer.list("session.started");
      expect(sessions.map((event) => event.agent?.vendor).sort()).toEqual([
        "claude_code",
        "claude_code",
        "claude_code",
        "codex",
        "codex",
        "codex",
      ]);
      const costs = writer.list("cost.recorded");
      expect(new Set(costs.map((event) => event.model))).toEqual(
        new Set(["claude-opus-5-5", "claude-fable-5-1", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]),
      );
      const usd = costs.reduce((sum, event) => sum + (event.cost?.usd ?? 0), 0);
      const claude = readJson<{ totals: { totalCost: number } }>(
        "expected",
        "ccusage-claude-daily.json",
      );
      const codex = readJson<{ totals: { costUSD: number } }>(
        "expected",
        "ccusage-codex-daily.json",
      );
      expect(usd).toBeCloseTo(claude.totals.totalCost + codex.totals.costUSD, 10);
      expect(
        costs.reduce((sum, event) => sum + (event.cost?.input_tokens ?? 0), 0),
      ).toBeGreaterThan(0);
    } finally {
      home.cleanup();
    }
  });

  it("defaults to a 30-day window", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00Z") });
    const writer = new MemoryWriter();
    await importAll(writer, { claudeDir: CLAUDE_DIR, codexDir: CODEX_DIR });
    const days = new Set(writer.list("cost.recorded").map((event) => event.ts.slice(0, 10)));
    expect([...days].sort()).toEqual(["2026-10-08", "2026-10-09"]);
    // The session that crossed midnight keeps its start, from before the window.
    expect(writer.list("session.started").map((event) => event.ts)).toContain(
      "2026-10-08T23:41:20.004Z",
    );
  });

  it("adds nothing when run twice over the same files", async () => {
    const writer = new MemoryWriter();
    const first = await importAll(writer, FIXTURE_OPTS);
    const second = await importAll(writer, FIXTURE_OPTS);
    expect(first.accepted).toBeGreaterThan(0);
    expect(first.duplicates).toBe(0);
    expect(second).toEqual({ files: first.files, accepted: 0, duplicates: first.accepted });
  });

  it("adds only the new entries after a log grows", async () => {
    const dir = tempDir("grow");
    try {
      cpSync(CLAUDE_DIR, dir.path, { recursive: true });
      const file = join(
        dir.path,
        "projects/-home-dev-acme-api/665bce74-4bdc-4164-8bb1-cc4246de2400.jsonl",
      );
      const opts = { claudeDir: dir.path, vendor: "claude_code" as const, since: ALL_TIME };
      const writer = new MemoryWriter();
      await importAll(writer, opts);
      appendFileSync(
        file,
        `${assistantToolLine("toolu_01GrowTestCase0000000001", "2026-10-05T09:20:00.000Z")}\n`,
      );
      const second = await importAll(writer, opts);
      // The new tool call, its usage, and a later session.ended.
      expect(second.accepted).toBe(3);
      expect(writer.list("session.ended").map((event) => event.ts)).toContain(
        "2026-10-05T09:20:00.000Z",
      );
    } finally {
      dir.cleanup();
    }
  });

  it("produces only events that validate against selfhost.event/v1", async () => {
    for (const logPrompts of [false, true]) {
      const writer = new MemoryWriter();
      await importAll(writer, { ...FIXTURE_OPTS, logPrompts });
      const kinds = new Set(writer.list().map((event) => event.kind));
      expect(kinds).toEqual(
        new Set([
          "session.started",
          "session.ended",
          "cost.recorded",
          "tool.called",
          "commit.created",
          ...(logPrompts ? ["prompt.submitted"] : []),
        ]),
      );
      for (const event of writer.list()) {
        const result = validateEvent(event);
        expect(result.ok ? [] : result.errors, event.kind).toEqual([]);
        expect(event.source).toBe("local_log");
      }
    }
  });

  it("records commits from successful git commit calls only", async () => {
    const writer = new MemoryWriter();
    await importAll(writer, FIXTURE_OPTS);
    const commits = writer
      .list("commit.created")
      .map((event) => `${event.agent?.vendor} ${event.links?.commit_sha} ${event.data?.branch}`)
      .sort();
    expect(commits).toEqual([
      "claude_code 2b7e9f0 fix/users-pagination",
      "claude_code 51ac3d4 fix/users-pagination",
      "claude_code 8c41d2e main",
      "claude_code e03f6a1 chore/release-1.5.0",
      "codex 5d0e7b3 main",
      "codex 9e4b1a7 main",
    ]);
  });
});

describe("parseLogFile", () => {
  it("gives identical events and ids on every parse", async () => {
    const first = await parseLogFile("claude_code", CLAUDE_FILE, {});
    const second = await parseLogFile("claude_code", CLAUDE_FILE, {});
    expect(first.events.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(first.nextOffset).toBe(statSync(CLAUDE_FILE).size);
  });

  it("puts the event time in the UUIDv7 time bits", async () => {
    const { events } = await parseLogFile("claude_code", CLAUDE_FILE, {});
    for (const event of events) {
      const ms = Number.parseInt(event.id.replaceAll("-", "").slice(0, 12), 16);
      expect(ms).toBe(Date.parse(event.ts));
      expect(event.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("continues from an offset with the same ids as a full read", async () => {
    const { events: all } = await parseLogFile("claude_code", CLAUDE_FILE, {});
    const text = readFileSync(CLAUDE_FILE);
    const middle = text.indexOf("\n", Math.floor(text.length / 2)) + 1;
    const head = await parseLogFile("claude_code", CLAUDE_FILE, {});
    const tail = await parseLogFile("claude_code", CLAUDE_FILE, { fromOffset: middle });
    expect(head.nextOffset).toBe(text.length);
    expect(tail.events.length).toBeGreaterThan(0);
    const ids = new Set(all.map((event) => event.id));
    for (const event of tail.events) expect(ids.has(event.id), event.kind).toBe(true);
    expect(tail.events.some((event) => event.kind === "session.started")).toBe(false);
  });

  it("keeps one cost event per API response that spans several lines", async () => {
    const { events } = await parseLogFile("claude_code", CLAUDE_FILE, {});
    const costs = events.filter((event) => event.kind === "cost.recorded");
    // Six responses; the first one is written as three lines.
    expect(costs).toHaveLength(6);
    expect(costs[0]?.cost).toMatchObject({
      input_tokens: 6,
      output_tokens: 214,
      cache_write_tokens: 18240,
    });
  });

  it("stops at a partial last line and reads it once complete", async () => {
    const dir = tempDir("partial");
    try {
      const file = join(dir.path, "s.jsonl");
      const line = assistantToolLine("toolu_01PartialLine000000001", "2026-10-05T09:20:00.000Z");
      cpSync(CLAUDE_FILE, file);
      const size = statSync(file).size;
      appendFileSync(file, line.slice(0, 40));
      const first = await parseLogFile("claude_code", file, {});
      expect(first.nextOffset).toBe(size);
      appendFileSync(file, `${line.slice(40)}\n`);
      const second = await parseLogFile("claude_code", file, { fromOffset: first.nextOffset });
      expect(second.events.map((event) => event.kind)).toContain("tool.called");
      expect(second.nextOffset).toBe(statSync(file).size);
    } finally {
      dir.cleanup();
    }
  });
});

describe("discoverLogFiles", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("finds fixture logs through CLAUDE_CONFIG_DIR and CODEX_HOME", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", CLAUDE_DIR);
    vi.stubEnv("CODEX_HOME", CODEX_DIR);
    const files = await discoverLogFiles({});
    expect(files.map((file) => file.vendor)).toEqual([
      "claude_code",
      "claude_code",
      "claude_code",
      "codex",
      "codex",
      "codex",
    ]);
    expect(await discoverLogFiles({ vendor: "codex" })).toEqual(files.slice(3));
  });

  it("accepts the projects dir itself and prefers sessions/ over archived_sessions/", async () => {
    const home = tempDir("archived");
    try {
      cpSync(join(CODEX_DIR, "sessions"), join(home.path, "sessions"), { recursive: true });
      cpSync(join(CODEX_DIR, "sessions"), join(home.path, "archived_sessions"), {
        recursive: true,
      });
      const codex = await discoverLogFiles({ vendor: "codex", codexDir: home.path });
      expect(codex).toHaveLength(3);
      expect(codex.every((file) => file.path.includes(`${home.path}/sessions/`))).toBe(true);
      const claude = await discoverLogFiles({
        vendor: "claude_code",
        claudeDir: join(CLAUDE_DIR, "projects"),
      });
      expect(claude).toHaveLength(3);
    } finally {
      home.cleanup();
    }
  });

  it("returns nothing for missing directories", async () => {
    expect(
      await discoverLogFiles({ claudeDir: "/nonexistent/claude", codexDir: "/nonexistent/codex" }),
    ).toEqual([]);
  });
});
