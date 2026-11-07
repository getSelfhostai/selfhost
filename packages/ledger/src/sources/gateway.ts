import type { LedgerEvent } from "@selfhost/schema";
import {
  agentRef,
  buildEvent,
  costFrom,
  count,
  detectVendor,
  isObject,
  type Json,
  num,
  type SourceContext,
  SourcePayloadError,
  str,
  summarize,
  toIso,
} from "./common.js";

/**
 * One request log from a model gateway, in LiteLLM's StandardLoggingPayload shape (what its
 * logging callbacks and spend logs emit), as an object or a JSON line. A successful request maps
 * to cost.recorded, a failed one to alert.raised. This is how sessions the vendor audit API never
 * sees, such as Bedrock, Vertex or console API key traffic, reach the ledger.
 */
export function mapGatewayLog(line: unknown, ctx: SourceContext = {}): LedgerEvent[] {
  const log = parseLine(line);
  const requestId = str(log.id);
  const startMs = (num(log.startTime) ?? Number.NaN) * 1000;
  const ts = toIso(startMs);
  if (!requestId || !ts) {
    throw new SourcePayloadError("gateway log", [
      { field: requestId ? "startTime" : "id", message: "Expected a request id and a start time" },
    ]);
  }
  const metadata = isObject(log.metadata) ? log.metadata : {};
  const usage = isObject(metadata.usage_object) ? metadata.usage_object : {};
  const spendMetadata = isObject(metadata.spend_logs_metadata) ? metadata.spend_logs_metadata : {};
  const userAgent = userAgentOf(log, metadata);
  const vendor = detectVendor(userAgent);
  const model = str(log.model);
  const person =
    str(metadata.user_api_key_user_email) ??
    ctx.person ??
    str(metadata.user_api_key_user_id) ??
    str(log.end_user);
  const endMs = (num(log.endTime) ?? Number.NaN) * 1000;
  const failed = str(log.status) === "failure";
  const base = {
    source: "gateway" as const,
    ts,
    key: `litellm:${requestId}`,
    actor: person
      ? { kind: "person" as const, id: person }
      : { kind: "system" as const, id: `litellm:${str(metadata.user_api_key_alias) ?? "unknown"}` },
    agent: vendor ? agentRef(vendor, versionOf(userAgent)) : undefined,
    model,
    session_id: str(spendMetadata.session_id) ?? str(metadata.litellm_session_id),
    team: str(metadata.user_api_key_team_alias),
  };
  const data = {
    gateway: "litellm",
    // The virtual key's alias, never the key or its hash: what a spend alarm offers to disable.
    key_alias: str(metadata.user_api_key_alias),
    request_id: requestId,
    provider: str(log.custom_llm_provider),
    call_type: str(log.call_type),
    status: str(log.status),
    duration_ms: Number.isFinite(endMs - startMs) ? Math.round(endMs - startMs) : undefined,
    user_agent: userAgent,
  };

  if (failed) {
    const error = str(log.error_str);
    return [
      buildEvent(ctx, {
        ...base,
        kind: "alert.raised",
        data: {
          ...data,
          alert: "model_request_failed",
          error: error ? summarize(error) : undefined,
        },
      }),
    ];
  }

  // LiteLLM reports OpenAI-style prompt_tokens, which include cache reads and cache writes.
  const cacheRead = count(
    usage.cache_read_input_tokens ??
      (isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details.cached_tokens : 0),
  );
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const promptTokens = count(log.prompt_tokens ?? usage.prompt_tokens);
  const tokens = {
    input_tokens: Math.max(0, promptTokens - cacheRead - cacheWrite),
    output_tokens: count(log.completion_tokens ?? usage.completion_tokens),
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  };
  const { cost, unpriced } = costFrom(ctx, model, tokens, num(log.response_cost));
  return [
    buildEvent(ctx, {
      ...base,
      kind: "cost.recorded",
      cost,
      data: {
        ...data,
        // LiteLLM's request log does not say which part of the agent sent the request.
        request_type: "unknown",
        cache_hit: log.cache_hit === true || undefined,
        unpriced: unpriced || undefined,
      },
    }),
  ];
}

function parseLine(line: unknown): Json {
  let value = line;
  if (typeof line === "string") {
    try {
      value = JSON.parse(line);
    } catch {
      throw new SourcePayloadError("gateway log", [{ field: "(root)", message: "Expected JSON" }]);
    }
  }
  if (!isObject(value)) {
    throw new SourcePayloadError("gateway log", [
      { field: "(root)", message: "Expected an object" },
    ]);
  }
  return value;
}

/** LiteLLM tags each request with "User-Agent: <value>" when user agent tagging is on. */
function userAgentOf(log: Json, metadata: Json): string | undefined {
  const tags = Array.isArray(log.request_tags) ? log.request_tags : [];
  const tagged = tags
    .filter((tag): tag is string => typeof tag === "string" && tag.startsWith("User-Agent: "))
    .map((tag) => tag.slice("User-Agent: ".length))
    .sort((a, b) => b.length - a.length)[0];
  const headers = isObject(metadata.headers) ? metadata.headers : {};
  return tagged ?? str(metadata.user_agent) ?? str(headers["user-agent"]);
}

function versionOf(userAgent: string | undefined): string | undefined {
  return userAgent?.match(/\/(\d+\.\d+[\w.+-]*)/)?.[1];
}
