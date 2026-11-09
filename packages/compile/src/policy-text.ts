import type { RuleMatch } from "@selfhost/schema";
import { code } from "./mapping.js";
import type { Check } from "./types.js";

/** Display names of the agents a rule can be limited to. */
export const AGENT_NAMES: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  goose: "Goose",
  cursor: "Cursor",
  copilot: "Copilot",
  other: "other agents",
};

function describe(match: RuleMatch): string {
  const parts: string[] = [];
  if (match.command !== undefined) {
    parts.push(`shell commands matching the regular expression ${code(match.command)}`);
  }
  if (match.path !== undefined) {
    parts.push(`files matching ${code(match.path)} from the repository root`);
  }
  if (match.url !== undefined) parts.push(`URLs matching ${code(match.url)}`);
  if (match.tool === undefined) return parts.join(", with ");
  if (parts.length === 0) return `every ${code(match.tool)} call`;
  return `${code(match.tool)} calls on ${parts.join(", with ")}`;
}

function scope(check: Check): string {
  const verdict =
    check.mode === "enforce"
      ? check.action === "block"
        ? "enforced: blocked"
        : "enforced: asks a person first"
      : check.action === "block"
        ? "observed: would be blocked"
        : "observed: would ask a person first";
  const agents = check.agents.includes("all")
    ? ""
    : `, only for ${check.agents.map((agent) => AGENT_NAMES[agent] ?? agent).join(" and ")}`;
  return `${verdict}${agents}${check.irreversible ? ", cannot be undone" : ""}`;
}

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * The policy as plain text for agents to read: Ruler copies it into each agent's rules file,
 * and it is the text of the Cursor team rule. Rules in mode off are left out. Empty when no
 * rule or allow list is on.
 */
export function policyText(checks: Check[], team?: string): string {
  const on = checks.filter((check) => check.mode !== "off");
  if (on.length === 0) return "";
  const lines = [
    "# Team policy",
    "",
    `These rules come from selfhost.toml${team ? ` with the overrides of team ${team}` : ""}. Follow every one. Rules in enforce mode are also enforced through each agent's settings and hooks; the others are recorded.`,
    "",
    "selfhost policy compile writes this file. Change selfhost.toml and compile again instead of editing it.",
  ];
  const rules = on.filter((check) => check.match !== undefined);
  if (rules.length > 0) {
    lines.push("", "## Rules", "");
    for (const check of rules) {
      lines.push(
        `- ${code(check.id)} (${scope(check)}): ${sentence(check.message)} Applies to ${describe(check.match as RuleMatch)}.`,
      );
    }
  }
  for (const check of on) {
    if (check.list === undefined) continue;
    const state = check.mode === "enforce" ? "enforced" : "observed";
    if (check.list.kind === "egress") {
      const hosts = check.list.allow.map(code).join(", ");
      lines.push(
        "",
        "## Network",
        "",
        hosts === ""
          ? `Reach no outside host (${state}).`
          : `Reach only these hosts (${state}): ${hosts}.`,
      );
      continue;
    }
    const what = check.list.kind === "mcp" ? "MCP servers" : "models";
    lines.push(
      "",
      `## ${check.list.kind === "mcp" ? "MCP servers" : "Models"}`,
      "",
      `Use only these ${what} (${state}): ${check.list.allow.map(code).join(", ")}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
