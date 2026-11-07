// Ported from ccusage v20.0.48 (https://github.com/ccusage/ccusage, MIT, Copyright (c) 2025
// ryoppippi, see ./LICENSE). Sources: rust/crates/ccusage-core/src/pricing.rs and cost.rs,
// rust/adapters/codex/src/report.rs. Only the offline lookup and per-request cost rules that
// Claude Code and Codex usage need are kept; network refresh and user overrides are dropped.
import { LITELLM, MODELS_DEV } from "./pricing-snapshot.js";

/** Compact LiteLLM rates, USD per token (keys as in ccusage's build.rs). */
export interface LiteLlmRates {
  i: number;
  o: number;
  cc?: number;
  cr?: number;
  ia?: number;
  oa?: number;
  cca?: number;
  cra?: number;
  fast?: number;
  flex?: number;
}

/** models.dev rates, USD per million tokens. */
export interface ModelsDevRates {
  i: number;
  o: number;
  cr?: number;
  cw?: number;
  x?: boolean;
  t?: { size: number; i?: number; o?: number; cr?: number; cw?: number };
}

export interface Pricing {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  cacheReadExplicit: boolean;
  inputAbove?: number;
  outputAbove?: number;
  cacheCreateAbove?: number;
  cacheReadAbove?: number;
  /** Set when a models.dev tier applies: the whole request switches rates above it. */
  longContextThreshold?: number;
  fastMultiplier: number;
  flexMultiplier: number;
}

const DEFAULT_LONG_CONTEXT_THRESHOLD = 200_000;
const CACHE_CREATE_1H_INPUT_MULTIPLIER = 2;

interface SpeedOverrides {
  exact: Record<string, number>;
  normalizedPrefix: Record<string, number>;
}

// ccusage-core/src/fast-multiplier-overrides.json and flex-multiplier-overrides.json.
const FAST_OVERRIDES: SpeedOverrides = {
  exact: {
    "gpt-5.6-sol": 2,
    "gpt-5.6-terra": 2,
    "gpt-5.6-luna": 2,
    "gpt-5.5": 2.5,
    "gpt-5.4": 2,
    "gpt-5.3-codex": 2,
    "gpt-6-astra": 2,
    "gpt-6-sol": 2,
    "gpt-6.1-sol": 2,
    "gpt-6.1-terra": 2,
    "gpt-6-luna": 2,
  },
  normalizedPrefix: { "claude-opus-4-6": 6, "claude-opus-4-7": 6, "claude-opus-4-8": 2 },
};

const FLEX_OVERRIDES: SpeedOverrides = {
  exact: Object.fromEntries(
    [
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.4-pro",
      "gpt-5.2",
      "gpt-5.1",
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-nano",
      "o3",
      "o4-mini",
    ].map((model) => [model, 0.5]),
  ),
  normalizedPrefix: {},
};

type Rates = [input: number, output: number, cacheCreate: number, cacheRead: number];

