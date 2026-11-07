import {
  type AgentVendor,
  claudeCodeRequestType,
  type EventKind,
  type LedgerEvent,
  type RequestType,
  type Verdict,
} from "@selfhost/schema";
import {
  agentRef,
  buildEvent,
  costFrom,
  count,
  digest,
  type EventParts,
  isObject,
  type Json,
  num,
  personOrAgent,
  promptFields,
  type SourceContext,
  SourcePayloadError,
  str,
  summarize,
  toIso,
  toolDetails,
} from "./common.js";

/**
 * OpenTelemetry log records in OTLP JSON (an ExportLogsServiceRequest, as the collector's file
 * exporter writes it, or an array of them, one per line of its output), from Claude Code's events
 * (claude_code.user_prompt, tool_result, tool_decision, api_request, api_error). Codex events with
 * the same names map the same way, except that Codex reports tokens on codex.sse_event
 * (response.completed) rather than on codex.api_request. Metrics are aggregates, not events, so
 * they are not read.
 *
 * Each cost.recorded event gets data.request_type. Claude Code names the subsystem that issued
 * the request in query_source; Codex log events name none, so its requests are unknown unless
 * they are retries.
 */

type Attributes = Record<string, unknown>;

function anyValue(value: unknown): unknown {
  if (!isObject(value)) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("intValue" in value) return num(value.intValue);
  if ("doubleValue" in value) return num(value.doubleValue);
  if (isObject(value.arrayValue)) {
    const values = value.arrayValue.values;
    return Array.isArray(values) ? values.map(anyValue) : [];
  }
  if (isObject(value.kvlistValue)) return attributes(value.kvlistValue.values);
  return undefined;
}

function attributes(list: unknown): Attributes {
  const out: Attributes = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (isObject(item) && typeof item.key === "string") out[item.key] = anyValue(item.value);
  }
  return out;
}

function nanosToIso(value: unknown): string | undefined {
  const text = typeof value === "number" ? String(Math.trunc(value)) : str(value);
  if (!text || !/^\d+$/.test(text) || /^0+$/.test(text)) return undefined;
  return toIso(Number(BigInt(text) / 1_000_000n));
}

const PREFIXES: Record<string, AgentVendor> = { "claude_code.": "claude_code", "codex.": "codex" };

function eventName(
  record: Json,
  attrs: Attributes,
): { vendor: AgentVendor; name: string } | undefined {
  const body = isObject(record.body) ? anyValue(record.body) : undefined;
  for (const full of [str(body), str(attrs["event.name"])]) {
    if (!full) continue;
    for (const [prefix, vendor] of Object.entries(PREFIXES)) {
      if (full.startsWith(prefix)) return { vendor, name: full.slice(prefix.length) };
    }
  }
  return undefined;
}

function recordTime(record: Json, attrs: Attributes, ctx: SourceContext): string {
  return (
    str(attrs["event.timestamp"]) ??
    nanosToIso(record.timeUnixNano) ??
    nanosToIso(record.observedTimeUnixNano) ??
    ctx.ts ??
    new Date().toISOString()
  );
}

interface Entry {
  record: Json;
  attrs: Attributes;
}

/**
 * Requests re-sent after a failure, found in time order. Claude Code logs api_error only once it
 * gives up on a request, then re-issues it under the same prompt and query source. Codex logs
 * codex.api_request per attempt, counting from 0, before the response's token counts.
 */
function findRetries(entries: Entry[], ctx: SourceContext): Set<Json> {
  const retries = new Set<Json>();
  const failed = new Set<string>();
  const timed = entries.map((entry, index) => ({
    ...entry,
    index,
    ts: recordTime(entry.record, entry.attrs, ctx),
  }));
  timed.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.index - b.index));
  for (const { record, attrs } of timed) {
    const named = eventName(record, attrs);
    if (!named) continue;
    const session = str(attrs["session.id"]) ?? str(attrs["conversation.id"]) ?? "";
    if (named.vendor === "claude_code") {
      const key = `${session}\n${str(attrs["prompt.id"]) ?? ""}\n${str(attrs.query_source) ?? ""}`;
      if (named.name === "api_error") failed.add(key);
      if (named.name === "api_request" && failed.delete(key)) retries.add(record);
    } else if (named.name === "api_request") {
      if ((num(attrs.attempt) ?? 0) >= 1) failed.add(session);
      else failed.delete(session);
    } else if (codexUsage(named.name, attrs) && failed.delete(session)) {
      retries.add(record);
    }
  }
  return retries;
}

/** A Codex response.completed event with token counts. */
function codexUsage(name: string, attrs: Attributes): boolean {
  return (
    name === "sse_event" &&
    str(attrs["event.kind"]) === "response.completed" &&
    (num(attrs.input_token_count) !== undefined || num(attrs.output_token_count) !== undefined)
  );
}

