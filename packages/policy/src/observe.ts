import { type Ledger, stableEventId } from "@selfhost/ledger";
import {
  type Actor,
  type Decision,
  EVENT_SCHEMA,
  type LedgerEvent,
  type ResolvedSelfhostConfig,
  type RuleAction,
  type RuleMode,
} from "@selfhost/schema";
import { evaluate, type PolicyHit, policyChecks } from "./evaluate.js";
import type { PolicySource } from "./source.js";
import { toolCallFromEvent } from "./tool-call.js";

/** actor.id and decision.by of every event the policy pass writes. */
export const POLICY_ACTOR_ID = "selfhost-policy";

export interface ObserveOptions {
  /** Tool calls at or after this time. Default: every tool call in the ledger. */
  since?: Date;
  /** Only tool calls in this repository count; file paths become relative to it. */
  repoRoot: string;
  /** Apply this team's overrides and record the team on each event. */
  team?: string;
  /** Recorded as data.evaluated_at. Default: the current time. */
  now?: Date;
}

export interface ObservedRule {
  rule_id: string;
  /** Mode after the team's overrides. Rules in mode off are listed and never fire. */
  mode: RuleMode;
  action: RuleAction;
  /** policy.evaluated events written by this run. */
  recorded: number;
  /** Hits an earlier run with the same policy file already recorded. */
  duplicates: number;
}

export interface ObserveResult {
  /** tool.called events read from the ledger. */
  tool_calls: number;
  /** Tool calls that belong to the repository, the ones evaluated. */
  evaluated: number;
  recorded: number;
  duplicates: number;
  /** Every rule and allow-list check, in evaluation order. */
  rules: ObservedRule[];
}

const PAGE = 1000;
const ACTOR: Actor = { kind: "system", id: POLICY_ACTOR_ID };

/** Working folder of each session, from its session.started event. */
async function sessionCwd(
  ledger: Pick<Ledger, "query">,
  sessionId: string | undefined,
  known: Map<string, string | undefined>,
): Promise<string | undefined> {
  if (sessionId === undefined) return undefined;
  if (known.has(sessionId)) return known.get(sessionId);
  const { events } = await ledger.query({ kind: "session.started", session: sessionId, limit: 1 });
  const cwd = events[0]?.data?.cwd;
  const value = typeof cwd === "string" && cwd !== "" ? cwd : undefined;
  known.set(sessionId, value);
  return value;
}

/**
 * The policy.evaluated event for one hit. The id depends only on the tool call, the rule and
 * the policy file's hash, so evaluating the same call against the same file again writes
 * nothing new. ts is the tool call's time, so the verdict sorts next to the call it judged.
 */
export function policyEvent(
  toolEvent: LedgerEvent,
  hit: PolicyHit,
  source: Pick<PolicySource, "hash" | "commit">,
  opts: { team?: string; evaluatedAt: string },
): LedgerEvent {
  const decision: Decision = {
    verdict: hit.verdict,
    by: POLICY_ACTOR_ID,
    reason: hit.message,
    rule_id: hit.rule_id,
    mode: hit.mode,
    ...(source.commit ? { policy_commit: source.commit } : {}),
    policy_hash: source.hash,
  };
  const { repo, agent, model, session_id, tool, target, redacted } = toolEvent;
  return {
    id: stableEventId(
      toolEvent.ts,
      `policy.evaluated\n${toolEvent.id}\n${hit.rule_id}\n${source.hash}`,
    ),
    schema: EVENT_SCHEMA,
    ts: toolEvent.ts,
    source: "cli",
    kind: "policy.evaluated",
    actor: { ...ACTOR },
    ...(opts.team ? { team: opts.team } : {}),
    ...(repo ? { repo } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(session_id ? { session_id } : {}),
    ...(tool ? { tool } : {}),
    ...(target ? { target } : {}),
    decision,
    data: {
      tool_event_id: toolEvent.id,
      evaluated_at: opts.evaluatedAt,
      ...(hit.irreversible ? { irreversible: true } : {}),
    },
    // The copied tool and target were masked the same way as on the tool call.
    ...(redacted ? { redacted } : {}),
  };
}

/**
 * Evaluates every tool.called event in the ledger (from `since` on) that belongs to the
 * repository and appends one policy.evaluated event per hit. It never stops anything: it reads
 * calls that already happened. decision.mode is the check's mode for the team, so a hit from an
 * enforce rule records what hooks will block, not something that was blocked. Running it again
 * with the same policy file reports the earlier hits as duplicates.
 */
export async function observeLedger(
  ledger: Pick<Ledger, "append" | "query">,
  config: ResolvedSelfhostConfig,
  source: PolicySource,
  options: ObserveOptions,
): Promise<ObserveResult> {
  const team = options.team;
  const evaluatedAt = (options.now ?? new Date()).toISOString();
  const rules = new Map<string, ObservedRule>(
    policyChecks(config, { team }).map((check) => [
      check.id,
      { rule_id: check.id, mode: check.mode, action: check.action, recorded: 0, duplicates: 0 },
    ]),
  );
  const result: ObserveResult = {
    tool_calls: 0,
    evaluated: 0,
    recorded: 0,
    duplicates: 0,
    rules: [...rules.values()],
  };
  const cwds = new Map<string, string | undefined>();
  let cursor: string | undefined;
  do {
    const page = await ledger.query({
      kind: "tool.called",
      from: options.since?.toISOString(),
      limit: PAGE,
      cursor,
    });
    const ruleOf = new Map<string, string>();
    const events: LedgerEvent[] = [];
    for (const toolEvent of page.events) {
      result.tool_calls += 1;
      const cwd = await sessionCwd(ledger, toolEvent.session_id, cwds);
      const call = toolCallFromEvent(toolEvent, options.repoRoot, cwd);
      if (!call) continue;
      result.evaluated += 1;
      for (const hit of evaluate(config, call, { team })) {
        const event = policyEvent(toolEvent, hit, source, { team, evaluatedAt });
        ruleOf.set(event.id, hit.rule_id);
        events.push(event);
      }
    }
    if (events.length > 0) {
      const { accepted, duplicates } = await ledger.append(events);
      for (const id of accepted) count(rules, ruleOf.get(id), "recorded");
      for (const id of duplicates) count(rules, ruleOf.get(id), "duplicates");
      result.recorded += accepted.length;
      result.duplicates += duplicates.length;
    }
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}

function count(
  rules: Map<string, ObservedRule>,
  ruleId: string | undefined,
  field: "recorded" | "duplicates",
): void {
  const rule = ruleId === undefined ? undefined : rules.get(ruleId);
  if (rule) rule[field] += 1;
}
