import { validateEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { SourcePayloadError } from "../../src/sources/common.js";
import { mapOtelLogs } from "../../src/sources/otel.js";
import { readJson, readJsonLines } from "../helpers.js";

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

  it("labels a request without query_source unknown", () => {
    expect(byEvent("api_request")[0]?.data?.request_type).toBe("unknown");
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

type Attr = [key: string, value: string | number];

function record(name: string, ts: string, attrs: Attr[], body = true) {
  return {
    ...(body ? { body: { stringValue: name } } : {}),
    attributes: [["event.name", name] as Attr, ["event.timestamp", ts] as Attr, ...attrs].map(
      ([key, value]) => ({
        key,
        value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
      }),
    ),
  };
}

const exportOf = (...records: unknown[]) => ({
  resourceLogs: [{ scopeLogs: [{ logRecords: records }] }],
});

describe("request types on Claude Code api_request events", () => {
  const week = readJsonLines("sources", "otel", "claude-code-week.jsonl");
  const costs = mapOtelLogs(week).filter((e) => e.kind === "cost.recorded");

  it("labels every request from query_source", () => {
    expect(costs).toHaveLength(128);
    expect(new Set(costs.map((e) => e.data?.request_type))).toEqual(
      new Set(["main", "subagent", "compaction", "title", "status_line", "background", "retry"]),
    );
    for (const event of costs) {
      const result = validateEvent(event);
      expect(result.ok ? [] : result.errors).toEqual([]);
    }
  });

  it("keeps the vendor's query source next to the request type", () => {
    const pairs = new Set(costs.map((e) => `${e.data?.request_source} ${e.data?.request_type}`));
    expect([...pairs].sort()).toEqual([
      "agent:builtin:general-purpose subagent",
      "agent_summary status_line",
      "auto_mode background",
      "compact compaction",
      "generate_session_title title",
      "prompt_suggestion background",
      "repl_main_thread main",
      "repl_main_thread retry",
    ]);
  });

  it("calls background agent summaries status_line even though they carry the agent's id", () => {
    const summaries = costs.filter((e) => e.data?.request_source === "agent_summary");
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((e) => e.data?.request_type === "status_line")).toBe(true);
  });

  it("marks the request Claude Code re-issued after an api_error as a retry", () => {
    const retries = costs.filter((e) => e.data?.request_type === "retry");
    expect(retries.map((e) => [e.ts.slice(0, 10), e.actor.id])).toEqual([
      ["2026-10-29", "bob@example.com"],
    ]);
  });

  it("finds the same retries whether exports are mapped together or one at a time", () => {
    const oneByOne = week.flatMap((line) => mapOtelLogs(line));
    expect(oneByOne.map((e) => e.id)).toEqual(mapOtelLogs(week).map((e) => e.id));
    expect(oneByOne.filter((e) => e.data?.request_type === "retry")).toHaveLength(1);
  });

  it("does not count a new prompt after an error as a retry", () => {
    const base: Attr[] = [
      ["session.id", "s1"],
      ["query_source", "repl_main_thread"],
      ["input_tokens", 10],
    ];
    const events = mapOtelLogs(
      exportOf(
        record("claude_code.api_error", "2026-10-29T10:00:00.000Z", [...base, ["prompt.id", "p1"]]),
        record("claude_code.api_request", "2026-10-29T10:01:00.000Z", [
          ...base,
          ["prompt.id", "p2"],
        ]),
        record("claude_code.api_request", "2026-10-29T10:02:00.000Z", [
          ...base,
          ["prompt.id", "p1"],
        ]),
      ),
    );
    const types = events.filter((e) => e.kind === "cost.recorded").map((e) => e.data?.request_type);
    expect(types).toEqual(["main", "retry"]);
  });
});

describe("Codex OpenTelemetry events", () => {
  const conversation: Attr[] = [
    ["conversation.id", "01a10ca6-8deb-75c0-92f6-bb789b300b1a"],
    ["app.version", "0.142.5"],
    ["model", "gpt-5.5"],
    ["user.email", "dev@example.com"],
  ];
  const completed: Attr[] = [
    ...conversation,
    ["event.kind", "response.completed"],
    ["input_token_count", 12000],
    ["cached_token_count", 9000],
    ["cache_write_token_count", 1000],
    ["output_token_count", 400],
    ["reasoning_token_count", 150],
  ];
  const events = mapOtelLogs(
    exportOf(
      record("codex.api_request", "2026-10-05T15:20:04.000Z", [...conversation, ["attempt", 0]]),
      record("codex.sse_event", "2026-10-05T15:20:09.000Z", [
        ...conversation,
        ["event.kind", "response.output_item.done"],
      ]),
      record("codex.sse_event", "2026-10-05T15:20:09.431Z", completed, false),
      record("codex.api_request", "2026-10-05T15:21:00.000Z", [...conversation, ["attempt", 0]]),
      record("codex.api_request", "2026-10-05T15:21:02.000Z", [...conversation, ["attempt", 1]]),
      record("codex.sse_event", "2026-10-05T15:21:09.000Z", completed, false),
    ),
    { price: () => 0.01 },
  );

  it("records tokens from response.completed and nothing from api_request", () => {
    expect(events.map((e) => e.kind)).toEqual(["cost.recorded", "cost.recorded"]);
    expect(events[0]).toMatchObject({
      source: "otel",
      agent: { vendor: "codex", version: "0.142.5" },
      model: "gpt-5.5",
      session_id: "01a10ca6-8deb-75c0-92f6-bb789b300b1a",
      actor: { kind: "person", id: "dev@example.com" },
      cost: {
        input_tokens: 2000,
        output_tokens: 400,
        cache_read_tokens: 9000,
        cache_write_tokens: 1000,
        usd: 0.01,
        estimated: true,
      },
      data: { reasoning_output_tokens: 150 },
    });
  });

  it("calls a response after a second attempt a retry, and the rest unknown", () => {
    expect(events.map((e) => e.data?.request_type)).toEqual(["unknown", "retry"]);
  });
});