// Last-resort rates from PricingMap::put_builtin_pricing, used only when the snapshot misses
// the key (grok, kimi and glm entries omitted).
const BUILTIN: [string, Rates][] = [
  ["claude-opus-4-5", [5e-6, 25e-6, 6.25e-6, 0.5e-6]],
  ["claude-opus-4-6", [5e-6, 25e-6, 6.25e-6, 0.5e-6]],
  ["claude-opus-4-7", [5e-6, 25e-6, 6.25e-6, 0.5e-6]],
  ["claude-opus-4-8", [5e-6, 25e-6, 6.25e-6, 0.5e-6]],
  ["claude-haiku-4-5", [1e-6, 5e-6, 1.25e-6, 0.1e-6]],
  ["claude-opus-4", [15e-6, 75e-6, 18.75e-6, 1.5e-6]],
  ["claude-sonnet-4-6", [3e-6, 15e-6, 3.75e-6, 0.3e-6]],
  ["claude-sonnet-4", [3e-6, 15e-6, 3.75e-6, 0.3e-6]],
  ["claude-3-5-haiku", [0.8e-6, 4e-6, 1e-6, 0.08e-6]],
  ["claude-3-5-haiku-20241022", [0.8e-6, 4e-6, 1e-6, 0.08e-6]],
  ["claude-3-opus", [15e-6, 75e-6, 18.75e-6, 1.5e-6]],
  ["claude-3-sonnet", [3e-6, 15e-6, 3.75e-6, 0.3e-6]],
  ["claude-3-haiku", [0.25e-6, 1.25e-6, 0.3e-6, 0.03e-6]],
  ["gpt-5", [1.25e-6, 10e-6, 1.25e-6, 0.125e-6]],
  ["gpt-5.5", [5e-6, 30e-6, 5e-6, 0.5e-6]],
  ["gpt-5.1", [1.25e-6, 10e-6, 1.25e-6, 0.125e-6]],
  ["gpt-5.3-codex", [1.75e-6, 14e-6, 1.75e-6, 0.175e-6]],
  ["gpt-5.4", [2.5e-6, 15e-6, 2.5e-6, 0.25e-6]],
  ["gpt-5.4-mini", [0.75e-6, 4.5e-6, 0.75e-6, 0.075e-6]],
  ["gpt-5.4-nano", [0.2e-6, 1.25e-6, 0.2e-6, 0.02e-6]],
  ["gpt-5.6-sol", [5e-6, 30e-6, 6.25e-6, 0.5e-6]],
  ["gpt-5.6-terra", [2.5e-6, 15e-6, 3.125e-6, 0.25e-6]],
  ["gpt-5.6-luna", [1e-6, 6e-6, 1.25e-6, 0.1e-6]],
];

// Builtins ccusage inserts over the snapshot rather than beside it.
const BUILTIN_REPLACING: [string, Rates][] = [
  ["gpt-5.1-codex", [1.25e-6, 10e-6, 1.25e-6, 0.125e-6]],
  ["gpt-5.2-codex", [1.75e-6, 14e-6, 1.75e-6, 0.175e-6]],
  ["gpt-5.2", [1.75e-6, 14e-6, 1.75e-6, 0.175e-6]],
];

const CLAUDE_SONNET_4_ABOVE_200K: Rates = [6e-6, 22.5e-6, 7.5e-6, 0.6e-6];

function pricingAlias(model: string): string | undefined {
  switch (model) {
    case "gpt-reserve":
      return "gpt-5.6-luna";
    case "gpt-5.6":
      return "gpt-5.6-sol";
    case "gpt-5.3-spark":
      return "gpt-5.3-codex-spark";
    default:
      return undefined;
  }
}

function normalizedKey(value: string): string {
  return value.replace(/[.@]/g, "-");
}

/** Strips a trailing `-YYYY-MM-DD` or `-YYYYMMDD` release date. */
function withoutDateSuffix(model: string): string {
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
}

function matchesModelSuffix(part: string, base: string): boolean {
  const index = part.lastIndexOf(base);
  if (index < 0) return false;
  const suffix = part.slice(index);
  return suffix === base || suffix[base.length] === "-";
}

function multiplierFor(table: SpeedOverrides, model: string): number | undefined {
  const exact = table.exact[model];
  if (exact !== undefined) return exact;
  const alias = pricingAlias(model);
  if (alias !== undefined && table.exact[alias] !== undefined) return table.exact[alias];
  for (const segment of model.split(/[/:]/)) {
    const parts = [segment];
    for (let index = segment.indexOf("."); index >= 0; index = segment.indexOf(".", index + 1)) {
      parts.push(segment.slice(index + 1));
    }
    for (const part of parts) {
      const base = withoutDateSuffix(part);
      const baseAlias = pricingAlias(base);
      const found =
        table.exact[part] ??
        table.exact[base] ??
        (baseAlias === undefined ? undefined : table.exact[baseAlias]);
      if (found !== undefined) return found;
      const normalized = normalizedKey(part);
      for (const [prefix, multiplier] of Object.entries(table.normalizedPrefix)) {
        if (matchesModelSuffix(normalized, prefix)) return multiplier;
      }
    }
  }
  return undefined;
}

function isBoundary(char: string | undefined): boolean {
  return char === undefined || !/[A-Za-z0-9]/.test(char);
}

