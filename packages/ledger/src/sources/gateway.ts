import { AGENT_VENDORS, type AgentVendor, type LedgerEvent } from "@selfhost/schema";
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
  const keyMeta = isObject(metadata.user_api_key_metadata) ? metadata.user_api_key_metadata : {};
  const vendor = detectVendor(userAgent) ?? keyAgent(keyMeta);
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

/**
 * The agent the virtual key was set up for (selfhost_agent, which selfhost gateway connect has
 * recorded while one agent alone uses the key): for requests whose user-agent names none.
 */
function keyAgent(metadata: Json): AgentVendor | undefined {
  const agent = str(metadata.selfhost_agent);
  return AGENT_VENDORS.find((vendor) => vendor === agent);
}

function versionOf(userAgent: string | undefined): string | undefined {
  return userAgent?.match(/\/(\d+\.\d+[\w.+-]*)/)?.[1];
}

/** Bifrost error types that mean the gateway itself refused the request under a limit. */
const BIFROST_LIMIT_ALERTS: Record<string, string> = {
  budget_exceeded: "gateway_budget_exceeded",
  rate_limited: "gateway_rate_limited",
  token_limited: "gateway_rate_limited",
  request_limited: "gateway_rate_limited",
};

/**
 * One request log from Bifrost's GET /api/logs (a LogEntry). A successful request maps to
 * cost.recorded, a failed one to alert.raised: gateway_budget_exceeded or gateway_rate_limited
 * when Bifrost refused it under a limit, model_request_failed otherwise. A request still in
 * progress maps to nothing; it is read again once it finishes.
 *
 * Who and which team come from the metadata selfhost puts on each virtual key (selfhost_person,
 * selfhost_team, selfhost_run), which Bifrost copies onto every log entry of the key; the agent
 * from the request's user-agent, else from the key's selfhost_agent. Message bodies are never
 * read.
 */
export function mapBifrostLog(entry: unknown, ctx: SourceContext = {}): LedgerEvent[] {
  if (!isObject(entry)) {
    throw new SourcePayloadError("Bifrost log", [
      { field: "(root)", message: "Expected an object" },
    ]);
  }
  const requestId = str(entry.id);
  const ts = toIso(Date.parse(str(entry.timestamp) ?? str(entry.created_at) ?? ""));
  if (!requestId || !ts) {
    throw new SourcePayloadError("Bifrost log", [
      { field: requestId ? "timestamp" : "id", message: "Expected a request id and a timestamp" },
    ]);
  }
  const status = str(entry.status);
  if (status !== "success" && status !== "error") return [];
  const metadata = isObject(entry.metadata) ? entry.metadata : {};
  // Bifrost keeps the user-agent in its own column; older versions only log it as a header.
  const userAgent = str(entry.user_agent) ?? headerOf(metadata, "user-agent");
  const vendor = detectVendor(userAgent) ?? keyAgent(metadata);
  const model = str(entry.model);
  const person = str(metadata.selfhost_person) ?? str(entry.user_email) ?? ctx.person;
  const keyName = str(entry.virtual_key_name);
  const latency = num(entry.latency);
  const base = {
    source: "gateway" as const,
    ts,
    key: `bifrost:${requestId}`,
    actor: person
      ? { kind: "person" as const, id: person }
      : { kind: "system" as const, id: `bifrost:${keyName ?? "unknown"}` },
    agent: vendor ? agentRef(vendor, versionOf(userAgent)) : undefined,
    model,
    session_id: str(entry.session_id),
    run_id: str(metadata.selfhost_run),
    team: str(metadata.selfhost_team),
  };
  const data = {
    gateway: "bifrost",
    // The virtual key's name, never its value: what a spend alarm offers to turn off.
    key_alias: keyName,
    request_id: requestId,
    provider: str(entry.provider),
    call_type: str(entry.object),
    status,
    duration_ms: latency === undefined ? undefined : Math.round(latency),
    fallback_index: count(entry.fallback_index) || undefined,
    user_agent: userAgent,
  };

  if (status === "error") {
    const details = isObject(entry.error_details) ? entry.error_details : {};
    const inner = isObject(details.error) ? details.error : {};
    const type = str(details.type) ?? str(inner.type);
    const message = str(inner.message);
    return [
      buildEvent(ctx, {
        ...base,
        kind: "alert.raised",
        data: {
          ...data,
          alert: (type && BIFROST_LIMIT_ALERTS[type]) ?? "model_request_failed",
          error_type: type,
          status_code: num(details.status_code),
          error: message ? summarize(message) : undefined,
        },
      }),
    ];
  }

  const usage = isObject(entry.token_usage) ? entry.token_usage : {};
  const details = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cacheRead = count(details.cached_read_tokens);
  const cacheWrite = count(details.cached_write_tokens);
  const tokens = {
    input_tokens: Math.max(0, count(usage.prompt_tokens) - cacheRead - cacheWrite),
    output_tokens: count(usage.completion_tokens),
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  };
  const usageCost = isObject(usage.cost) ? num(usage.cost.total_cost) : undefined;
  const { cost, unpriced } = costFrom(ctx, model, tokens, num(entry.cost) ?? usageCost);
  return [
    buildEvent(ctx, {
      ...base,
      kind: "cost.recorded",
      cost,
      data: { ...data, request_type: "unknown", unpriced: unpriced || undefined },
    }),
  ];
}

/** A request header Bifrost logged into metadata (client.logging_headers), by any case. */
function headerOf(metadata: Json, name: string): string | undefined {
  const key = Object.keys(metadata).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : str(metadata[key]);
}
