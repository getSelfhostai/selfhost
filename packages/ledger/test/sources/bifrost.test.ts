import { validateEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { SourcePayloadError } from "../../src/sources/common.js";
import { mapBifrostLog } from "../../src/sources/gateway.js";
import { readJson } from "../helpers.js";

const page = readJson("sources", "gateway", "bifrost-logs.json") as { logs: unknown[] };
const [claude, codex, budget, throttled, processing] = page.logs.map((log) => mapBifrostLog(log));

describe("Bifrost gateway request logs", () => {
  it("maps each finished request to one valid event labelled gateway", () => {
    for (const events of [claude, codex, budget, throttled]) {
      expect(events).toHaveLength(1);
      const result = validateEvent(events?.[0]);
      expect(result.ok ? [] : result.errors).toEqual([]);
      expect(events?.[0]?.source).toBe("gateway");
    }
  });

  it("skips a request still in progress", () => {
    expect(processing).toEqual([]);
  });

  it("attributes a request to the person, team and agent of its virtual key", () => {
    expect(claude?.[0]).toMatchObject({
      kind: "cost.recorded",
      ts: "2026-11-05T10:15:02.412Z",
      actor: { kind: "person", id: "ada@example.com" },
      agent: { vendor: "claude_code", version: "2.1.312" },
      model: "claude-opus-5-5",
      team: "platform",
      session_id: "7c1e9a52-4b3d-4f6e-9a21-0d8c7b6e5f41",
      cost: {
        input_tokens: 24310 - 20480 - 2600,
        output_tokens: 512,
        cache_read_tokens: 20480,
        cache_write_tokens: 2600,
        usd: 0.0583,
        estimated: true,
      },
      data: {
        gateway: "bifrost",
        key_alias: "selfhost:person:platform:ada@example.com",
        provider: "anthropic",
        duration_ms: 4121,
      },
    });
  });

  it("carries the run of a run key and notes a fallback provider", () => {
    expect(codex?.[0]).toMatchObject({
      run_id: "run-4821",
      agent: { vendor: "codex", version: "0.142.5" },
      cost: { input_tokens: 1008, cache_read_tokens: 8192, output_tokens: 301, usd: 0.0121 },
      data: { fallback_index: 1, provider: "openai" },
    });
  });

  it("records a budget refusal as a gateway alert, and other failures as failed requests", () => {
    expect(budget?.[0]).toMatchObject({
      kind: "alert.raised",
      actor: { id: "ada@example.com" },
      data: { alert: "gateway_budget_exceeded", status_code: 402, error_type: "budget_exceeded" },
    });
    expect(budget?.[0]?.cost).toBeUndefined();
    expect(throttled?.[0]).toMatchObject({
      kind: "alert.raised",
      actor: { kind: "system", id: "bifrost:selfhost:team:platform" },
      data: { alert: "model_request_failed", provider: "bedrock" },
    });
  });

  it("gives the same id to the same request read twice", () => {
    expect(mapBifrostLog(page.logs[0])[0]?.id).toBe(claude?.[0]?.id);
  });

  it("reads the agent from the user-agent column, else from the key's selfhost_agent", () => {
    const entry = page.logs[0] as Record<string, unknown>;
    const metadata = { ...(entry.metadata as Record<string, unknown>) };
    for (const key of Object.keys(metadata)) {
      if (key.toLowerCase() === "user-agent") delete metadata[key];
    }
    const column = mapBifrostLog({
      ...entry,
      metadata,
      user_agent: "opencode/1.19.5 ai-sdk/provider-utils/4.0.46 runtime/bun/1.4.4",
    });
    expect(column[0]?.agent).toEqual({ vendor: "opencode", version: "1.19.5" });
    // Goose sends no user-agent that names it; its key was set up for Goose alone.
    const keyed = mapBifrostLog({ ...entry, metadata: { ...metadata, selfhost_agent: "goose" } });
    expect(keyed[0]?.agent).toEqual({ vendor: "goose" });
    expect(mapBifrostLog({ ...entry, metadata })[0]?.agent).toBeUndefined();
  });

  it("rejects entries without an id or a timestamp", () => {
    expect(() => mapBifrostLog("x")).toThrow(SourcePayloadError);
    expect(() => mapBifrostLog({ id: "x", status: "success" })).toThrow("timestamp");
  });
});

describe("Bifrost 2.4 request logs", () => {
  const logs = (readJson("sources", "gateway", "bifrost-2.4-logs.json") as { logs: unknown[] })
    .logs;
  const [written, refused, curl, provider] = logs.map((log) => mapBifrostLog(log));

  it("records the cache writes of a write-only request, with no cache reads", () => {
    expect(written?.[0]).toMatchObject({
      kind: "cost.recorded",
      team: "web",
      cost: {
        input_tokens: 10,
        output_tokens: 46,
        cache_read_tokens: 0,
        cache_write_tokens: 30734,
        usd: 0.0386575,
      },
    });
  });

  it("reads a budget refusal with no error details from its content summary", () => {
    for (const events of [refused, curl]) {
      expect(events).toHaveLength(1);
      const result = validateEvent(events?.[0]);
      expect(result.ok ? [] : result.errors).toEqual([]);
    }
    expect(refused?.[0]).toMatchObject({
      kind: "alert.raised",
      actor: { kind: "person", id: "alice@example.com" },
      team: "web",
      session_id: "0c1b4732-5f16-4a3e-8776-96cedd495215",
      data: {
        alert: "gateway_budget_exceeded",
        error_type: "budget_exceeded",
        error: "budget exceeded: 0.0387 >= 0.0100 dollars",
      },
    });
    // Only the phrase is kept, never the rest of the summary.
    expect(curl?.[0]?.data).toMatchObject({
      alert: "gateway_budget_exceeded",
      error: "budget exceeded",
    });
    expect(JSON.stringify(curl)).not.toContain("ping");
  });

  it("takes a 402 from Bifrost as a budget refusal, but not a provider's own 402", () => {
    expect(provider?.[0]?.data).toMatchObject({
      alert: "model_request_failed",
      status_code: 402,
      error: "Your credit balance is too low",
    });
    const gateway = mapBifrostLog({
      ...(logs[3] as Record<string, unknown>),
      content_summary: "",
      error_details: { is_bifrost_error: true, status_code: 402, error: { message: "Over" } },
    });
    expect(gateway[0]?.data).toMatchObject({
      alert: "gateway_budget_exceeded",
      error_type: "budget_exceeded",
      status_code: 402,
    });
  });
});