function suffixStartsWithNumericVersion(key: string, suffix: string): boolean {
  if (!/\d$/.test(key) || (suffix[0] !== "-" && suffix[0] !== ".")) return false;
  const digits = /^\d+/.exec(suffix.slice(1))?.[0] ?? "";
  if (digits.length === 0) return false;
  const after = suffix[1 + digits.length];
  return !(digits.length === 8 && isBoundary(after));
}

/** Whether `key` occurs in `value` on non-alphanumeric boundaries, not inside a version. */
function containsPricingKey(value: string, key: string): boolean {
  for (let index = value.indexOf(key); index >= 0; index = value.indexOf(key, index + 1)) {
    const suffix = value.slice(index + key.length);
    if (!isBoundary(value[index - 1])) continue;
    if (suffix.length === 0) return true;
    if (isBoundary(suffix[0]) && !suffixStartsWithNumericVersion(key, suffix)) return true;
  }
  return false;
}

function pricingKeyMatches(candidate: string, model: string, normalizedModel: string): boolean {
  if (containsPricingKey(model, candidate) || containsPricingKey(candidate, model)) return true;
  const normalizedCandidate = normalizedKey(candidate);
  return (
    containsPricingKey(normalizedModel, normalizedCandidate) ||
    containsPricingKey(normalizedCandidate, normalizedModel)
  );
}

function fuzzyFind(
  entries: Map<string, Pricing>,
  model: string,
  skip: (key: string) => boolean,
): Pricing | undefined {
  const normalizedModel = normalizedKey(model);
  let best: string | undefined;
  for (const candidate of entries.keys()) {
    if (skip(candidate) || !pricingKeyMatches(candidate, model, normalizedModel)) continue;
    if (
      best === undefined ||
      candidate.length > best.length ||
      (candidate.length === best.length && candidate < best)
    ) {
      best = candidate;
    }
  }
  return best === undefined ? undefined : entries.get(best);
}

function withMultipliers(model: string, fast?: number, flex?: number) {
  return {
    fastMultiplier: fast ?? multiplierFor(FAST_OVERRIDES, model) ?? 1,
    flexMultiplier: flex ?? multiplierFor(FLEX_OVERRIDES, model) ?? 1,
  };
}

function fromRates(model: string, [input, output, cacheCreate, cacheRead]: Rates): Pricing {
  return {
    input,
    output,
    cacheCreate,
    cacheRead,
    cacheReadExplicit: true,
    ...withMultipliers(model),
  };
}

function fromModelsDev(model: string, rates: ModelsDevRates): Pricing {
  const input = rates.i / 1_000_000;
  const tier = rates.t;
  const perToken = (value: number | undefined) =>
    value === undefined ? undefined : value / 1_000_000;
  return {
    input,
    output: rates.o / 1_000_000,
    cacheCreate: perToken(rates.cw) ?? input * 1.25,
    cacheRead: perToken(rates.cr) ?? input * 0.1,
    cacheReadExplicit: rates.cr !== undefined,
    inputAbove: perToken(tier?.i),
    outputAbove: perToken(tier?.o),
    cacheCreateAbove: perToken(tier?.cw),
    cacheReadAbove: perToken(tier?.cr),
    longContextThreshold: tier?.size,
    ...withMultipliers(model),
  };
}