function toolParameters(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** accept/reject from a config rule is allow/block; from a person it is approve/deny. */
function verdict(decision: string | undefined, by: string | undefined): Verdict | undefined {
  const fromConfig = by === "config";
  if (decision === "accept") return fromConfig ? "allow" : "approve";
  if (decision === "reject") return fromConfig ? "block" : "deny";
  return undefined;
}

export function mapOtelLogs(request: unknown, ctx: SourceContext = {}): LedgerEvent[] {
  const requests = Array.isArray(request) ? request : [request];
  const entries: Entry[] = [];
  requests.forEach((item, index) => {
    if (!isObject(item) || !Array.isArray(item.resourceLogs)) {
      throw new SourcePayloadError("OTLP logs", [
        {
          field: Array.isArray(request) ? `[${index}].resourceLogs` : "resourceLogs",
          message: "Expected an ExportLogsServiceRequest with resourceLogs",
        },
      ]);
    }
    for (const resourceLogs of item.resourceLogs) {
      if (!isObject(resourceLogs)) continue;
      const resource = attributes(
        isObject(resourceLogs.resource) ? resourceLogs.resource.attributes : [],
      );
      const scopes = Array.isArray(resourceLogs.scopeLogs) ? resourceLogs.scopeLogs : [];
      for (const scope of scopes) {
        const records = isObject(scope) && Array.isArray(scope.logRecords) ? scope.logRecords : [];
        for (const record of records) {
          if (!isObject(record)) continue;
          entries.push({ record, attrs: { ...resource, ...attributes(record.attributes) } });
        }
      }
    }
  });
  const retries = findRetries(entries, ctx);
  const events: LedgerEvent[] = [];
  for (const { record, attrs } of entries) {
    const event = mapRecord(record, attrs, ctx, retries.has(record));
    if (event) events.push(event);
  }
  return events;
}

/** data.request_type and data.request_source for a request. */
function requestFields(
  vendor: AgentVendor,
  attrs: Attributes,
  retry: boolean,
): { request_type: RequestType; request_source?: string } {
  const source = vendor === "claude_code" ? str(attrs.query_source) : undefined;
  if (retry) return { request_type: "retry", request_source: source };
  const subagent = str(attrs["agent.name"]) !== undefined || str(attrs.agent_id) !== undefined;
  const type = claudeCodeRequestType(source, { subagent }) ?? "unknown";
  return { request_type: type, request_source: source };
}

function mapRecord(
  record: Json,
  attrs: Attributes,
  ctx: SourceContext,
  retry: boolean,
): LedgerEvent | undefined {
  const named = eventName(record, attrs);
  if (!named) return undefined;
  const { vendor, name } = named;
  const ts = recordTime(record, attrs, ctx);
  const sessionId = str(attrs["session.id"]) ?? str(attrs["conversation.id"]);
  const person =
    str(attrs["user.email"]) ?? (ctx.person ? undefined : str(attrs["user.account_uuid"]));
  const model = str(attrs.model);
  const version = str(attrs["app.version"]) ?? str(attrs["service.version"]) ?? ctx.agentVersion;
  const actor = personOrAgent(ctx, vendor, sessionId, person);
  const event = (kind: EventKind, parts: Partial<EventParts>) =>
    buildEvent(ctx, {
      source: "otel",
      kind,
      ts,
      key: digest(record),
      actor,
      agent: agentRef(vendor, version),
      model,
      session_id: sessionId,
      ...parts,
      data: { otel_event: `${vendor}.${name}`, prompt_id: str(attrs["prompt.id"]), ...parts.data },
    });

  switch (name) {
    case "user_prompt": {
      const fields = promptFields(ctx, str(attrs.prompt));
      const chars = num(attrs.prompt_length);
      return event("prompt.submitted", {
        data: { prompt_chars: chars, ...fields.data },
        redacted: fields.redacted,
      });
    }
    case "tool_result": {
      const toolName = str(attrs.tool_name) ?? "unknown";
      return event("tool.result", {
        ...toolDetails(toolName, toolParameters(attrs.tool_parameters ?? attrs.arguments)),
        data: {
          success: attrs.success === true || attrs.success === "true",
          duration_ms: num(attrs.duration_ms),
          decision: str(attrs.decision),
          decision_source: str(attrs.source),
          error: str(attrs.error) ? summarize(String(attrs.error)) : undefined,
        },
      });
    }
    case "tool_decision": {
      const by = str(attrs.source);
      const value = verdict(str(attrs.decision), by);
      if (!value) return undefined;
      return event("decision.recorded", {
        tool: { name: str(attrs.tool_name) ?? "unknown" },
        decision: {
          verdict: value,
          ...(by === "config" ? { by: "config" } : actor.kind === "person" ? { by: actor.id } : {}),
        },
        data: { decision_source: by },
      });
    }
    case "api_request": {
      // Codex reports attempts here and tokens on codex.sse_event.
      if (vendor === "codex") return undefined;
      const tokens = {
        input_tokens: count(attrs.input_tokens),
        output_tokens: count(attrs.output_tokens),
        cache_read_tokens: count(attrs.cache_read_tokens),
        cache_write_tokens: count(attrs.cache_creation_tokens),
      };
      const { cost, unpriced } = costFrom(ctx, model, tokens, num(attrs.cost_usd));
      return event("cost.recorded", {
        cost,
        data: {
          ...requestFields(vendor, attrs, retry),
          duration_ms: num(attrs.duration_ms),
          unpriced: unpriced || undefined,
        },
      });
    }
    case "sse_event": {
      if (!codexUsage(name, attrs)) return undefined;
      // OpenAI counts cached input and cache writes inside input tokens.
      const cached = count(attrs.cached_token_count);
      const written = count(attrs.cache_write_token_count);
      const tokens = {
        input_tokens: Math.max(0, count(attrs.input_token_count) - cached - written),
        output_tokens: count(attrs.output_token_count),
        cache_read_tokens: cached,
        cache_write_tokens: written,
      };
      const { cost, unpriced } = costFrom(ctx, model, tokens);
      return event("cost.recorded", {
        cost,
        data: {
          ...requestFields(vendor, attrs, retry),
          reasoning_output_tokens: num(attrs.reasoning_token_count),
          service_tier: str(attrs.service_tier),
          unpriced: unpriced || undefined,
        },
      });
    }
    case "api_error":
      return event("alert.raised", {
        data: {
          alert: "api_error",
          error: str(attrs.error) ? summarize(String(attrs.error)) : undefined,
          status_code: num(attrs.status_code),
          attempt: num(attrs.attempt),
        },
      });
    default:
      return undefined;
  }
}
