// Ported from ccusage v20.0.48 (https://github.com/ccusage/ccusage, MIT, Copyright (c) 2025
// ryoppippi, see ./LICENSE). Sources: rust/adapters/codex/src/parser.rs
// (visit_codex_session_entry, codex_token_count_usage, resolve_codex_usage_model) and types.rs
// (CodexRawUsage). Subagent replay detection and config.toml service tiers are not ported.
import type { CodexServiceTier } from "./pricing.js";

export interface CodexRawUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexUsageEvent {
  timestamp: string;
  model: string;
  isFallbackModel: boolean;
  serviceTier?: CodexServiceTier;
  /** Set for automatic compaction requests. */
  responseId?: string;
  usage: CodexRawUsage;
}

interface PendingCompaction {
  event: CodexUsageEvent;
  threadTokenUsage?: CodexRawUsage;
}

export interface CodexUsageState {
  previousTotals?: CodexRawUsage;
  currentModel?: string;
  currentModelIsFallback: boolean;
  serviceTier?: CodexServiceTier;
  compactedResponseIds: Set<string>;
  emittedResponseIds: Set<string>;
  pendingCompactions: Map<string, PendingCompaction>;
  latestUsageResponseId?: string;
}

export function newCodexUsageState(): CodexUsageState {
  return {
    currentModelIsFallback: false,
    compactedResponseIds: new Set(),
    emittedResponseIds: new Set(),
    pendingCompactions: new Map(),
  };
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lossyCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function normalize(usage: CodexRawUsage): CodexRawUsage {
  const cachedInputTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
  return {
    ...usage,
    cachedInputTokens,
    cacheCreationTokens: Math.min(
      usage.cacheCreationTokens,
      Math.max(0, usage.inputTokens - cachedInputTokens),
    ),
  };
}

export function codexRawUsage(value: unknown): CodexRawUsage | undefined {
  if (!isObject(value)) return undefined;
  const first = (...keys: string[]) => {
    for (const key of keys) {
      const found = lossyCount(value[key]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const input = first("input_tokens", "prompt_tokens", "input") ?? 0;
  const output = first("output_tokens", "completion_tokens", "output") ?? 0;
  const cached = Math.min(
    first("cached_input_tokens", "cache_read_input_tokens", "cached_tokens") ?? 0,
    input,
  );
  const creation = Math.min(
    first("cache_write_input_tokens", "cache_creation_input_tokens") ?? 0,
    Math.max(0, input - cached),
  );
  const total = first("total_tokens");
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    cacheCreationTokens: creation,
    outputTokens: output,
    reasoningOutputTokens: first("reasoning_output_tokens", "reasoning_tokens") ?? 0,
    // Reasoning is a subset of output; a recorded zero total is treated as missing.
    totalTokens: total !== undefined && total > 0 ? total : input + output,
  };
}

function sameUsage(a: CodexRawUsage | undefined, b: CodexRawUsage | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.inputTokens === b.inputTokens &&
    a.cachedInputTokens === b.cachedInputTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens &&
    a.outputTokens === b.outputTokens &&
    a.reasoningOutputTokens === b.reasoningOutputTokens &&
    a.totalTokens === b.totalTokens
  );
}

function subtract(current: CodexRawUsage, previous: CodexRawUsage | undefined): CodexRawUsage {
  const minus = (key: keyof CodexRawUsage) => Math.max(0, current[key] - (previous?.[key] ?? 0));
  return normalize({
    inputTokens: minus("inputTokens"),
    cachedInputTokens: minus("cachedInputTokens"),
    cacheCreationTokens: minus("cacheCreationTokens"),
    outputTokens: minus("outputTokens"),
    reasoningOutputTokens: minus("reasoningOutputTokens"),
    totalTokens: minus("totalTokens"),
  });
}

function hasUsage(usage: CodexRawUsage): boolean {
  return (
    usage.inputTokens !== 0 ||
    usage.cachedInputTokens !== 0 ||
    usage.cacheCreationTokens !== 0 ||
    usage.outputTokens !== 0 ||
    usage.reasoningOutputTokens !== 0
  );
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function codexModelFrom(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  return (
    nonEmpty(value.model) ??
    nonEmpty(value.model_name) ??
    (isObject(value.metadata) ? nonEmpty(value.metadata.model) : undefined)
  );
}

export function codexServiceTier(value: string): CodexServiceTier | undefined {
  switch (value) {
    case "default":
    case "standard":
      return "standard";
    case "fast":
    case "priority":
      return "fast";
    case "flex":
      return "flex";
    case "ultrafast":
      return "ultrafast";
    default:
      return undefined;
  }
}

// codex-auto-review-fallbacks.json: the effective model is not logged for this alias.
const AUTO_REVIEW_FALLBACKS: [releasedOn: string, model: string][] = [
  ["2026-07-30", "gpt-5.6-luna"],
  ["2026-03-05", "gpt-5.4"],
  ["2026-02-05", "gpt-5.3-codex"],
  ["2025-12-11", "gpt-5.2-codex"],
  ["2025-11-13", "gpt-5.1-codex"],
  ["2025-09-15", "gpt-5-codex"],
  ["2025-08-07", "gpt-5"],
];

function logModelFallback(model: string, timestamp: string): string | undefined {
  if (model !== "codex-auto-review") return undefined;
  const date = timestamp.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "gpt-5";
  return AUTO_REVIEW_FALLBACKS.find(([releasedOn]) => date >= releasedOn)?.[1] ?? "gpt-5";
}

/** Early sessions without model metadata fall back to gpt-5 and are marked as such. */
function resolveModel(
  parsed: string | undefined,
  timestamp: string,
  state: { currentModel?: string; currentModelIsFallback: boolean },
): { model: string; isFallbackModel: boolean } {
  if (parsed !== undefined) {
    state.currentModel = parsed;
    state.currentModelIsFallback = false;
  }
  let isFallbackModel = false;
  let model = parsed ?? state.currentModel;
  if (model === undefined) {
    isFallbackModel = true;
    state.currentModelIsFallback = true;
    state.currentModel = "gpt-5";
    model = "gpt-5";
  }
  if (state.currentModelIsFallback) isFallbackModel = true;
  const fallback = logModelFallback(model, timestamp);
  if (fallback !== undefined) return { model: fallback, isFallbackModel: true };
  return { model, isFallbackModel };
}

function lineTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  return undefined;
}

/** Usage records on one rollout line, updating the running per-file state. */
export function codexUsageEvents(line: Json, state: CodexUsageState): CodexUsageEvent[] {
  const payload = isObject(line.payload) ? line.payload : undefined;
  switch (line.type) {
    case "compacted": {
      const responseId = nonEmpty(
        typeof payload?.compaction_response_id === "string"
          ? payload.compaction_response_id.trim()
          : undefined,
      );
      if (responseId === undefined) return [];
      state.compactedResponseIds.add(responseId);
      const pending = state.pendingCompactions.get(responseId);
      state.pendingCompactions.delete(responseId);
      if (pending && !state.emittedResponseIds.has(responseId)) {
        state.emittedResponseIds.add(responseId);
        return [pending.event];
      }
      return [];
    }
    case "token_usage_record": {
      const responseId = nonEmpty(
        typeof payload?.response_id === "string" ? payload.response_id.trim() : undefined,
      );
      const timestamp = lineTimestamp(line.timestamp);
      if (responseId === undefined || state.emittedResponseIds.has(responseId) || !timestamp) {
        return [];
      }
      const raw = codexRawUsage(payload?.usage);
      if (!raw || (!hasUsage(raw) && raw.totalTokens === 0)) return [];
      const parsed = codexModelFrom(payload);
      // A request record does not change the surrounding turn's model.
      const scratch = {
        currentModel: state.currentModel,
        currentModelIsFallback: state.currentModelIsFallback,
      };
      const { model, isFallbackModel } = resolveModel(parsed, timestamp, scratch);
      const event: CodexUsageEvent = {
        timestamp,
        model,
        isFallbackModel: isFallbackModel || parsed === undefined,
        serviceTier: state.serviceTier,
        responseId,
        usage: raw,
      };
      state.latestUsageResponseId = responseId;
      if (state.compactedResponseIds.has(responseId)) {
        state.emittedResponseIds.add(responseId);
        return [event];
      }
      if (!state.pendingCompactions.has(responseId)) {
        state.pendingCompactions.set(responseId, {
          event,
          threadTokenUsage: codexRawUsage(payload?.thread_token_usage),
        });
      }
      return [];
    }
    case "turn_context": {
      const model = codexModelFrom(payload);
      if (model !== undefined) {
        state.currentModel = model;
        state.currentModelIsFallback = false;
      }
      return [];
    }
    case "event_msg":
      break;
    default:
      return [];
  }
  const timestamp = lineTimestamp(line.timestamp);
  if (!timestamp || !payload) return [];
  if (payload.type === "thread_settings_applied") {
    const settings = isObject(payload.thread_settings) ? payload.thread_settings : undefined;
    // A missing service_tier keeps the previous tier; an unknown one clears it.
    if (typeof settings?.service_tier === "string") {
      state.serviceTier = codexServiceTier(settings.service_tier);
    }
    return [];
  }
  if (payload.type !== "token_count") return [];
  const info = isObject(payload.info) ? payload.info : undefined;
  const total = codexRawUsage(info?.total_token_usage);
  const cumulativeAdvanced = total === undefined || !sameUsage(state.previousTotals, total);
  const last = cumulativeAdvanced ? codexRawUsage(info?.last_token_usage) : undefined;
  const delta = last ? normalize(last) : total ? subtract(total, state.previousTotals) : undefined;
  if (total) state.previousTotals = total;
  if (!delta || !hasUsage(delta)) return [];

  // A local compaction's own advancing token_count already covers its request record.
  const latest = state.latestUsageResponseId;
  const pending = latest === undefined ? undefined : state.pendingCompactions.get(latest);
  if (
    cumulativeAdvanced &&
    latest !== undefined &&
    pending &&
    (sameUsage(pending.event.usage, delta) ||
      (total !== undefined && sameUsage(pending.threadTokenUsage, normalize(total))))
  ) {
    state.pendingCompactions.delete(latest);
    state.emittedResponseIds.add(latest);
  }

  const parsed = codexModelFrom(payload) ?? codexModelFrom(info);
  const { model, isFallbackModel } = resolveModel(parsed, timestamp, state);
  return [{ timestamp, model, isFallbackModel, serviceTier: state.serviceTier, usage: delta }];
}
