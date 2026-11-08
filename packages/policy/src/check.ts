import type { ResolvedSelfhostConfig } from "@selfhost/schema";
import { evaluate, type PolicyHit } from "./evaluate.js";
import { type GuardContext, guardrailHits } from "./guardrails.js";
import type { ToolCall } from "./tool-call.js";

/**
 * An extra check on a tool call, such as the package guard. It gets the call and the policy and
 * returns hits like a rule. `signal` aborts when the time budget runs out; a checker that throws
 * or is still running then gives no hits and is listed in `failures`.
 */
export type ToolCallChecker = (
  call: ToolCall,
  config: ResolvedSelfhostConfig,
  context: { signal: AbortSignal },
) => Promise<PolicyHit[]>;

export interface CheckOptions extends GuardContext {
  /** Apply this team's overrides to the rules. */
  team?: string;
  checkers?: readonly ToolCallChecker[];
  /** Milliseconds the extra checkers get, all together. Default: 2000. */
  budgetMs?: number;
}

export interface CheckerFailure {
  /** The checker's function name, or its position in `checkers`. */
  checker: string;
  timedOut: boolean;
  message: string;
}

/** What a pre-tool hook applies to one call. */
export interface ToolCallDecision {
  /** allow, or the strongest verdict among enforce hits: block before ask. */
  verdict: "allow" | "block" | "ask";
  /**
   * The hit behind the verdict: the first enforce block, else the first enforce ask. When the
   * verdict is allow, the first observe hit, which says what enforcing it would do.
   */
  hit?: PolicyHit;
  /** Every hit: rules, then allow lists, then guardrails, then extra checkers. */
  hits: PolicyHit[];
  failures: CheckerFailure[];
}

export const DEFAULT_CHECK_BUDGET_MS = 2000;

const strongest = (hits: PolicyHit[]) =>
  hits.find((hit) => hit.verdict === "block") ?? hits.find((hit) => hit.verdict === "ask");

/** Picks the verdict from hits: enforce hits decide, observe hits only describe. */
export function decide(hits: PolicyHit[]): Pick<ToolCallDecision, "verdict" | "hit"> {
  const enforced = strongest(hits.filter((hit) => hit.mode === "enforce"));
  if (enforced) return { verdict: enforced.verdict, hit: enforced };
  const observed = strongest(hits);
  return observed ? { verdict: "allow", hit: observed } : { verdict: "allow" };
}

async function runCheckers(
  call: ToolCall,
  config: ResolvedSelfhostConfig,
  checkers: readonly ToolCallChecker[],
  budgetMs: number,
): Promise<{ hits: PolicyHit[]; failures: CheckerFailure[] }> {
  if (checkers.length === 0) return { hits: [], failures: [] };
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), budgetMs);
    timer.unref?.();
  });
  type Outcome = { hits: PolicyHit[] } | { error: unknown } | "expired";
  const outcomes = await Promise.all(
    checkers.map((checker) =>
      Promise.race<Outcome>([
        Promise.resolve()
          .then(() => checker(call, config, { signal: controller.signal }))
          .then(
            (hits) => ({ hits: Array.isArray(hits) ? hits : [] }),
            (error: unknown) => ({ error }),
          ),
        expired,
      ]),
    ),
  );
  clearTimeout(timer);
  controller.abort();
  const hits: PolicyHit[] = [];
  const failures: CheckerFailure[] = [];
  outcomes.forEach((outcome, index) => {
    const checker = checkers[index]?.name || `checker ${index + 1}`;
    if (outcome === "expired") {
      failures.push({ checker, timedOut: true, message: `no answer within ${budgetMs} ms` });
    } else if ("error" in outcome) {
      const error = outcome.error;
      failures.push({
        checker,
        timedOut: false,
        message: error instanceof Error ? error.message : String(error),
      });
    } else {
      hits.push(...outcome.hits);
    }
  });
  return { hits, failures };
}

/**
 * Everything a pre-tool hook checks on one call: the rules and allow lists in selfhost.toml, the
 * built-in guardrails, then the extra checkers, which run in parallel within `budgetMs`. A
 * checker that fails or runs out of time is reported in `failures` and does not change the
 * verdict: the hook fails open for it.
 */
export async function checkToolCall(
  config: ResolvedSelfhostConfig,
  call: ToolCall,
  options: CheckOptions = {},
): Promise<ToolCallDecision> {
  const hits = [
    ...evaluate(config, call, { team: options.team }),
    ...guardrailHits(config, call, options),
  ];
  const extra = await runCheckers(
    call,
    config,
    options.checkers ?? [],
    options.budgetMs ?? DEFAULT_CHECK_BUDGET_MS,
  );
  hits.push(...extra.hits);
  return { ...decide(hits), hits, failures: extra.failures };
}
