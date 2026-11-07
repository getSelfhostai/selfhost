import { appendFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { watchLogs } from "../src/index.js";
import {
  ALL_TIME,
  assistantToolLine,
  CLAUDE_DIR,
  CODEX_DIR,
  MemoryWriter,
  tempDir,
  waitFor,
} from "./helpers.js";

const POLL = { pollIntervalMs: 25, since: ALL_TIME };

describe("watchLogs", () => {
  it("writes a line appended to a Claude Code log without a restart", async () => {
    const dir = tempDir("watch-claude");
    const writer = new MemoryWriter();
    const batches: number[] = [];
    const watcher = watchLogs(
      writer,
      { ...POLL, vendor: "claude_code", claudeDir: dir.path },
      (n) => batches.push(n),
    );
    try {
      cpSync(CLAUDE_DIR, dir.path, { recursive: true });
      // New files are found on the next discovery; start from a known state.
      await waitFor(() => writer.list("session.started").length === 3, 10_000);
      const before = writer.events.size;
      const file = join(
        dir.path,
        "projects/-home-dev-acme-api/665bce74-4bdc-4164-8bb1-cc4246de2400.jsonl",
      );
      appendFileSync(
        file,
        `${assistantToolLine("toolu_01WatchTestCase000000001", "2026-10-05T09:30:00.000Z")}\n`,
      );
      await waitFor(() =>
        writer.list("tool.called").some((event) => event.tool?.input_summary === "npm run lint"),
      );
      expect(writer.events.size).toBeGreaterThan(before);
      expect(batches.length).toBeGreaterThanOrEqual(2);
    } finally {
      await watcher.close();
      dir.cleanup();
    }
  });

  it("tails Codex rollouts and new rollout files", async () => {
    const dir = tempDir("watch-codex");
    cpSync(CODEX_DIR, dir.path, { recursive: true });
    const writer = new MemoryWriter();
    const watcher = watchLogs(writer, { ...POLL, vendor: "codex", codexDir: dir.path });
    try {
      await waitFor(() => writer.list("session.started").length === 3);
      const day = join(dir.path, "sessions/2026/10/10");
      mkdirSync(day, { recursive: true });
      const file = join(
        day,
        "rollout-2026-10-10T10-00-00-01a12000-0000-7000-8000-000000000001.jsonl",
      );
      writeFileSync(
        file,
        `${JSON.stringify({
          timestamp: "2026-10-10T08:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "01a12000-0000-7000-8000-000000000001",
            cli_version: "0.142.5",
            cwd: "/home/dev/acme-api",
          },
        })}\n`,
      );
      await waitFor(() => writer.list("session.started").length === 4, 10_000);
      appendFileSync(
        file,
        `${[
          {
            timestamp: "2026-10-10T08:00:01.000Z",
            type: "turn_context",
            payload: { model: "gpt-5.5" },
          },
          {
            timestamp: "2026-10-10T08:00:05.000Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 1000,
                  cached_input_tokens: 0,
                  output_tokens: 50,
                  total_tokens: 1050,
                },
                last_token_usage: {
                  input_tokens: 1000,
                  cached_input_tokens: 0,
                  output_tokens: 50,
                  total_tokens: 1050,
                },
              },
            },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n")}\n`,
      );
      await waitFor(() =>
        writer
          .list("cost.recorded")
          .some((event) => event.session_id === "01a12000-0000-7000-8000-000000000001"),
      );
      const cost = writer
        .list("cost.recorded")
        .find((event) => event.session_id === "01a12000-0000-7000-8000-000000000001");
      expect(cost).toMatchObject({
        model: "gpt-5.5",
        cost: { input_tokens: 1000, output_tokens: 50 },
      });
      expect(cost?.cost?.usd).toBeCloseTo(1000 * 5e-6 + 50 * 30e-6, 12);
    } finally {
      await watcher.close();
      dir.cleanup();
    }
  });

  it("writes nothing new when a restarted watcher reads the same files", async () => {
    const dir = tempDir("watch-again");
    cpSync(CLAUDE_DIR, dir.path, { recursive: true });
    const writer = new MemoryWriter();
    const opts = { ...POLL, vendor: "claude_code" as const, claudeDir: dir.path };
    const first = watchLogs(writer, opts);
    await waitFor(() => writer.list("session.ended").length === 3);
    await first.close();
    const batches: number[] = [];
    const second = watchLogs(writer, opts, (n) => batches.push(n));
    try {
      await waitFor(() => batches.length > 0);
      expect(batches).toEqual([0]);
    } finally {
      await second.close();
      dir.cleanup();
    }
  });
});
