import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeLimitHit, codexLimitHit, parseLogFile } from "../src/index.js";
import { ALL_TIME, tempDir } from "./helpers.js";

const claudeError = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  isApiErrorMessage: true,
  timestamp: "2026-10-21T11:39:00.000Z",
  message: {
    model: "<synthetic>",
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input_tokens: 0, output_tokens: 0 },
  },
  ...extra,
});

describe("Claude Code usage limit lines", () => {
  it("reads the window and, when given, the reset time", () => {
    expect(claudeLimitHit(claudeError("5-hour limit reached ∙ resets 4pm"))).toEqual({
      window: "session",
    });
    expect(claudeLimitHit(claudeError("Weekly limit reached ∙ resets Oct 27, 9am"))).toEqual({
      window: "weekly",
    });
    expect(claudeLimitHit(claudeError("Claude usage limit reached|1761580800"))).toEqual({
      resets_at: "2025-10-27T16:00:00.000Z",
    });
    expect(claudeLimitHit(claudeError("You've hit your limit · resets 3pm"))).toEqual({});
  });

  it("ignores other API errors and ordinary replies", () => {
    expect(claudeLimitHit(claudeError("API Error: 529 Overloaded"))).toBeUndefined();
    expect(
      claudeLimitHit(
        claudeError('API Error: 429 {"type":"rate_limit_error"}', { error: "rate_limit" }),
      ),
    ).toBeUndefined();
    expect(
      claudeLimitHit({ ...claudeError("usage limit reached"), isApiErrorMessage: false }),
    ).toBeUndefined();
  });

  it("becomes one alert.raised event with no cost", async () => {
    const dir = tempDir("limit");
    try {
      const session = "665bce74-4bdc-4164-8bb1-cc4246de2499";
      const line = {
        ...claudeError("5-hour limit reached ∙ resets 4pm"),
        sessionId: session,
        version: "2.1.312",
        uuid: "00000000-0000-4000-8000-00000000c001",
        error: "rate_limit",
      };
      const path = join(dir.path, `${session}.jsonl`);
      writeFileSync(path, `${JSON.stringify(line)}\n${JSON.stringify(line)}\n`);
      const { events } = await parseLogFile("claude_code", path, {
        since: ALL_TIME,
        actorId: "dev@example.com",
      });
      const alerts = events.filter((event) => event.kind === "alert.raised");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        source: "local_log",
        ts: "2026-10-21T11:39:00.000Z",
        actor: { kind: "person", id: "dev@example.com" },
        agent: { vendor: "claude_code", version: "2.1.312" },
        session_id: session,
        data: { alert: "usage_limit", window: "session" },
      });
      expect(events.filter((event) => event.kind === "cost.recorded")).toEqual([]);
    } finally {
      dir.cleanup();
    }
  });
});

describe("Codex rate limit snapshots", () => {
  const snapshot = (primary: number, secondary: number, reached: string | null = null) => ({
    type: "token_count",
    info: null,
    rate_limits: {
      limit_id: "codex",
      primary: { used_percent: primary, window_minutes: 300, resets_at: 1761566400 },
      secondary: { used_percent: secondary, window_minutes: 10080, resets_at: 1761804000 },
      credits: null,
      plan_type: "team",
      rate_limit_reached_type: reached,
    },
  });

  it("reads which window is full and when it resets", () => {
    expect(codexLimitHit(snapshot(40, 100))).toEqual({
      window: "weekly",
      resets_at: "2025-10-30T06:00:00.000Z",
      window_minutes: 10080,
    });
    expect(codexLimitHit(snapshot(100, 60))).toEqual({
      window: "session",
      resets_at: "2025-10-27T12:00:00.000Z",
      window_minutes: 300,
    });
    expect(codexLimitHit(snapshot(90, 60, "primary"))).toMatchObject({
      window: "session",
      limit_type: "primary",
    });
  });

  it("keeps nothing from the snapshot but the hit", () => {
    expect(JSON.stringify(codexLimitHit(snapshot(40, 100)))).not.toContain("team");
  });

  it("ignores snapshots under the limit and other events", () => {
    expect(codexLimitHit(snapshot(12, 3))).toBeUndefined();
    expect(codexLimitHit({ type: "user_message", message: "hi" })).toBeUndefined();
  });
});
