import type { Actor, EventKind, LedgerEvent, Verdict } from "@selfhost/schema";
import {
  agentRef,
  buildEvent,
  costFrom,
  count,
  type EventParts,
  isObject,
  type Json,
  num,
  type SourceContext,
  SourcePayloadError,
  str,
} from "./common.js";

/**
 * Activity records from a vendor audit or compliance API, in the shape of the Anthropic
 * Compliance API activity feed: a page { data: [...] }, an array, or one record. Only Claude Code
 * activity maps to events; chat, admin and other product activity is skipped.
 *
 * The compliance feed only covers first-party Claude accounts. Bedrock, Vertex, console API key
 * and cloud sessions are missing from it and reach the ledger from hooks or the gateway instead.
 */
export function mapVendorAudit(input: unknown, ctx: SourceContext = {}): LedgerEvent[] {
  const records = isObject(input) && Array.isArray(input.data) ? input.data : input;
  const list = Array.isArray(records) ? records : [records];
  return list.flatMap((record, index) => {
    if (!isObject(record) || !str(record.id) || !str(record.type) || !str(record.created_at)) {
      throw new SourcePayloadError("vendor audit", [
        { field: `data[${index}]`, message: "Expected an activity with id, type and created_at" },
      ]);
    }
    const event = mapActivity(record, ctx);
    return event ? [event] : [];
  });
}

const KINDS: Record<string, EventKind> = {
  claude_code_session_started: "session.started",
  claude_code_session_ended: "session.ended",
  claude_code_prompt_submitted: "prompt.submitted",
  claude_code_tool_permission_decided: "decision.recorded",
  claude_code_usage_reported: "cost.recorded",
};

function actorOf(record: Json, ctx: SourceContext): Actor {
  const actor = isObject(record.actor) ? record.actor : {};
  const email = str(actor.email_address);
  if (email)
    return { kind: "person", id: email, ...(str(actor.name) ? { name: String(actor.name) } : {}) };
  if (actor.type === "api_actor") {
    return { kind: "system", id: `anthropic:api_key:${str(actor.api_key_id) ?? "unknown"}` };
  }
  if (ctx.person) return { kind: "person", id: ctx.person };
  return { kind: "system", id: `anthropic:user:${str(actor.user_id) ?? "unknown"}` };
}

function verdict(decision: string | undefined, by: string | undefined): Verdict | undefined {
  const fromConfig = by === "config";
  if (decision === "accepted") return fromConfig ? "allow" : "approve";
  if (decision === "rejected") return fromConfig ? "block" : "deny";
  return undefined;
}

function mapActivity(record: Json, ctx: SourceContext): LedgerEvent | undefined {
  const type = String(record.type);
  const kind = KINDS[type];
  if (!kind) return undefined;
  const detail = isObject(record.claude_code) ? record.claude_code : {};
  const model = str(detail.model);
  const actor = actorOf(record, ctx);
  const parts: EventParts = {
    source: "vendor_api",
    kind,
    ts: String(record.created_at),
    key: `anthropic:${record.id}`,
    actor,
    agent: agentRef("claude_code", str(detail.client_version) ?? ctx.agentVersion),
    model,
    session_id: str(detail.session_id),
    data: {
      vendor_api: "anthropic_compliance",
      activity_id: record.id,
      activity_type: type,
      organization_id: str(record.organization_id),
    },
  };

  switch (kind) {
    case "session.ended":
      parts.data = { ...parts.data, reason: str(detail.end_reason) };
      break;
    case "prompt.submitted":
      parts.data = { ...parts.data, prompt_chars: num(detail.prompt_length) };
      break;
    case "decision.recorded": {
      const by = str(detail.decision_source);
      const value = verdict(str(detail.decision), by);
      if (!value) return undefined;
      parts.tool = { name: str(detail.tool_name) ?? "unknown" };
      parts.decision = {
        verdict: value,
        ...(by === "config" ? { by: "config" } : actor.kind === "person" ? { by: actor.id } : {}),
      };
      break;
    }
    case "cost.recorded": {
      const usage = isObject(detail.usage) ? detail.usage : {};
      const tokens = {
        input_tokens: count(usage.input_tokens),
        output_tokens: count(usage.output_tokens),
        cache_read_tokens: count(usage.cache_read_input_tokens),
        cache_write_tokens: count(usage.cache_creation_input_tokens),
      };
      const { cost, unpriced } = costFrom(ctx, model, tokens, num(detail.cost_usd));
      parts.cost = cost;
      parts.data = { ...parts.data, unpriced: unpriced || undefined };
      break;
    }
  }
  return buildEvent(ctx, parts);
}
