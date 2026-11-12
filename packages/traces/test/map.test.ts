import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importAll } from "@selfhost/importers";
import type { LedgerEvent } from "@selfhost/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { runSpans, spanIdOf, summarizeRun, type TraceSpan, traceIdOf } from "../src/index.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");
const NOW = new Date("2026-11-08T00:00:00Z");

/** Two sessions recorded by hooks, OpenTelemetry and the local logs at once. */
const brief = JSON.parse(readFileSync(join(FIXTURES, "brief", "agent-pr.json"), "utf8"));
const briefEvents: LedgerEvent[] = brief.inputs.run.events;
const CLAUDE = "5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87";
const CODEX = "0199f2a4-6c1d-7e3b-9f20-5b8c7d6e4a31";
const session = (id: string) => briefEvents.filter((e) => e.session_id === id);
const promptText = String(session(CLAUDE).find((e) => e.kind === "prompt.submitted")?.data?.prompt);

const named = (spans: TraceSpan[], prefix: string) =>
  spans.filter((span) => span.name.startsWith(prefix));
const byTool = (spans: TraceSpan[], id: string) =>
  spans.find((span) => span.attributes["gen_ai.tool.call.id"] === id);

describe("runSpans on a Claude Code session reported by three sources", () => {
  const spans = runSpans(CLAUDE, session(CLAUDE), { logPrompts: false, root: true, now: NOW });
  const root = spans.find((span) => span.parentSpanId === undefined);

  it("puts the session under one invoke_agent root with the GenAI attributes", () => {
    expect(root).toMatchObject({
      traceId: traceIdOf(CLAUDE),
      spanId: spanIdOf(CLAUDE, "root"),
      name: "invoke_agent claude_code",
      start: "2026-10-12T09:00:00.000Z",
      end: "2026-10-12T09:18:00.000Z",
    });
    expect(root?.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "claude_code",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.conversation.id": CLAUDE,
      "session.id": CLAUDE,
      "selfhost.run.ended_by": "session_end",
    });
    // Usage stays on the chat spans, so tracers that sum a trace count it once.
    expect(root?.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
    for (const span of spans) {
      expect(span.traceId).toBe(traceIdOf(CLAUDE));
      if (span !== root) expect(span.parentSpanId).toBeDefined();
    }
  });

  it("makes one execute_tool span per call, keeping the hook's calls over the local log's", () => {
    const tools = named(spans, "execute_tool ");
    expect(tools).toHaveLength(12);
    expect(byTool(spans, "toolu_04")).toMatchObject({
      name: "execute_tool Bash",
      start: "2026-10-12T09:06:00.000Z",
      end: "2026-10-12T09:06:40.000Z",
    });
    expect(byTool(spans, "toolu_04")?.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "Bash",
      "gen_ai.tool.type": "function",
      "selfhost.tool.finished": true,
    });
  });

  it("joins an OpenTelemetry result without a tool_use_id to its call, with the failure", () => {
    const failed = byTool(spans, "toolu_05");
    expect(failed?.error).toEqual({
      type: "tool_error",
      message: "AssertionError: expected 429 to be 200",
    });
    expect(failed?.attributes["error.type"]).toBe("tool_error");
    expect(failed?.eventIds).toHaveLength(3);
    // toolu_07's only result came from OpenTelemetry.
    expect(byTool(spans, "toolu_07")?.end).toBe("2026-10-12T09:11:15.000Z");
    expect(byTool(spans, "toolu_01")?.attributes["selfhost.tool.finished"]).toBe(false);
  });

  it("counts each model request once, from the preferred source", () => {
    const chats = named(spans, "chat");
    expect(chats).toHaveLength(3);
    expect(chats.every((span) => span.attributes["selfhost.event.source"] === "otel")).toBe(true);
    for (const chat of chats) {
      expect(chat.kind).toBe("client");
      expect(chat.attributes["gen_ai.operation.name"]).toBe("chat");
      expect(chat.attributes["gen_ai.request.model"]).toBeTypeOf("string");
      expect(chat.attributes["gen_ai.usage.input_tokens"]).toBeTypeOf("number");
      expect(chat.attributes["gen_ai.usage.output_tokens"]).toBeTypeOf("number");
    }
    const summary = summarizeRun(CLAUDE, session(CLAUDE), { now: NOW });
    const usd = chats.reduce((sum, span) => sum + Number(span.attributes["gen_ai.usage.cost"]), 0);
    expect(usd).toBeCloseTo(summary.cost_usd, 6);
  });

  it("puts policy verdicts under the tool call they judged", () => {
    const guardrails = named(spans, "guardrail ");
    expect(guardrails.map((g) => g.name).sort()).toEqual([
      "guardrail no-force-push",
      "guardrail prod-database",
      "guardrail prod-database",
    ]);
    const force = guardrails.find((g) => g.name === "guardrail no-force-push");
    expect(force?.parentSpanId).toBe(byTool(spans, "toolu_11")?.spanId);
    expect(force?.attributes).toMatchObject({
      "selfhost.policy.verdict": "block",
      "selfhost.policy.mode": "enforce",
      "selfhost.policy.rule_id": "no-force-push",
    });
  });

  it("sends no prompt text while log_prompts is off", () => {
    const prompt = spans.find((span) => span.name === "user_prompt");
    expect(prompt?.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(JSON.stringify(spans)).not.toContain(promptText);
  });

  it("sends the prompt as gen_ai.input.messages when log_prompts is on", () => {
    const logged = runSpans(CLAUDE, session(CLAUDE), {
      logPrompts: true,
      root: true,
      now: NOW,
      tool: "langfuse",
    });
    const prompt = logged.find((span) => span.name === "user_prompt");
    expect(JSON.parse(String(prompt?.attributes["gen_ai.input.messages"]))).toEqual([
      { role: "user", parts: [{ type: "text", content: promptText }] },
    ]);
    expect(prompt?.attributes["langfuse.observation.type"]).toBe("event");
  });

  it("masks [[redaction]] patterns again before sending", () => {
    const masked = runSpans(CLAUDE, session(CLAUDE), {
      logPrompts: false,
      patterns: [{ name: "feature", pattern: "per-key" }],
      root: true,
      now: NOW,
    });
    expect(JSON.stringify(spans)).toContain("per-key");
    const text = JSON.stringify(masked);
    expect(text).not.toContain("per-key");
    expect(text).toContain("[redacted:feature]");
  });

  it("gives the same ids every time, and only fresh events' spans with root off", () => {
    const again = runSpans(CLAUDE, session(CLAUDE), { logPrompts: false, root: true, now: NOW });
    expect(again.map((s) => s.spanId)).toEqual(spans.map((s) => s.spanId));
    const commit = session(CLAUDE).find((e) => e.kind === "commit.created");
    const late = runSpans(CLAUDE, session(CLAUDE), {
      logPrompts: false,
      root: false,
      fresh: new Set([commit?.id ?? ""]),
      now: NOW,
    });
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({
      name: "commit.created",
      parentSpanId: spanIdOf(CLAUDE, "root"),
    });
  });

  it("adds what Phoenix reads for the tree", () => {
    const phoenix = runSpans(CLAUDE, session(CLAUDE), {
      logPrompts: false,
      root: true,
      now: NOW,
      tool: "phoenix",
    });
    const kinds = new Set(phoenix.map((span) => span.attributes["openinference.span.kind"]));
    expect([...kinds].sort()).toEqual(["AGENT", "CHAIN", "GUARDRAIL", "LLM", "TOOL"]);
  });

  it("sends cache tokens as OpenInference sub-counts of the prompt, so they are priced as cached", () => {
    const phoenix = runSpans(CLAUDE, session(CLAUDE), {
      logPrompts: false,
      root: true,
      now: NOW,
      tool: "phoenix",
    });
    const chats = phoenix.filter((span) => span.attributes["openinference.span.kind"] === "LLM");
    expect(chats.length).toBeGreaterThan(0);
    for (const chat of chats) {
      const read = chat.attributes["llm.token_count.prompt_details.cache_read"];
      const write = chat.attributes["llm.token_count.prompt_details.cache_write"];
      expect(read).toBe(chat.attributes["gen_ai.usage.cache_read.input_tokens"]);
      expect(write).toBe(chat.attributes["gen_ai.usage.cache_creation.input_tokens"]);
      expect(Number(chat.attributes["llm.token_count.prompt"])).toBeGreaterThanOrEqual(
        Number(read) + Number(write),
      );
    }
    expect(
      chats.some(
        (chat) => Number(chat.attributes["llm.token_count.prompt_details.cache_read"]) > 0,
      ),
    ).toBe(true);
  });

  it("gives the root span an input and an outcome, with no prompt text while it is off", () => {
    for (const tool of ["phoenix", "langfuse"] as const) {
      const traced = runSpans(CLAUDE, session(CLAUDE), {
        logPrompts: false,
        root: true,
        now: NOW,
        tool,
      });
      const top = traced.find((span) => span.parentSpanId === undefined);
      const key = tool === "phoenix" ? "" : "langfuse.observation.";
      const input = String(top?.attributes[tool === "phoenix" ? "input.value" : `${key}input`]);
      const output = String(top?.attributes[tool === "phoenix" ? "output.value" : `${key}output`]);
      expect(input).toMatch(/^First prompt: \d+ characters, text not logged/);
      expect(input).not.toContain(promptText);
      expect(output).toMatch(/^Session ended\. \d+ tool calls/);
      expect(output).toMatch(/\$\d+\.\d{4}\.$/);
    }
    const logged = runSpans(CLAUDE, session(CLAUDE), {
      logPrompts: true,
      root: true,
      now: NOW,
      tool: "phoenix",
    });
    const top = logged.find((span) => span.parentSpanId === undefined);
    expect(String(top?.attributes["input.value"])).toContain(promptText.slice(0, 40));
  });
});

