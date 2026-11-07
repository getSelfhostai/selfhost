import {
  type AgentVendor,
  type EventKind,
  type LedgerEvent,
  validateClaudeCodeHook,
  validateCodexHook,
  validateCodexNotify,
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
  toolDetails,
} from "./common.js";

/**
 * Hook payloads from Claude Code and Codex. Hooks carry no timestamp and no user, so ctx.ts
 * (default now) is the event time and ctx.person the actor. Hook events with no ledger kind, such
 * as Stop or PreCompact, map to no events.
 */

type Payload = Json & { hook_event_name: string; session_id: string; cwd: string };

function hookContext(vendor: AgentVendor, payload: Payload, ctx: SourceContext) {
  const ts = ctx.ts ?? new Date().toISOString();
  const sessionId = payload.session_id;
  const key = digest(payload);
  const common = {
    source: "hook" as const,
    ts,
    actor: personOrAgent(ctx, vendor, sessionId),
    agent: agentRef(vendor, ctx.agentVersion, str(payload.agent_type)),
    model: str(payload.model),
    session_id: sessionId,
  };
  return (kind: EventKind, parts: Partial<EventParts> = {}): LedgerEvent =>
    buildEvent(ctx, {
      ...common,
      kind,
      key,
      ...parts,
      data: { hook_event: payload.hook_event_name, ...parts.data },
    });
}

function prompt(payload: Payload, ctx: SourceContext, extra: Json) {
  const fields = promptFields(ctx, str(payload.prompt) ?? "");
  return { data: { ...extra, ...fields.data }, redacted: fields.redacted };
}

/** Maps one Claude Code hook payload (stdin of a command hook or body of an HTTP hook). */
export function mapClaudeCodeHook(payload: unknown, ctx: SourceContext = {}): LedgerEvent[] {
  const result = validateClaudeCodeHook(payload);
  if (!result.ok) throw new SourcePayloadError("Claude Code hook", result.errors);
  const p = result.value as Payload;
  const event = hookContext("claude_code", p, ctx);
  const tool = () => toolDetails(String(p.tool_name), p.tool_input, p.cwd);
  switch (p.hook_event_name) {
    case "SessionStart":
      return [event("session.started", { data: { session_source: str(p.source) } })];
    case "SessionEnd":
      return [event("session.ended", { data: { reason: str(p.reason) } })];
    case "UserPromptSubmit":
      return [event("prompt.submitted", prompt(p, ctx, { prompt_id: str(p.prompt_id) }))];
    case "PreToolUse":
      return [
        event("tool.called", {
          ...tool(),
          data: { tool_use_id: str(p.tool_use_id), permission_mode: str(p.permission_mode) },
        }),
      ];
    case "PostToolUse":
      return [
        event("tool.result", {
          ...tool(),
          data: { tool_use_id: str(p.tool_use_id), duration_ms: num(p.duration_ms) },
        }),
      ];
    case "Notification":
      if (p.notification_type !== "permission_prompt") return [];
      return [
        event("approval.requested", {
          data: { notification_type: "permission_prompt", message: str(p.message) },
        }),
      ];
    default:
      return [];
  }
}

/** Maps one Codex hook payload (hooks.json or [hooks] in config.toml). */
export function mapCodexHook(payload: unknown, ctx: SourceContext = {}): LedgerEvent[] {
  const result = validateCodexHook(payload);
  if (!result.ok) throw new SourcePayloadError("Codex hook", result.errors);
  const p = result.value as Payload;
  const event = hookContext("codex", p, ctx);
  const turn = { turn_id: str(p.turn_id) };
  const tool = () => toolDetails(String(p.tool_name), p.tool_input, p.cwd);
  switch (p.hook_event_name) {
    case "SessionStart":
      return [event("session.started", { data: { session_source: str(p.source) } })];
    case "SessionEnd":
      return [event("session.ended", { data: { reason: str(p.reason) } })];
    case "UserPromptSubmit":
      return [event("prompt.submitted", prompt(p, ctx, turn))];
    case "PreToolUse":
      return [
        event("tool.called", { ...tool(), data: { ...turn, tool_use_id: str(p.tool_use_id) } }),
      ];
    case "PermissionRequest":
      return [event("approval.requested", { ...tool(), data: turn })];
    case "PostToolUse":
      return [
        event("tool.result", { ...tool(), data: { ...turn, tool_use_id: str(p.tool_use_id) } }),
      ];
    case "PostModelRequest": {
      if (!isObject(p.token_usage)) return [];
      const usage = p.token_usage;
      // OpenAI counts cached tokens inside input_tokens and reasoning inside output_tokens.
      const cached = count(usage.cached_input_tokens);
      const tokens = {
        input_tokens: Math.max(0, count(usage.input_tokens) - cached),
        output_tokens: count(usage.output_tokens),
        cache_read_tokens: cached,
        cache_write_tokens: count(usage.cache_write_input_tokens),
      };
      const { cost, unpriced } = costFrom(ctx, str(p.model), tokens);
      return [
        event("cost.recorded", {
          cost,
          data: { ...turn, status: str(p.status), unpriced: unpriced || undefined },
        }),
      ];
    }
    default:
      return [];
  }
}

/**
 * Maps the JSON Codex passes to its notify program after each turn. It is the only signal from
 * Codex builds without hooks, recorded as the turn's prompt.
 */
export function mapCodexNotify(payload: unknown, ctx: SourceContext = {}): LedgerEvent[] {
  const result = validateCodexNotify(payload);
  if (!result.ok) throw new SourcePayloadError("Codex notify", result.errors);
  const p = result.value as Json;
  if (p.type !== "agent-turn-complete") return [];
  const sessionId = str(p["thread-id"]);
  const messages = Array.isArray(p["input-messages"]) ? p["input-messages"] : [];
  const fields = promptFields(ctx, messages.filter((m) => typeof m === "string").join("\n"));
  return [
    buildEvent(ctx, {
      source: "hook",
      kind: "prompt.submitted",
      ts: ctx.ts ?? new Date().toISOString(),
      key: digest(p),
      actor: personOrAgent(ctx, "codex", sessionId),
      agent: agentRef("codex", ctx.agentVersion),
      session_id: sessionId,
      data: { hook_event: "notify", turn_id: str(p["turn-id"]), ...fields.data },
      redacted: fields.redacted,
    }),
  ];
}
