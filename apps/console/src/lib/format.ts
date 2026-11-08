import type { Breakdown } from "./view";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdPrecise = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US");

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return usdPrecise.format(value);
  return usd.format(value);
}

export const formatCompact = (value: number) => compact.format(value);
export const formatCount = (value: number) => whole.format(value);

const AGENTS: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  goose: "Goose",
  cursor: "Cursor",
  copilot: "Copilot",
  other: "Other agent",
};

const UNKNOWN: Record<Breakdown, string> = {
  team: "No team",
  person: "Agents and services",
  agent: "No agent",
  model: "No model",
};

/** How a dimension value reads in the console. The CSV keeps the raw values. */
export function label(dimension: Breakdown, value: string): string {
  if (value === "unknown") return UNKNOWN[dimension];
  if (dimension === "agent") return AGENTS[value] ?? value;
  return value;
}

export const DIMENSION_NAMES: Record<Breakdown, { one: string; many: string }> = {
  team: { one: "Team", many: "Teams" },
  person: { one: "Developer", many: "Developers" },
  agent: { one: "Agent", many: "Agents" },
  model: { one: "Model", many: "Models" },
};

export function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
