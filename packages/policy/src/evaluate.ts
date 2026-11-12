import {
  type AgentVendor,
  EGRESS_ALLOW_RULE_ID,
  hostAllowed,
  hostOfUrl,
  hostsInCommand,
  MCP_ALLOW_RULE_ID,
  MODELS_ALLOW_RULE_ID,
  NAMED_AGENT_RULE_PREFIX,
  type ResolvedRule,
  type ResolvedSelfhostConfig,
  type RuleAction,
  type RuleMatch,
  type RuleMode,
  type RuleOverride,
} from "@selfhost/schema";
import { anyGlobMatches, globMatches, regexMatches } from "./match.js";
import type { ToolCall } from "./tool-call.js";

/** A rule or allow-list check that fires on a tool call. */
export interface PolicyHit {
  rule_id: string;
  /** observe records the verdict only; enforce applies it where hooks run. */
  mode: Exclude<RuleMode, "off">;
  verdict: RuleAction;
  /** Why the call is stopped, in plain language. */
  message: string;
  /** What the agent can do instead, when the rule or guardrail says. */
  alternative?: string;
  /** Page that explains the rule, from its `docs`. */
  docs?: string;
  irreversible: boolean;
  /** For egress.allow: the hosts the call reaches that the list does not allow. */
  hosts?: string[];
}

/** A rule or allow-list check after team overrides, without what it matches. */
export type PolicyCheck = Omit<ResolvedRule, "match" | "description">;

export interface RuleScope {
  /** Overrides in [teams.<team>] apply. */
  team?: string;
  /** Overrides of every [teams.<name>] that lists this person as a member apply too. */
  person?: string;
  /** Only rules for this agent. Undefined keeps rules for every agent. */
  agent?: AgentVendor;
}

type Overrides = Record<string, RuleOverride>;

/** Override tables that apply to the scope, in team name order so file order does not matter. */
function overridesFor(config: ResolvedSelfhostConfig, scope: RuleScope): Overrides[] {
  return Object.entries(config.teams)
    .filter(
      ([name, team]) =>
        name === scope.team || (scope.person !== undefined && team.members.includes(scope.person)),
    )
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, team]) => team.rules);
}

function withOverrides<T extends PolicyCheck>(check: T, overrides: Overrides[]): T {
  let merged = check;
  for (const rules of overrides) merged = { ...merged, ...rules[check.id] };
  return merged;
}

/**
 * The rules after team overrides. Rules in mode off and rules for other agents are left out.
 * The [mcp] and [models] checks are not rules and are not listed.
 */
export function effectiveRules(config: ResolvedSelfhostConfig, scope: RuleScope): ResolvedRule[] {
  const overrides = overridesFor(config, scope);
  return config.rules
    .map((rule) => withOverrides(rule, overrides))
    .filter((rule) => rule.mode !== "off")
    .filter(
      (rule) =>
        scope.agent === undefined ||
        rule.agents.includes("all") ||
        rule.agents.includes(scope.agent),
    );
}

interface AllowList {
  id: string;
  mode: RuleMode;
  allow: string[];
  /** The value of the call the list is about, when the call has one. */
  value: (call: ToolCall) => string | undefined;
  message: (value?: string) => string;
  alternative: string;
}

function allowLists(config: ResolvedSelfhostConfig): AllowList[] {
  const lists: AllowList[] = [
    {
      id: MCP_ALLOW_RULE_ID,
      ...config.mcp,
      value: (call) => call.mcpServer,
      message: (server) =>
        server === undefined
          ? "MCP server is not in [mcp] allow."
          : `MCP server "${server}" is not in [mcp] allow.`,
      alternative:
        "Use a tool from an MCP server in [mcp] allow, or ask the user to add this server to the list.",
    },
    {
      id: MODELS_ALLOW_RULE_ID,
      ...config.models,
      value: (call) => call.model,
      message: (model) =>
        model === undefined
          ? "Model is not in [models] allow."
          : `Model "${model}" is not in [models] allow.`,
      alternative: "Switch to a model in [models] allow, or ask the user to add this one.",
    },
  ];
  // An empty list allows everything, so it is not a check.
  return lists.filter((list) => list.allow.length > 0);
}

/**
 * The [egress] check: its mode, and the allow list of `team` ([teams.<team>.egress]) or else the
 * org's. Undefined when there is no [egress] section. An empty list allows no host.
 */
function egressCheck(
  config: ResolvedSelfhostConfig,
  team: string | undefined,
  hosts?: string[],
): { check: PolicyCheck; allow: string[] } | undefined {
  const section = config.egress;
  if (!section) return undefined;
  const allow =
    (team === undefined ? undefined : config.teams[team]?.egress?.allow) ?? section.allow ?? [];
  const named = hosts?.map((host) => `"${host}"`).join(", ");
  return {
    allow,
    check: {
      id: EGRESS_ALLOW_RULE_ID,
      mode: section.mode ?? "observe",
      agents: ["all"],
      action: "block",
      message:
        named === undefined
          ? "Host is not in [egress] allow."
          : `${hosts?.length === 1 ? "Host" : "Hosts"} ${named} ${hosts?.length === 1 ? "is" : "are"} not in [egress] allow.`,
      alternative:
        "Use a host in [egress] allow, or ask the user to add this one to the team's list.",
      irreversible: false,
    },
  };
}

