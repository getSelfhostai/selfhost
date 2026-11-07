import { validateEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { SourcePayloadError } from "../../src/sources/common.js";
import { mapGatewayLog } from "../../src/sources/gateway.js";
import { readJsonLines } from "../helpers.js";

const lines = readJsonLines("sources", "gateway", "litellm-requests.jsonl");
const [bedrock, codex, failed] = lines.map((line) => mapGatewayLog(line));

describe("LiteLLM gateway request logs", () => {
  it("maps each line to one valid event labelled gateway", () => {
    for (const events of [bedrock, codex, failed]) {
      expect(events).toHaveLength(1);
      const result = validateEvent(events?.[0]);
      expect(result.ok ? [] : result.errors).toEqual([]);
      expect(events?.[0]?.source).toBe("gateway");
    }
  });

  it("records a Bedrock request from Claude Code with uncached input tokens", () => {
    expect(bedrock?.[0]).toMatchObject({
      kind: "cost.recorded",
      ts: "2026-10-08T23:41:25.118Z",
      actor: { kind: "person", id: "dev@example.com" },
      agent: { vendor: "claude_code", version: "2.1.309" },
      model: "claude-fable-5-1",
      session_id: "538b2156-9f52-495c-82d4-2bae253bfac6",
      team: "platform",
      cost: {
        input_tokens: 21450 - 17920 - 3410,
        output_tokens: 388,
        cache_read_tokens: 17920,
        cache_write_tokens: 3410,
        usd: 0.0412,
        estimated: true,
      },
      data: {
        gateway: "litellm",
        provider: "bedrock",
        duration_ms: 6786,
        request_type: "unknown",
      },
    });
  });

  it("detects Codex from the user agent and reads OpenAI cached tokens", () => {
    expect(codex?.[0]).toMatchObject({
      agent: { vendor: "codex", version: "0.142.5" },
      model: "gpt-5.5",
      cost: { input_tokens: 324, cache_read_tokens: 17280, output_tokens: 164, usd: 0.0094 },
    });
  });

  it("records a failed request as an alert, not a cost", () => {
    expect(failed?.[0]).toMatchObject({
      kind: "alert.raised",
      data: { alert: "model_request_failed", status: "failure" },
    });
    expect(failed?.[0]?.cost).toBeUndefined();
    expect(String(failed?.[0]?.data?.error)).toContain("ThrottlingException");
  });

  it("accepts a raw JSON line and gives it the same id", () => {
    const text = JSON.stringify(lines[0]);
    expect(mapGatewayLog(text)[0]?.id).toBe(bedrock?.[0]?.id);
  });

  it("rejects lines without a request id or start time", () => {
    expect(() => mapGatewayLog("{not json")).toThrow(SourcePayloadError);
    expect(() => mapGatewayLog({ id: "x" })).toThrow("startTime");
  });
});
