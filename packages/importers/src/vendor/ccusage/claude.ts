// Ported from ccusage v20.0.48 (https://github.com/ccusage/ccusage, MIT, Copyright (c) 2025
// ryoppippi, see ./LICENSE). Sources: rust/adapters/claude/src/lib.rs (read_usage_file,
// is_valid_usage_entry, deserialize_usage_line, advisor_usages_from_line, usage dedupe keys) and
// rust/crates/ccusage-core/src/types.rs (UsageEntry, TokenUsageRaw).
import type { ClaudeTokenUsage } from "./pricing.js";

export interface ClaudeUsageEntry {
  timestamp: string;
  sessionId?: string;
  version?: string;
  requestId?: string;
  messageId?: string;
  model?: string;
  costUsd?: number;
  isSidechain: boolean;
  usage: ClaudeTokenUsage;
}

type Json = Record<string, unknown>;

const NON_NULLABLE_FIELDS = new Set([
  "id",
  "cwd",
  "model",
  "speed",
  "costUSD",
  "version",
  "sessionId",
  "requestId",
  "isApiErrorMessage",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
]);

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lines with `null` in a field ccusage's schema does not allow are skipped. */
function hasUnsupportedNull(value: unknown, iterations: unknown[], allowModel = false): boolean {
  if (Array.isArray(value)) {
    const isIterations = iterations.includes(value);
    return value.some((item) => hasUnsupportedNull(item, iterations, isIterations));
  }
  if (!isObject(value)) return false;
  return Object.entries(value).some(([field, child]) => {
    if (child === null && NON_NULLABLE_FIELDS.has(field)) return !(allowModel && field === "model");
    return hasUnsupportedNull(child, iterations);
  });
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined | false {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : false;
}

function tokenUsage(raw: unknown): ClaudeTokenUsage | undefined {
  if (!isObject(raw)) return undefined;
  const inputTokens = count(raw.input_tokens);
  const outputTokens = count(raw.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const breakdown = raw.cache_creation;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: count(raw.cache_read_input_tokens) ?? 0,
    cacheCreationTokens: count(raw.cache_creation_input_tokens) ?? 0,
    cacheCreation: isObject(breakdown)
      ? {
          ephemeral5m: count(breakdown.ephemeral_5m_input_tokens) ?? 0,
          ephemeral1h: count(breakdown.ephemeral_1h_input_tokens) ?? 0,
        }
      : undefined,
    fast: raw.speed === "fast",
  };
}

/** `1.2.3...` with digits in each of the first three parts. */
export function isSemverPrefix(value: string): boolean {
  return /^\d+\.\d+\.\d/.test(value);
}

/** The usage record on one transcript line, or undefined when ccusage would skip the line. */
export function claudeUsageEntry(line: Json): ClaudeUsageEntry | undefined {
  const message = line.message;
  if (!isObject(message) || !isObject(message.usage)) return undefined;
  if (typeof line.timestamp !== "string") return undefined;
  const iterations = Array.isArray(message.usage.iterations) ? [message.usage.iterations] : [];
  if (hasUnsupportedNull(line, iterations)) return undefined;
  const usage = tokenUsage(message.usage);
  const sessionId = optionalString(line.sessionId);
  const version = optionalString(line.version);
  const requestId = optionalString(line.requestId);
  const messageId = optionalString(message.id);
  const model = optionalString(message.model);
  if (
    !usage ||
    sessionId === false ||
    version === false ||
    requestId === false ||
    messageId === false ||
    model === false
  ) {
    return undefined;
  }
  // is_valid_usage_entry
  if (version !== undefined && !isSemverPrefix(version)) return undefined;
  if (sessionId === "" || requestId === "" || messageId === "" || model === "") return undefined;
  return {
    timestamp: line.timestamp,
    sessionId,
    version,
    requestId,
    messageId,
    model,
    costUsd: typeof line.costUSD === "number" ? line.costUSD : undefined,
    isSidechain: line.isSidechain === true,
    usage,
  };
}

export interface ClaudeAdvisorUsage {
  model: string;
  usage: ClaudeTokenUsage;
}

/** Advisor iterations are priced separately under their own model. */
export function claudeAdvisorUsages(line: Json): ClaudeAdvisorUsage[] {
  const message = line.message;
  if (!isObject(message) || !isObject(message.usage)) return [];
  const iterations = message.usage.iterations;
  if (!Array.isArray(iterations)) return [];
  const out: ClaudeAdvisorUsage[] = [];
  for (const iteration of iterations) {
    if (!isObject(iteration) || iteration.type !== "advisor_message") continue;
    if (typeof iteration.model !== "string" || iteration.model === "") continue;
    const usage = tokenUsage(iteration);
    if (usage) out.push({ model: iteration.model, usage });
  }
  return out;
}

export function claudeCacheCreationTokens(usage: ClaudeTokenUsage): number {
  return usage.cacheCreation
    ? usage.cacheCreation.ephemeral5m + usage.cacheCreation.ephemeral1h
    : usage.cacheCreationTokens;
}

export function claudeUsageTotal(usage: ClaudeTokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    claudeCacheCreationTokens(usage) +
    usage.cacheReadTokens
  );
}

/** Real Anthropic message ids are unique per response, unlike gateway placeholders. */
export function isAnthropicMessageId(messageId: string): boolean {
  return messageId.startsWith("msg_") || messageId.startsWith("resp_");
}

/**
 * The usage dedupe key (usage_dedupe_hash). Matching message and request ids name one response
 * across sessions, because Claude Code can copy a response into several transcripts. Without a
 * request id the key is scoped to the session, and to the timestamp unless the message id is a
 * real Anthropic id, since Claude Code writes one line per content block of a response.
 */
export function claudeUsageDedupeKey(
  messageId: string,
  requestId: string | undefined,
  sessionId: string,
  timestamp: string,
): { scope: string; identity: string } {
  if (requestId !== undefined) return { scope: "", identity: `${messageId}:${requestId}` };
  return {
    scope: sessionId,
    identity: isAnthropicMessageId(messageId) ? messageId : `${messageId}@${timestamp}`,
  };
}
