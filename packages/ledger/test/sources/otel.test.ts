import { validateEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { SourcePayloadError } from "../../src/sources/common.js";
import { mapOtelLogs } from "../../src/sources/otel.js";
import { readJson } from "../helpers.js";

const request = readJson("sources", "otel", "claude-code-logs.json");
const events = mapOtelLogs(request);
const byEvent = (name: string) =>
  events.filter((e) => e.data?.otel_event === `claude_code.${name}`);

describe("Claude Code OpenTelemetry logs", () => {
  it("maps each known event and skips the rest", () => {
    expect(events.map((e) => [e.data?.otel_event, e.kind])).toEqual([
      ["claude_code.user_prompt", "prompt.submitted"],
      ["claude_code.api_request", "cost.recorded"],
      ["claude_code.tool_decision", "decision.recorded"],
      ["claude_code.tool_result", "tool.result"],
      ["claude_code.tool_decision", "decision.recorded"],
      ["claude_code.api_error", "alert.raised"],
    ]);
  });

  it("produces valid events labelled otel, with who, session, agent and time", () => {
    for (const event of events) {
      const result = validateEvent(event);
      expect(result.ok ? [] : result.errors).toEqual([]);
      expect(event).toMatchObject({
        source: "otel",
        actor: { kind: "person", id: "dev@example.com" },
        agent: { vendor: "claude_code", version: "2.1.309" },
        session_id: "a20d0d4b-8ee2-4416-b55d-ae9364eb8461",
      });
    }
    expect(events[0]?.ts).toBe("2026-10-06T14:02:15.204Z");
  });

  it("records tokens and the cost Claude Code reports", () => {
    expect(byEvent("api_request")[0]).toMatchObject({
      model: "claude-opus-5-5",
      cost: {
        input_tokens: 6,
        output_tokens: 412,
        cache_read_tokens: 18234,
        cache_write_tokens: 4120,
        usd: 0.0841,
        estimated: true,
      },
    });
  });

  it("maps config decisions to allow and block and user decisions to approve and deny", () => {
    expect(byEvent("tool_decision").map((e) => e.decision)).toEqual([
      { verdict: "allow", by: "config" },
      { verdict: "deny", by: "dev@example.com" },
    ]);
  });

  it("summarizes tool parameters", () => {
    expect(byEvent("tool_result")[0]).toMatchObject({
      tool: { name: "Bash", input_summary: "npm test" },
      target: { type: "command", value: "npm test" },
      data: { success: false, duration_ms: 2690 },
    });
  });

  it("keeps prompt length and never invents prompt text", () => {
    const [prompt] = byEvent("user_prompt");
    expect(prompt?.data?.prompt_chars).toBe(142);
    expect(prompt?.data?.prompt).toBeUndefined();
  });

  it("gives the same records the same ids", () => {
    expect(mapOtelLogs(request).map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("falls back to timeUnixNano and to ctx.person", () => {
    const record = {
      timeUnixNano: "1791727200000000000",
      body: { stringValue: "claude_code.user_prompt" },
      attributes: [{ key: "session.id", value: { stringValue: "s1" } }],
    };
    const [event] = mapOtelLogs(
      { resourceLogs: [{ scopeLogs: [{ logRecords: [record] }] }] },
      { person: "lead@example.com" },
    );
    expect(event).toMatchObject({
      ts: "2026-10-11T14:00:00.000Z",
      actor: { kind: "person", id: "lead@example.com" },
      session_id: "s1",
    });
  });

  it("rejects input that is not an OTLP logs export", () => {
    expect(() => mapOtelLogs({ resourceMetrics: [] })).toThrow(SourcePayloadError);
  });
});