/** The hosts a call reaches: its URL's, and the URLs and git remotes in its command. */
export function callHosts(call: ToolCall): string[] {
  const hosts = new Set<string>();
  const fromUrl = call.url === undefined ? undefined : hostOfUrl(call.url);
  if (fromUrl) hosts.add(fromUrl);
  if (call.command !== undefined) for (const host of hostsInCommand(call.command)) hosts.add(host);
  return [...hosts];
}

function allowListCheck(list: AllowList, value?: string): PolicyCheck {
  return {
    id: list.id,
    mode: list.mode,
    agents: ["all"],
    action: "block",
    message: list.message(value),
    alternative: list.alternative,
    irreversible: false,
  };
}

/** Rule id of a named agent's tool list. */
export const namedAgentToolsRuleId = (name: string) => `${NAMED_AGENT_RULE_PREFIX}${name}.tools`;

/**
 * The hit for a call a named agent ([agents.<name>]) makes to a tool outside its tools list, in
 * the agent's mode: observe records it, enforce blocks it. Undefined for any other call.
 */
export function namedAgentHit(
  config: Pick<ResolvedSelfhostConfig, "agents">,
  call: Pick<ToolCall, "tool" | "namedAgent">,
): PolicyHit | undefined {
  const name = call.namedAgent;
  const agent = name === undefined ? undefined : config.agents?.[name];
  const tools = agent?.tools ?? [];
  if (!agent || tools.length === 0 || anyGlobMatches(tools, call.tool)) return undefined;
  return {
    rule_id: namedAgentToolsRuleId(name as string),
    mode: agent.mode === "enforce" ? "enforce" : "observe",
    verdict: "block",
    message: `Agent ${name} may not use ${call.tool}: it is not in [agents.${name}] tools.`,
    alternative: `Use one of ${tools.join(", ")}, or ask ${agent.owner} to add this tool to the list.`,
    irreversible: false,
  };
}

/**
 * Every rule and allow-list check in the policy with the team's overrides applied, in the order
 * evaluate reports hits: rules in file order, then mcp.allow, models.allow and egress.allow. Checks in mode
 * off are kept; an empty allow list is not a check and is left out.
 */
export function policyChecks(
  config: ResolvedSelfhostConfig,
  opts: { team?: string } = {},
): PolicyCheck[] {
  const overrides = overridesFor(config, { team: opts.team });
  const egress = egressCheck(config, opts.team);
  return [
    ...config.rules.map(({ match: _match, description: _description, ...rule }) => rule),
    ...allowLists(config).map((list) => allowListCheck(list)),
    ...(egress ? [egress.check] : []),
  ].map((check) => withOverrides(check, overrides));
}

function matches(match: RuleMatch, call: ToolCall): boolean {
  if (match.tool !== undefined && match.tool !== call.tool) return false;
  if (match.command !== undefined) {
    if (call.command === undefined || !regexMatches(match.command, call.command)) return false;
  }
  if (match.path !== undefined) {
    if (call.path === undefined || !globMatches(match.path, call.path)) return false;
  }
  if (match.url !== undefined) {
    if (call.url === undefined || !globMatches(match.url, call.url)) return false;
  }
  return true;
}

/** A check limited to some agents applies only when the call's agent is known and listed. */
function applies(check: PolicyCheck, call: ToolCall): boolean {
  if (check.mode === "off") return false;
  if (check.agents.includes("all")) return true;
  return call.agent !== undefined && check.agents.includes(call.agent);
}

function hit(check: PolicyCheck): PolicyHit {
  return {
    rule_id: check.id,
    mode: check.mode === "enforce" ? "enforce" : "observe",
    verdict: check.action,
    message: check.message,
    ...(check.alternative ? { alternative: check.alternative } : {}),
    ...(check.docs ? { docs: check.docs } : {}),
    irreversible: check.irreversible,
  };
}

/**
 * The rules and allow-list checks that fire on one tool call, with `team`'s overrides applied.
 * Pure: no I/O, and the same config and call always give the same hits in the same order
 * (rules in file order, then mcp.allow, models.allow, a named agent's tools and egress.allow). Every field a rule's `match` gives
 * must match, so a rule that tests a field the call does not have does not fire. A call to an
 * MCP server or on a model outside a non-empty allow list fires that list's check, and a call
 * that reaches a host outside [egress] allow (by URL, or a URL or git remote in its command)
 * fires egress.allow. Checks in mode off never fire.
 */
export function evaluate(
  config: ResolvedSelfhostConfig,
  call: ToolCall,
  opts: { team?: string } = {},
): PolicyHit[] {
  const overrides = overridesFor(config, { team: opts.team });
  const fired: PolicyCheck[] = [];
  for (const rule of config.rules) {
    const merged = withOverrides(rule, overrides);
    if (applies(merged, call) && matches(merged.match, call)) fired.push(merged);
  }
  for (const list of allowLists(config)) {
    const value = list.value(call);
    if (value === undefined || anyGlobMatches(list.allow, value)) continue;
    const merged = withOverrides(allowListCheck(list, value), overrides);
    if (applies(merged, call)) fired.push(merged);
  }
  const hits = fired.map(hit);
  const named = namedAgentHit(config, call);
  if (named) hits.push(named);
  const egress = egressCheck(config, opts.team);
  if (egress) {
    const outside = callHosts(call).filter((host) => !hostAllowed(host, egress.allow));
    const blocked = outside.length > 0 ? egressCheck(config, opts.team, outside) : undefined;
    const merged = blocked && withOverrides(blocked.check, overrides);
    if (merged && applies(merged, call)) hits.push({ ...hit(merged), hosts: outside });
  }
  return hits;
}