function buildPrimary(modelsDev: Map<string, Pricing>): Map<string, Pricing> {
  const entries = new Map<string, Pricing>();
  for (const [model, rates] of Object.entries(LITELLM)) {
    entries.set(model, {
      input: rates.i,
      output: rates.o,
      cacheCreate: rates.cc ?? rates.i * 1.25,
      cacheRead: rates.cr ?? rates.i * 0.1,
      cacheReadExplicit: rates.cr !== undefined,
      inputAbove: rates.ia,
      outputAbove: rates.oa,
      cacheCreateAbove: rates.cca,
      cacheReadAbove: rates.cra,
      ...withMultipliers(model, rates.fast, rates.flex),
    });
  }
  for (const [model, rates] of BUILTIN) {
    if (entries.has(model)) continue;
    const pricing = fromRates(model, rates);
    if (model === "claude-sonnet-4") {
      [pricing.inputAbove, pricing.outputAbove, pricing.cacheCreateAbove, pricing.cacheReadAbove] =
        CLAUDE_SONNET_4_ABOVE_200K;
    }
    entries.set(model, pricing);
  }
  for (const [model, rates] of BUILTIN_REPLACING) entries.set(model, fromRates(model, rates));
  // fill_long_context_rates_from_models_dev: exact ids only, after date and alias resolution.
  for (const [model, pricing] of entries) {
    if (
      pricing.inputAbove !== undefined ||
      pricing.outputAbove !== undefined ||
      pricing.cacheCreateAbove !== undefined ||
      pricing.cacheReadAbove !== undefined
    ) {
      continue;
    }
    const base = withoutDateSuffix(model);
    const source = modelsDev.get(pricingAlias(base) ?? base) ?? modelsDev.get(base);
    if (source?.longContextThreshold === undefined) continue;
    pricing.inputAbove = source.inputAbove;
    pricing.outputAbove = source.outputAbove;
    pricing.cacheCreateAbove = source.cacheCreateAbove;
    pricing.cacheReadAbove = source.cacheReadAbove;
    pricing.longContextThreshold = source.longContextThreshold;
  }
  return entries;
}

class PricingTable {
  private readonly primary: Map<string, Pricing>;
  private readonly modelsDev = new Map<string, Pricing>();
  private readonly exactOnly = new Set<string>();
  /** Exact-only ids by every separator spelling. */
  private readonly exactOnlySpelling = new Map<string, string>();
  private readonly cache = new Map<string, Pricing | undefined>();

  constructor() {
    for (const [model, rates] of Object.entries(MODELS_DEV)) {
      this.modelsDev.set(model, fromModelsDev(model, rates));
      if (rates.x) {
        this.exactOnly.add(model);
        this.exactOnlySpelling.set(normalizedKey(model), model);
      }
    }
    this.primary = buildPrimary(this.modelsDev);
  }

  find(model: string): Pricing | undefined {
    if (this.cache.has(model)) return this.cache.get(model);
    const result = this.lookup(model);
    this.cache.set(model, result);
    return result;
  }

  /** Input-token boundary above which a Codex request is billed at long-context rates. */
  longContextSplitThreshold(model: string): number {
    const base = withoutDateSuffix(model);
    const source = this.modelsDev.get(pricingAlias(base) ?? base) ?? this.modelsDev.get(base);
    return source?.longContextThreshold ?? DEFAULT_LONG_CONTEXT_THRESHOLD;
  }

  private isExactOnly(model: string): boolean {
    return this.exactOnlySpelling.has(normalizedKey(model));
  }

  private requiresExact(model: string): boolean {
    const alias = pricingAlias(model);
    return this.isExactOnly(model) || (alias !== undefined && this.isExactOnly(alias));
  }

  private lookup(model: string): Pricing | undefined {
    const alias = pricingAlias(model);
    const exact =
      this.primary.get(model) ?? (alias === undefined ? undefined : this.primary.get(alias));
    if (exact) return exact;
    const fuzzy = !this.requiresExact(model);
    const fromPrimary = (key: string) =>
      fuzzy && !this.isExactOnly(key) ? fuzzyFind(this.primary, key, () => false) : undefined;
    const fromModelsDev = (key: string) => {
      const direct = this.modelsDev.get(key);
      if (direct) return direct;
      const spelled = this.exactOnlySpelling.get(normalizedKey(key));
      if (spelled !== undefined) return this.modelsDev.get(spelled);
      if (!fuzzy || this.isExactOnly(key)) return undefined;
      return fuzzyFind(this.modelsDev, key, (candidate) => this.exactOnly.has(candidate));
    };
    return (
      (alias === undefined ? undefined : fromPrimary(alias)) ??
      fromPrimary(model) ??
      this.modelsDev.get(model) ??
      (alias === undefined ? undefined : fromModelsDev(alias)) ??
      fromModelsDev(model)
    );
  }
}

let table: PricingTable | undefined;

export function findPricing(model: string): Pricing | undefined {
  table ??= new PricingTable();
  return table.find(model);
}

