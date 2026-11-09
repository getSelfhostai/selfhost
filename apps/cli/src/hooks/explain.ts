import type { PolicyHit } from "@selfhost/policy/pretool";
import {
  GUARDRAIL_IDS,
  MCP_ALLOW_RULE_ID,
  MODELS_ALLOW_RULE_ID,
  PACKAGE_RULE_PREFIX,
  type ResolvedSelfhostConfig,
  SELFHOST_DECISION_RULE_ID,
  TomlLineIndex,
} from "@selfhost/schema";

/**
 * What a block or an ask says, to the agent and to the person. The agent's text names the rule,
 * says why and what to do instead, and tells it not to retry but to take the alternative or ask
 * for a one-time exception. The person's text says the same with the command that allows the
 * call once. Both link to the rule: its line in selfhost.toml, or the docs of a built-in check.
 */

const DOCS = "https://github.com/getselfhostai/selfhost/blob/main/packages";
export const GUARDRAILS_DOCS = `${DOCS}/policy/README.md#guardrails`;
export const PACKAGES_DOCS = `${DOCS}/package-guard/README.md#rules-and-verdicts`;

/** The block or ask to explain. */
export interface Explanation {
  /** The agent's name, as people know it. */
  agent: string;
  hit: Pick<PolicyHit, "rule_id" | "verdict" | "message" | "alternative" | "docs">;
  /** What the agent was told: an ask it cannot put to a person is a deny. */
  answer: "deny" | "ask";
  /** Where the rule is: selfhost.toml path and line, or a docs URL. */
  link?: string;
  /** The review item that allows this call once when a person approves it. */
  exceptionId?: string;
}

/** The text each side reads. */
export interface Explained {
  agent: string;
  user: string;
}

/** The command a person runs to allow a blocked call once. */
export const approveCommand = (id: string) => `selfhost inbox approve ${id}`;

/**
 * Where a rule is defined: the built-in docs for guardrails and package checks, else the line of
 * the rule (or of [mcp] or [models]) in the policy file the hook read.
 */
export function ruleLink(
  ruleId: string,
  config: ResolvedSelfhostConfig,
  source: { path: string; text: string } | undefined,
): string | undefined {
  if (
    (GUARDRAIL_IDS as readonly string[]).includes(ruleId) ||
    ruleId === SELFHOST_DECISION_RULE_ID
  ) {
    return GUARDRAILS_DOCS;
  }
  if (ruleId.startsWith(PACKAGE_RULE_PREFIX)) return PACKAGES_DOCS;
  if (!source) return undefined;
  const index = config.rules.findIndex((rule) => rule.id === ruleId);
  const segments =
    index !== -1
      ? ["rules", index]
      : ruleId === MCP_ALLOW_RULE_ID
        ? ["mcp"]
        : ruleId === MODELS_ALLOW_RULE_ID
          ? ["models"]
          : undefined;
  const line = segments ? new TomlLineIndex(source.text).lineOf(segments) : undefined;
  return line === undefined ? source.path : `${source.path}:${line}`;
}

function tail(e: Explanation): string[] {
  return [
    ...(e.link ? [`Rule: ${e.link}`] : []),
    ...(e.hit.docs && e.hit.docs !== e.link ? [`More: ${e.hit.docs}`] : []),
  ];
}

const instead = (e: Explanation) => (e.hit.alternative ? [`Instead: ${e.hit.alternative}`] : []);

/** The first line: what happened and why, for the agent or for the person. */
function headline(e: Explanation, forAgent: boolean): string {
  const rule = `rule ${e.hit.rule_id}`;
  const subject = forAgent ? "this call" : `a ${e.agent} call`;
  if (e.hit.verdict === "ask") {
    return `selfhost blocked ${subject}: ${rule} needs a person's approval first, and ${e.agent} cannot ask from a hook. ${e.hit.message}`;
  }
  return `selfhost blocked ${subject} under ${rule}: ${e.hit.message}`;
}

/** The text for a deny: the agent's version and the person's. */
function deny(e: Explanation): Explained {
  const path = e.hit.alternative ? "the alternative above" : "another approach the rule allows";
  const next = e.exceptionId
    ? `Do not retry this call, or a variant of it, to get around the rule: it will be blocked again. Take ${path}, or, if this exact call is needed, ask the user to approve one-time exception ${e.exceptionId}. Only a person can approve it, in their own terminal or the console; do not run the approval yourself. Once they approve, make the identical call again and it is allowed once.`
    : `Do not retry this call, or a variant of it, to get around the rule: it will be blocked again. Take ${path}, or ask the user how to go on.`;
  const agent = [headline(e, true), ...instead(e), next, ...tail(e)];
  const user = [
    headline(e, false),
    ...instead(e),
    ...(e.exceptionId ? [`To allow it once, run: ${approveCommand(e.exceptionId)}`] : []),
    ...tail(e),
  ];
  return { agent: agent.join("\n"), user: user.join("\n") };
}

/**
 * The texts for a block or an ask. An ask goes to the person in the agent's own prompt, so both
 * texts are the person's.
 */
export function explain(e: Explanation): Explained {
  if (e.answer === "deny") return deny(e);
  const text = [
    `selfhost: rule ${e.hit.rule_id} asks a person first: ${e.hit.message}`,
    ...instead(e),
    ...tail(e),
  ].join("\n");
  return { agent: text, user: text };
}

/** What the person sees when an approved exception lets a call through. */
export function grantUsedText(grant: { id: string; approved_by: string }, ruleId: string): string {
  return `selfhost allowed this call once under rule ${ruleId}: ${grant.approved_by} approved exception ${grant.id}. The next identical call is blocked again.`;
}
