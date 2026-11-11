import type { PolicyHit } from "@selfhost/policy/pretool";
import {
  GUARDRAIL_IDS,
  MCP_ALLOW_RULE_ID,
  MODELS_ALLOW_RULE_ID,
  PACKAGE_RULE_PREFIX,
  SELFHOST_DECISION_RULE_ID,
  type Segment,
  TomlLineIndex,
} from "@selfhost/schema";
import { parse as parseToml } from "smol-toml";
import type { PolicySource } from "../find-config.js";
import { DOCS_URL } from "../project.js";

/**
 * What a block or an ask says, to the agent and to the person. The agent's text names the rule,
 * says why and what to do instead, and tells it not to retry but to take the alternative or ask
 * for a one-time exception. The person's text says the same with the command that allows the
 * call once. Both link to the rule: its line in selfhost.toml, or the docs of a built-in check.
 */

const DOCS = `${DOCS_URL}/packages`;
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
  /** The session's permission mode, when it is why an ask became a deny. */
  skippedBy?: string;
}

/** The text each side reads. */
export interface Explained {
  agent: string;
  user: string;
}

/** The command a person runs to allow a blocked call once. */
export const approveCommand = (id: string) => `selfhost inbox approve ${id}`;

/** Where in one file a rule is defined, as TOML key segments, or undefined when it is not. */
function definedAt(ruleId: string, text: string): Segment[] | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const rules = Array.isArray(raw.rules) ? (raw.rules as { id?: unknown }[]) : [];
  const index = rules.findIndex((rule) => rule?.id === ruleId);
  if (index !== -1) return ["rules", index];
  if (ruleId === MCP_ALLOW_RULE_ID && raw.mcp !== undefined) return ["mcp"];
  if (ruleId === MODELS_ALLOW_RULE_ID && raw.models !== undefined) return ["models"];
  return undefined;
}

/**
 * Where a rule is defined: the built-in docs for guardrails and package checks, else the line of
 * the rule (or of [mcp] or [models]) in the file that defines it. On a machine in a team the
 * policy is the team's file with the repository's on top, so the rule is looked up in each, the
 * repository's first since its restatement of a team rule is the one in use, and the link names
 * the layer.
 */
export function ruleLink(ruleId: string, sources: readonly PolicySource[]): string | undefined {
  if (
    (GUARDRAIL_IDS as readonly string[]).includes(ruleId) ||
    ruleId === SELFHOST_DECISION_RULE_ID
  ) {
    return GUARDRAILS_DOCS;
  }
  if (ruleId.startsWith(PACKAGE_RULE_PREFIX)) return PACKAGES_DOCS;
  const named = (source: PolicySource, at: string) =>
    source.layer ? `${at} (${source.layer})` : at;
  for (const source of [...sources].reverse()) {
    const segments = definedAt(ruleId, source.text);
    if (!segments) continue;
    const line = new TomlLineIndex(source.text).lineOf(segments);
    return named(source, line === undefined ? source.path : `${source.path}:${line}`);
  }
  const last = sources.at(-1);
  return last ? named(last, last.path) : undefined;
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
  if (e.hit.verdict === "ask" && e.skippedBy) {
    return `selfhost blocked ${subject}: ${rule} needs a person's yes first, and this ${e.agent} session runs in ${e.skippedBy} mode, which skips asks. ${e.hit.message}`;
  }
  if (e.hit.verdict === "ask") {
    return `selfhost blocked ${subject}: ${rule} needs a person's approval first, and ${e.agent} cannot ask from a hook. ${e.hit.message}`;
  }
  return `selfhost blocked ${subject} under ${rule}: ${e.hit.message}`;
}

/** The text for a deny: the agent's version and the person's. */
function deny(e: Explanation): Explained {
  const path = e.hit.alternative ? "the alternative above" : "another approach the rule allows";
  const yourself = e.skippedBy ? ", ask the user to run it themselves" : "";
  const next = e.exceptionId
    ? `Do not retry this call, or a variant of it, to get around the rule: it will be blocked again. Take ${path}${yourself}, or, if this exact call is needed, ask the user to approve one-time exception ${e.exceptionId}. Only a person can approve it, in their own terminal or the console; do not run the approval yourself. Once they approve, make the identical call again and it is allowed once.`
    : `Do not retry this call, or a variant of it, to get around the rule: it will be blocked again. Take ${path}${yourself}, or ask the user how to go on.`;
  const agent = [headline(e, true), ...instead(e), next, ...tail(e)];
  const user = [
    headline(e, false),
    ...instead(e),
    ...(e.skippedBy ? ["Run it yourself, or allow the agent's call once."] : []),
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
