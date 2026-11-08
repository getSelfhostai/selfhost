import type { Ledger } from "@selfhost/ledger";
import { guardrailChecks, policyChecks } from "@selfhost/policy";
import { observedRules } from "@selfhost/review";
import {
  createValidator,
  type LedgerEvent,
  POLICY_OBSERVED_DEFAULT_DAYS,
  POLICY_OBSERVED_SCHEMA,
  PolicyObservedQuerySchema,
  type PolicyObservedResponse,
  type PolicyObservedRule,
  type Rule,
  type RuleMode,
} from "@selfhost/schema";
import { apiError, authorize, type Router } from "./access.js";
import { invalidQuery } from "./http.js";

const DAY_MS = 86_400_000;
const PAGE = 1000;
/** policy.evaluated events read per request at most, newest first. */
export const MAX_OBSERVED_EVENTS = 20_000;

const observedQuery = createValidator(PolicyObservedQuerySchema);

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const ruleOf = (event: LedgerEvent) => {
  const id = event.decision?.rule_id;
  return typeof id === "string" && id !== "" ? id : undefined;
};

/** One verdict per rule and tool call, like observedRules: a call evaluated twice counts once. */
const callKey = (event: LedgerEvent, ruleId: string) => {
  const tool = event.data?.tool_event_id;
  return typeof tool === "string" ? `${ruleId}\u0000${tool}` : event.id;
};

/**
 * What each rule and guardrail of a team did in a window, from its policy.evaluated events:
 * observe-mode hits (what it would have blocked or asked) grouped like the weekly policy report,
 * and enforce-mode verdicts (what it blocked or asked). mode is the rule's mode in the team's
 * policy now, so the console can offer to start blocking a rule that is still recording.
 */
export function policyObservedReport(
  events: readonly LedgerEvent[],
  options: {
    team: string;
    from: Date;
    to: Date;
    rules?: readonly Rule[];
    modes: ReadonlyMap<string, RuleMode>;
  },
): PolicyObservedResponse {
  const observed = observedRules(events, options.rules);
  const rows = new Map<string, PolicyObservedRule>();
  const sessions = new Map<string, Set<string>>();
  const row = (ruleId: string) => {
    let found = rows.get(ruleId);
    if (!found) {
      found = {
        rule_id: ruleId,
        mode: options.modes.get(ruleId) ?? null,
        would_block: 0,
        would_ask: 0,
        blocked: 0,
        asked: 0,
        sessions: 0,
        likely_false_positives: 0,
        examples: [],
        more_examples: 0,
      };
      rows.set(ruleId, found);
      sessions.set(ruleId, new Set());
    }
    return found;
  };

  const byId = new Map(events.map((event) => [event.id, event]));
  for (const rule of observed) {
    const target = row(rule.rule_id);
    const seen = sessions.get(rule.rule_id);
    for (const id of rule.event_ids) {
      const event = byId.get(id);
      if (!event) continue;
      if (event.decision?.verdict === "ask") target.would_ask += 1;
      else target.would_block += 1;
      if (event.session_id) seen?.add(event.session_id);
    }
    target.likely_false_positives = rule.likely_false_positives;
    target.examples = rule.examples;
    target.more_examples = rule.more_examples;
  }

  const counted = new Set<string>();
  for (const event of events) {
    const ruleId = ruleOf(event);
    const verdict = event.decision?.verdict;
    if (event.kind !== "policy.evaluated" || event.decision?.mode !== "enforce" || !ruleId) {
      continue;
    }
    if (verdict !== "block" && verdict !== "ask") continue;
    const key = callKey(event, ruleId);
    if (counted.has(key)) continue;
    counted.add(key);
    const target = row(ruleId);
    if (verdict === "ask") target.asked += 1;
    else target.blocked += 1;
    if (event.session_id) sessions.get(ruleId)?.add(event.session_id);
  }

  const hits = (rule: PolicyObservedRule) =>
    rule.would_block + rule.would_ask + rule.blocked + rule.asked;
  const list = [...rows.values()]
    .map((rule) => ({ ...rule, sessions: sessions.get(rule.rule_id)?.size ?? 0 }))
    .sort((a, b) => hits(b) - hits(a) || compareText(a.rule_id, b.rule_id));
  const sum = (field: "would_block" | "would_ask" | "blocked" | "asked") =>
    list.reduce((total, rule) => total + rule[field], 0);
  return {
    schema: POLICY_OBSERVED_SCHEMA,
    team: options.team,
    from: options.from.toISOString(),
    to: options.to.toISOString(),
    rules: list,
    totals: {
      would_block: sum("would_block"),
      would_ask: sum("would_ask"),
      blocked: sum("blocked"),
      asked: sum("asked"),
    },
  };
}

/**
 * GET /v1/policy/observed for both kinds of token: what each rule and guardrail of a team would
 * have blocked or asked in observe mode, and did in enforce mode, over a window (default the
 * last 7 days). Read-only; anyone in the team can read it.
 */
export function policyObservedRoutes(
  router: Router,
  ledger: Ledger,
  { now = () => new Date() }: { now?: () => Date } = {},
): void {
  router.on("GET", "/v1/policy/observed", async (c, caller) => {
    const query = observedQuery.validate(c.req.query());
    if (!query.ok) return invalidQuery(c, query.errors);
    const team = query.value.team ?? (caller.kind === "person" ? caller.person.team : undefined);
    if (team === undefined) {
      return c.json(apiError("invalid_query", "team: Required with the admin token"), 400);
    }
    const refused = await authorize(c, caller, team, "read");
    if (refused) return refused;
    if (!(await ledger.teams.getTeam(team))) {
      return c.json(apiError("not_found", `No team ${team}`), 404);
    }
    const to = query.value.to ? new Date(query.value.to) : now();
    const from = query.value.from
      ? new Date(query.value.from)
      : new Date(to.getTime() - POLICY_OBSERVED_DEFAULT_DAYS * DAY_MS);
    if (from >= to) {
      return c.json(apiError("invalid_query", "from: Expected a time before to"), 400);
    }

    const events: LedgerEvent[] = [];
    let cursor: string | undefined;
    do {
      const page = await ledger.query({
        kind: "policy.evaluated",
        team,
        from: from.toISOString(),
        to: to.toISOString(),
        limit: PAGE,
        cursor,
      });
      events.push(...page.events);
      cursor = page.nextCursor;
    } while (cursor && events.length < MAX_OBSERVED_EVENTS);

    const policy = await ledger.orgs.effectivePolicy(team);
    const modes = new Map<string, RuleMode>();
    if (policy) {
      const checks = [...policyChecks(policy.config, { team }), ...guardrailChecks(policy.config)];
      for (const check of checks) modes.set(check.id, check.mode);
    }
    return c.json(
      policyObservedReport(events, {
        team,
        from,
        to,
        ...(policy ? { rules: policy.config.rules } : {}),
        modes,
      }) satisfies PolicyObservedResponse,
    );
  });
}
