import { type LedgerEvent, validateEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { SourcePayloadError } from "../../src/sources/common.js";
import { mapClaudeCodeHook, mapCodexHook, mapCodexNotify } from "../../src/sources/hooks.js";
import { listJson, readJson, thrown } from "../helpers.js";

const ctx = { ts: "2026-10-05T09:14:05.000Z", person: "dev@example.com", repo: "acme/api" };

const CLAUDE_CODE: Record<string, string[]> = {
  "Notification.json": ["approval.requested"],
  "PostToolUse.json": ["tool.result"],
  "PreCompact.json": [],
  "PreToolUse.json": ["tool.called"],
  "SessionEnd.json": ["session.ended"],
  "SessionStart.json": ["session.started"],
  "Stop.json": [],
  "SubagentStop.json": [],
  "UserPromptSubmit.json": ["prompt.submitted"],
};

const CODEX: Record<string, string[]> = {
  "Interrupt.json": [],
  "PermissionRequest.json": ["approval.requested"],
  "PostCompact.json": [],
  "PostModelRequest.json": ["cost.recorded"],
  "PostToolUse.json": ["tool.result"],
  "PreCompact.json": [],
  "PreModelRequest.json": [],
  "PreToolUse.json": ["tool.called"],
  "SessionEnd.json": ["session.ended"],
  "SessionStart.json": ["session.started"],
  "Stop.json": [],
  "SubagentStart.json": [],
  "SubagentStop.json": [],
  "UserPromptSubmit.json": ["prompt.submitted"],
  "notify-agent-turn-complete.json": ["prompt.submitted"],
};

const mapClaude = (_file: string, payload: unknown, context = ctx) =>
  mapClaudeCodeHook(payload, context);
const mapCodex = (file: string, payload: unknown, context = ctx) =>
  file.startsWith("notify-") ? mapCodexNotify(payload, context) : mapCodexHook(payload, context);

function expectValid(events: LedgerEvent[]) {
  for (const event of events) {
    const result = validateEvent(event);
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(event.source).toBe("hook");
  }
}

describe.each([
  ["claude-code", CLAUDE_CODE, "claude_code", mapClaude] as const,
  ["codex", CODEX, "codex", mapCodex] as const,
])("%s hook fixtures", (folder, expected, vendor, map) => {
  it("has an expectation for every fixture", () => {
    expect(listJson("hooks", folder)).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))("maps %s to %j", (file, kinds) => {
    const events = map(file, readJson("hooks", folder, file));
    expect(events.map((e) => e.kind)).toEqual(kinds);
    expectValid(events);
    for (const event of events) {
      expect(event.agent?.vendor).toBe(vendor);
      expect(event.actor).toEqual({ kind: "person", id: "dev@example.com" });
      expect(event.ts).toBe(ctx.ts);
      expect(event.repo).toBe("acme/api");
    }
  });

  it.each(Object.keys(expected))("gives %s a stable id", (file) => {
    const payload = readJson("hooks", folder, file);
    const ids = (context = ctx) => map(file, payload, context).map((e) => e.id);
    expect(ids()).toEqual(ids());
    if (ids().length > 0) {
      expect(ids({ ...ctx, ts: "2026-10-05T09:14:06.000Z" })).not.toEqual(ids());
    }
  });
});

describe("hook mapping details", () => {
  const claude = (file: string, context: object = ctx) =>
    mapClaudeCodeHook(readJson("hooks", "claude-code", file), context)[0];

  it("records the command a Bash call runs", () => {
    expect(claude("PreToolUse.json")).toMatchObject({
      tool: { name: "Bash", input_summary: expect.stringContaining("git commit") },
      target: { type: "command" },
      session_id: "665bce74-4bdc-4164-8bb1-cc4246de2400",
      data: { tool_use_id: "toolu_01obb3F6fCdn3qIF48WBmAUY" },
    });
  });

  it("records file targets relative to the working directory", () => {
    expect(claude("PostToolUse.json")).toMatchObject({
      tool: { name: "Edit", input_summary: "src/app.ts" },
      target: { type: "file", value: "src/app.ts" },
      data: { duration_ms: 9 },
    });
  });

  it("summarizes Codex apply_patch by file", () => {
    const [event] = mapCodexHook(readJson("hooks", "codex", "PostToolUse.json"), ctx);
    expect(event?.tool).toEqual({
      name: "apply_patch",
      input_summary: "A src/middleware/logger.ts, M src/app.ts",
    });
    expect(event?.target).toBeUndefined();
  });

  it("keeps the model from SessionStart", () => {
    expect(claude("SessionStart.json")?.model).toBe("claude-opus-5-5");
  });

  it("stores prompt length, not text, unless prompts are logged", () => {
    const prompt = (readJson("hooks", "claude-code", "UserPromptSubmit.json") as { prompt: string })
      .prompt;
    const off = claude("UserPromptSubmit.json");
    expect(off?.redacted).toEqual(["data.prompt"]);
    expect(off?.data).toEqual({
      hook_event: "UserPromptSubmit",
      prompt_id: "bcb88634-48d1-4de2-892b-360e49853c6b",
      prompt_chars: prompt.length,
    });
    expect(JSON.stringify(off)).not.toContain(prompt);
    const on = claude("UserPromptSubmit.json", { ...ctx, logPrompts: true });
    expect(on?.redacted).toBeUndefined();
    expect(on?.data?.prompt).toBe(prompt);
  });

  it("turns Codex token usage into uncached, cached and output tokens", () => {
    const [event] = mapCodexHook(readJson("hooks", "codex", "PostModelRequest.json"), ctx);
    expect(event?.cost).toEqual({
      input_tokens: 17604 - 17280,
      output_tokens: 164,
      cache_read_tokens: 17280,
      cache_write_tokens: 0,
      usd: 0,
      estimated: true,
    });
    expect(event?.data?.unpriced).toBe(true);
    const priced = mapCodexHook(readJson("hooks", "codex", "PostModelRequest.json"), {
      ...ctx,
      price: () => 0.0123,
    });
    expect(priced[0]?.cost?.usd).toBe(0.0123);
    expect(priced[0]?.data?.unpriced).toBeUndefined();
  });

  it("uses the agent session as the actor when no person is known", () => {
    const [event] = mapCodexHook(readJson("hooks", "codex", "SessionStart.json"), { ts: ctx.ts });
    expect(event?.actor).toEqual({
      kind: "agent",
      id: "codex:session:01a10ca6-8deb-75c0-92f6-bb789b300b1a",
    });
  });

  it("names the subagent", () => {
    const payload = {
      ...(readJson("hooks", "claude-code", "PreToolUse.json") as object),
      agent_type: "Explore",
    };
    expect(mapClaudeCodeHook(payload, ctx)[0]?.agent).toEqual({
      vendor: "claude_code",
      name: "Explore",
    });
  });

  it("maps unknown hook events to nothing", () => {
    const payload = { session_id: "s", cwd: "/home/dev/acme-api", hook_event_name: "TeammateIdle" };
    expect(mapClaudeCodeHook(payload, ctx)).toEqual([]);
    expect(mapCodexHook(payload, ctx)).toEqual([]);
  });

  it("rejects payloads that are not hook payloads, naming the field", () => {
    expect(() => mapClaudeCodeHook({ hook_event_name: "PreToolUse", cwd: "/" }, ctx)).toThrow(
      SourcePayloadError,
    );
    const error = thrown(() =>
      mapCodexHook({ hook_event_name: "SessionStart", session_id: "s", source: "startup" }, ctx),
    );
    expect(error).toBeInstanceOf(SourcePayloadError);
    expect((error as SourcePayloadError).errors.map((e) => e.field)).toContain("cwd");
  });
});
