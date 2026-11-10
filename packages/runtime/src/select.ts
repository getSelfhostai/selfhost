import type { Env } from "@selfhost/integrations";
import { hourlyPrice, RUNTIMES, type Size, servesRegion, sizeFor } from "./catalog.js";
import { hasKey, providerSettings, type RuntimeConfig } from "./settings.js";
import { RUNTIME_KINDS, type RuntimeKind } from "./types.js";

/** What a task asks for: a runtime by flag, a size, a region. Each is optional. */
export interface RuntimeRequest {
  kind?: RuntimeKind;
  size?: { cpu?: number; memoryGiB?: number };
  region?: string;
}

/** The [runtime] rule that refused a request. */
export const RUNTIME_RULES = [
  "runtime.allow",
  "runtime.max_size",
  "runtime.region",
  "runtime.default",
] as const;
export type RuntimeRule = (typeof RUNTIME_RULES)[number];

export type RuntimeChoice =
  | {
      ok: true;
      kind: RuntimeKind;
      size: Size;
      region?: string;
      /** List price per running hour, undefined when the runtime has none. */
      usdPerHour?: number;
      /** Why this runtime, in one sentence. */
      why: string;
    }
  | { ok: false; rule: RuntimeRule; message: string };

export interface PickOptions {
  /**
   * Where keys are read from. With it, cheapest_allowed only picks runtimes that have a key;
   * without it, every allowed runtime is a candidate.
   */
  env?: Env;
}

const refuse = (rule: RuntimeRule, message: string): RuntimeChoice => ({
  ok: false,
  rule,
  message,
});

const list = (kinds: readonly string[]) => kinds.join(", ");

/**
 * Picks the runtime for one task from [runtime] in selfhost.toml. A runtime named by the task
 * must be in allow; otherwise policy decides: default uses runtime.default, cheapest_allowed the allowed runtime with a key whose list
 * price for the size is lowest (runtimes without a price come last). A size over max_size, or a
 * region the runtime cannot serve, is refused. A refusal names the rule that blocked it.
 */
export function pickRuntime(
  config: RuntimeConfig,
  request: RuntimeRequest = {},
  options: PickOptions = {},
): RuntimeChoice {
  const runtime = config.runtime ?? {};
  const allowed: readonly RuntimeKind[] = runtime.allow ?? RUNTIME_KINDS;
  const max = runtime.max_size;
  if (max) {
    const cpu = request.size?.cpu;
    const memory = request.size?.memoryGiB;
    if (max.cpu !== undefined && cpu !== undefined && cpu > max.cpu) {
      return refuse(
        "runtime.max_size",
        `The task asks for ${cpu} vCPUs; [runtime] max_size allows ${max.cpu}.`,
      );
    }
    if (max.memory_gib !== undefined && memory !== undefined && memory > max.memory_gib) {
      return refuse(
        "runtime.max_size",
        `The task asks for ${memory} GiB of memory; [runtime] max_size allows ${max.memory_gib}.`,
      );
    }
  }
  if (request.region && runtime.region && request.region !== runtime.region) {
    return refuse(
      "runtime.region",
      `The task asks for region ${request.region}; [runtime] region is ${runtime.region}.`,
    );
  }
  const region = request.region ?? runtime.region;
  const asked = request.size;

  const chosen = (kind: RuntimeKind, why: string): RuntimeChoice => {
    if (region && !servesRegion(kind, region)) {
      return refuse(
        "runtime.region",
        `${RUNTIMES[kind].name} cannot place a sandbox in region ${region}, which ${request.region ? "the task asks for" : "[runtime] region requires"}.`,
      );
    }
    const size = sizeWithin(kind, asked, max);
    const usdPerHour = hourlyPrice(kind, size, {
      usdPerHour: providerSettings(config, kind).usd_per_hour,
      region,
    });
    return {
      ok: true,
      kind,
      size,
      ...(region ? { region } : {}),
      ...(usdPerHour !== undefined ? { usdPerHour } : {}),
      why,
    };
  };

  if (request.kind) {
    if (!allowed.includes(request.kind)) {
      return refuse(
        "runtime.allow",
        `The task asks for ${request.kind}, which [runtime] allow does not list (it allows ${list(allowed)}).`,
      );
    }
    return chosen(request.kind, `The task asks for ${request.kind}.`);
  }

  if (runtime.policy === "cheapest_allowed") {
    const candidates = allowed
      .filter((kind) => !region || servesRegion(kind, region))
      .filter((kind) => !options.env || hasKey(kind, providerSettings(config, kind), options.env))
      .map((kind) => {
        const size = sizeWithin(kind, asked, max);
        const price = hourlyPrice(kind, size, {
          usdPerHour: providerSettings(config, kind).usd_per_hour,
          region,
        });
        return { kind, price };
      });
    const best = [...candidates].sort(
      (a, b) => (a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY),
    )[0];
    if (!best) {
      return refuse(
        "runtime.allow",
        `No runtime in [runtime] allow (${list(allowed)}) has a key${region ? ` and serves region ${region}` : ""}, so policy cheapest_allowed has nothing to pick.`,
      );
    }
    return chosen(
      best.kind,
      best.price === undefined
        ? `Policy cheapest_allowed: no allowed runtime has a list price, so the first one, ${best.kind}.`
        : `Policy cheapest_allowed: ${best.kind} is the cheapest allowed runtime at $${best.price.toFixed(4)} an hour.`,
    );
  }

  const fallback = runtime.default ?? config.integrations?.runtime?.tool;
  const kind = fallback ?? (allowed.length === 1 ? allowed[0] : undefined);
  if (!kind) {
    return refuse(
      "runtime.default",
      "The task names no runtime and none is set: name one with --runtime, or set [runtime] default.",
    );
  }
  if (!allowed.includes(kind)) {
    return refuse(
      "runtime.allow",
      `The default runtime ${kind} is not in [runtime] allow (${list(allowed)}).`,
    );
  }
  return chosen(
    kind,
    runtime.default
      ? `[runtime] default is ${kind}.`
      : fallback
        ? `[runtime] default is ${kind}.`
        : `${kind} is the only allowed runtime.`,
  );
}

/** A runtime's size for the request, its default cut down to max_size where it applies one. */
function sizeWithin(
  kind: RuntimeKind,
  asked: RuntimeRequest["size"],
  max: { cpu?: number; memory_gib?: number } | undefined,
): Size {
  const size = sizeFor(kind, asked);
  if (!max || !RUNTIMES[kind].sizeAtCreate) return size;
  return {
    cpu: Math.min(size.cpu, max.cpu ?? size.cpu),
    memoryGiB: Math.min(size.memoryGiB, max.memory_gib ?? size.memoryGiB),
  };
}
