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

export const agentName = (vendor: string | null | undefined) =>
  vendor ? (AGENTS[vendor] ?? vendor) : "Unknown agent";

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

/** 0.125 reads 12.5%; null reads as a dash. */
export const formatShare = (value: number | null | undefined) =>
  value === null || value === undefined ? "-" : percent.format(value);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago: "just now", "5m ago", "3h ago", "2d ago". */
export function ago(time: string, now: Date): string {
  const ms = now.getTime() - Date.parse(time);
  if (!Number.isFinite(ms) || ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}

/** A time as "Nov 7, 10:04" in the viewer's time zone. */
export function formatTime(time: string): string {
  return new Date(time).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${formatCount(n)} ${n === 1 ? one : many}`;