describe("runSpans on a Codex session with no session end", () => {
  it("ends the root at the last event once the run is idle", () => {
    const spans = runSpans(CODEX, session(CODEX), { logPrompts: false, root: true, now: NOW });
    const root = spans.find((span) => span.parentSpanId === undefined);
    expect(root).toMatchObject({
      name: "invoke_agent codex",
      end: "2026-10-12T09:24:00.000Z",
    });
    expect(root?.attributes["selfhost.run.ended_by"]).toBe("idle");
    // The second result has no call left to join, so it is a span of its own.
    expect(named(spans, "execute_tool exec_command")).toHaveLength(2);
  });

  it("is still going right after its last event", () => {
    const summary = summarizeRun(CODEX, session(CODEX), {
      now: new Date("2026-10-12T09:30:00Z"),
    });
    expect(summary.ended_at).toBeNull();
  });
});

describe("runSpans on imported session logs", () => {
  const events: LedgerEvent[] = [];
  beforeAll(async () => {
    await importAll(
      {
        append: async (batch) => {
          events.push(...batch);
          return { accepted: batch.map((event) => event.id), duplicates: [] };
        },
      },
      {
        claudeDir: join(FIXTURES, "claude-code"),
        codexDir: join(FIXTURES, "codex"),
        since: new Date("2026-10-01T00:00:00Z"),
        actorId: "dev@example.com",
      },
    );
  });

  it("maps every session to a valid trace", () => {
    const sessions = [...new Set(events.flatMap((e) => (e.session_id ? [e.session_id] : [])))];
    expect(sessions.length).toBeGreaterThanOrEqual(6);
    for (const id of sessions) {
      const own = events.filter((e) => e.session_id === id);
      const spans = runSpans(id, own, { logPrompts: false, root: true, now: NOW });
      const ids = new Set(spans.map((span) => span.spanId));
      expect(ids.size).toBe(spans.length);
      expect(spans.filter((span) => span.parentSpanId === undefined)).toHaveLength(1);
      for (const span of spans) {
        expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
        expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
        if (span.parentSpanId) expect(ids.has(span.parentSpanId)).toBe(true);
        expect(Date.parse(span.end)).toBeGreaterThanOrEqual(Date.parse(span.start));
      }
      expect(named(spans, "chat").length + named(spans, "execute_tool").length).toBeGreaterThan(0);
    }
  });
});