function tieredCost(tokens: number, base: number, above: number | undefined): number {
  if (tokens === 0) return 0;
  if (above !== undefined && tokens > DEFAULT_LONG_CONTEXT_THRESHOLD) {
    return (
      DEFAULT_LONG_CONTEXT_THRESHOLD * base + (tokens - DEFAULT_LONG_CONTEXT_THRESHOLD) * above
    );
  }
  return tokens * base;
}

export interface ClaudeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** cache_creation_input_tokens, used when there is no 5m and 1h breakdown. */
  cacheCreationTokens: number;
  cacheCreation?: { ephemeral5m: number; ephemeral1h: number };
  fast: boolean;
}

/** cost.rs calculate_cost_from_tokens for one Claude usage record. */
export function claudeCostUsd(model: string, usage: ClaudeTokenUsage): number | undefined {
  const pricing = findPricing(model);
  if (!pricing) return undefined;
  const create5m = usage.cacheCreation
    ? usage.cacheCreation.ephemeral5m
    : usage.cacheCreationTokens;
  const create1h = usage.cacheCreation ? usage.cacheCreation.ephemeral1h : 0;
  const create1hRate = pricing.input * CACHE_CREATE_1H_INPUT_MULTIPLIER;
  const create1hAbove =
    pricing.inputAbove === undefined
      ? undefined
      : pricing.inputAbove * CACHE_CREATE_1H_INPUT_MULTIPLIER;
  let cost: number;
  if (pricing.longContextThreshold !== undefined) {
    const context = usage.inputTokens + usage.cacheReadTokens + create5m + create1h;
    const long = context > pricing.longContextThreshold;
    const rate = (base: number, above: number | undefined) => (long ? (above ?? base) : base);
    cost =
      usage.inputTokens * rate(pricing.input, pricing.inputAbove) +
      usage.outputTokens * rate(pricing.output, pricing.outputAbove) +
      create5m * rate(pricing.cacheCreate, pricing.cacheCreateAbove) +
      create1h * rate(create1hRate, create1hAbove) +
      usage.cacheReadTokens * rate(pricing.cacheRead, pricing.cacheReadAbove);
  } else {
    cost =
      tieredCost(usage.inputTokens, pricing.input, pricing.inputAbove) +
      tieredCost(usage.outputTokens, pricing.output, pricing.outputAbove) +
      tieredCost(create5m, pricing.cacheCreate, pricing.cacheCreateAbove) +
      tieredCost(create1h, create1hRate, create1hAbove) +
      tieredCost(usage.cacheReadTokens, pricing.cacheRead, pricing.cacheReadAbove);
  }
  return cost * (usage.fast ? pricing.fastMultiplier : 1);
}

export type CodexServiceTier = "standard" | "fast" | "flex" | "ultrafast";

export interface CodexTokenUsage {
  /** Total input tokens, cached included. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  /** Output tokens, reasoning included. */
  outputTokens: number;
}

/** report.rs calculate_codex_bucket_cost for one request, with its service tier multiplier. */
export function codexCostUsd(
  model: string,
  usage: CodexTokenUsage,
  tier: CodexServiceTier | undefined,
): number | undefined {
  table ??= new PricingTable();
  const pricing = table.find(model);
  if (!pricing) return undefined;
  const long = usage.inputTokens > table.longContextSplitThreshold(model);
  const input = long ? (pricing.inputAbove ?? pricing.input) : pricing.input;
  const output = long ? (pricing.outputAbove ?? pricing.output) : pricing.output;
  const baseCacheRead = pricing.cacheReadExplicit ? pricing.cacheRead : pricing.input;
  const cacheRead = !long
    ? baseCacheRead
    : pricing.cacheReadExplicit
      ? (pricing.cacheReadAbove ?? baseCacheRead)
      : input;
  const cacheCreate = long
    ? (pricing.cacheCreateAbove ?? pricing.cacheCreate)
    : pricing.cacheCreate;
  const nonCached = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens - usage.cacheCreationTokens,
  );
  const cost =
    nonCached * input +
    usage.cachedInputTokens * cacheRead +
    usage.cacheCreationTokens * cacheCreate +
    usage.outputTokens * output;
  const multiplier =
    tier === "fast" ? pricing.fastMultiplier : tier === "flex" ? pricing.flexMultiplier : 1;
  return cost * multiplier;
}
