export type RiskLevel = "low" | "medium" | "high";

export const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high"];

/** Risk labels: `selfhost:risk-low`, `selfhost:risk-medium` and `selfhost:risk-high`. */
export const RISK_LABEL_PREFIX = "selfhost:risk-";

/** Agent labels, such as `selfhost:agent-claude-code`. */
export const AGENT_LABEL_PREFIX = "selfhost:agent-";

/** GitHub caps label names at 50 characters. */
const MAX_LABEL_LENGTH = 50;

export function riskLabel(level: RiskLevel): string {
  return `${RISK_LABEL_PREFIX}${level}`;
}

/** The label for an agent id such as `claude_code`: lower case, runs of other characters as `-`. */
export function agentLabel(agent: string): string {
  const slug =
    agent
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown";
  return `${AGENT_LABEL_PREFIX}${slug}`.slice(0, MAX_LABEL_LENGTH).replace(/-+$/, "");
}

/**
 * Labels the sync adds and removes. Every other label, including other `selfhost:` labels a team
 * made by hand, is left alone. GitHub compares label names ignoring case, and so does this.
 */
export function isManagedLabel(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith(RISK_LABEL_PREFIX) || lower.startsWith(AGENT_LABEL_PREFIX);
}
