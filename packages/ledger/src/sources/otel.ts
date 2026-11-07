import type { AgentVendor, EventKind, LedgerEvent, Verdict } from "@selfhost/schema";
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
 * exporter writes it), from Claude Code's events (claude_code.user_prompt, tool_result,
 * tool_decision, api_request, api_error). Codex OTel events with the same names map the same
 * way. Metrics are aggregates, not events, so they are not read.
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
  const full = str(body) ?? str(attrs["event.name"]);
  if (!full) return undefined;
  for (const [prefix, vendor] of Object.entries(PREFIXES)) {
    if (full.startsWith(prefix)) return { vendor, name: full.slice(prefix.length) };
  }
  return undefined;
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
  if (!isObject(request) || !Array.isArray(request.resourceLogs)) {
    throw new SourcePayloadError("OTLP logs", [
      { field: "resourceLogs", message: "Expected an ExportLogsServiceRequest with resourceLogs" },
    ]);
  }
  const events: LedgerEvent[] = [];
  for (const resourceLogs of request.resourceLogs) {
    if (!isObject(resourceLogs)) continue;
    const resource = attributes(
      isObject(resourceLogs.resource) ? resourceLogs.resource.attributes : [],
    );
    const scopes = Array.isArray(resourceLogs.scopeLogs) ? resourceLogs.scopeLogs : [];
    for (const scope of scopes) {
      const records = isObject(scope) && Array.isArray(scope.logRecords) ? scope.logRecords : [];
      for (const record of records) {
        if (!isObject(record)) continue;
        const event = mapRecord(record, { ...resource, ...attributes(record.attributes) }, ctx);
        if (event) events.push(event);
      }
    }
  }
  return events;
}

function mapRecord(record: Json, attrs: Attributes, ctx: SourceContext): LedgerEvent | undefined {
  const named = eventName(record, attrs);
  if (!named) return undefined;
  const { vendor, name } = named;
  const ts =
    str(attrs["event.timestamp"]) ??
    nanosToIso(record.timeUnixNano) ??
    nanosToIso(record.observedTimeUnixNano) ??
    ctx.ts ??
    new Date().toISOString();
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
      const tokens = {
        input_tokens: count(attrs.input_tokens),
        output_tokens: count(attrs.output_tokens),
        cache_read_tokens: count(attrs.cache_read_tokens),
        cache_write_tokens: count(attrs.cache_creation_tokens),
      };
      const { cost, unpriced } = costFrom(ctx, model, tokens, num(attrs.cost_usd));
      return event("cost.recorded", {
        cost,
        data: { duration_ms: num(attrs.duration_ms), unpriced: unpriced || undefined },
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
