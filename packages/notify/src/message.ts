import {
  type AgentVendor,
  eventIdentities,
  type LedgerEvent,
  maskSecrets,
  type NotifyCadence,
  type ReviewItem,
  type ReviewItemKind,
} from "@selfhost/schema";
import type { Message } from "./apprise.js";

/**
 * What goes into a message: a summary selfhost writes itself and a link to the item in the
 * console. Never the item's brief, a command or tool input, a question's text, a diff, a prompt
 * or anything an agent or a person typed. Approving happens in the console, through the link.
 */

const KIND_NAMES: Record<ReviewItemKind, string> = {
  pr: "Pull request",
  approval: "Approval",
  question: "Question",
  blocked_action: "Blocked action",
  exception: "Exception request",
  stuck_run: "Stuck run",
  budget: "Budget",
  spend_spike: "Spend spike",
  quality: "Code quality",
  policy_report: "Rules report",
  context_promotion: "Team context proposal",
  security: "Security alert",
  overlap: "Edit overlap",
};

const AGENT_NAMES: Record<AgentVendor, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  goose: "Goose",
  cursor: "Cursor",
  copilot: "Copilot",
  other: "An agent",
};

const MAX_LINE = 160;
const DIGEST_LINES = 15;
/** Rule ids, repos and the like: shown only when they look like one. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,99}$/;

/**
 * Text selfhost composed (budget and spike alerts) made safe to send: no code spans or fences,
 * secrets and emails masked, one line, clipped. `keep` holds the person ids the text may name: the
 * people its event stores in the clear, such as the person a budget alert is about.
 */
export function clean(text: string, keep?: ReadonlySet<string>): string {
  const stripped = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const masked = maskSecrets(stripped, [], keep).text;
  return masked.length > MAX_LINE ? `${masked.slice(0, MAX_LINE - 3)}...` : masked;
}

const plainId = (value: string | undefined) =>
  value !== undefined && PLAIN_ID.test(value) ? value : undefined;

function agentOf(item: ReviewItem): string {
  return item.agent ? AGENT_NAMES[item.agent.vendor] : "An agent";
}

/** One line about an item, written by selfhost from the item's kind and fields. */
export function summaryOf(item: ReviewItem): string {
  const agent = agentOf(item);
  switch (item.kind) {
    case "approval":
      return `${agent} waits for an approval`;
    case "question":
      return `${agent} waits for an answer`;
    case "exception":
      return `${agent} asks to make a blocked call once`;
    case "blocked_action":
      return "A rule blocked an agent's action";
    case "pr":
      return "An agent pull request is ready for review";
    case "stuck_run":
      return `${agent} run failed or looks stuck`;
    case "quality":
      return "A code quality check fell below its threshold";
    case "context_promotion":
      return "A context item was proposed to the team";
    case "policy_report":
      return "Last week's report of what observed rules would have blocked";
    case "security":
      return "An allow cited an exception the server never signed: possible forged grant";
    case "overlap":
      return "Two active runs are editing the same file";
    // selfhost writes these titles from numbers; anything else in them falls back.
    case "budget":
      return numbersOnly(item.title) ?? "A budget or plan limit needs attention";
    case "spend_spike":
      return numbersOnly(item.title) ?? "Spend far above the usual rate: possibly a stolen key";
  }
}

/** Words, numbers and money only: no code, quotes, slashes, braces or markup. */
const PLAIN_TITLE = /^[\p{L}\p{N} $%',.:()@+?-]+$/u;

/** A title selfhost wrote from numbers, masked; undefined when it holds anything more. */
function numbersOnly(title: string): string | undefined {
  const flat = title.replace(/\s+/g, " ").trim();
  return PLAIN_TITLE.test(flat) ? clean(flat) : undefined;
}

/** Where the item is in the console, or undefined without a console address. */
export function itemLink(consoleUrl: string | undefined, id: string): string | undefined {
  if (!consoleUrl) return undefined;
  return `${consoleUrl.replace(/\/+$/, "")}/?screen=review&item=${encodeURIComponent(id)}`;
}

export function listLink(consoleUrl: string | undefined, screen = "review"): string | undefined {
  if (!consoleUrl) return undefined;
  return `${consoleUrl.replace(/\/+$/, "")}/?screen=${screen}`;
}

const NO_CONSOLE = "Open it with selfhost inbox or selfhost console.";

function facts(item: ReviewItem): string {
  const parts: string[] = [];
  const repo = plainId(item.repo);
  if (repo) parts.push(repo);
  const rule = plainId(item.why?.rule_id);
  if (rule) parts.push(`rule ${rule}`);
  parts.push(`risk ${item.risk.score}`);
  return parts.join(", ");
}

const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;

/** The instant push for an item an agent waits on. */
export function itemMessage(item: ReviewItem, consoleUrl: string | undefined): Message {
  const link = itemLink(consoleUrl, item.id);
  const lines = [`${summaryOf(item)} (${facts(item)}).`];
  if (item.deadline) {
    lines.push(`No answer by ${hhmm(item.deadline)} denies it.`);
  }
  lines.push(link ? `Answer it in the console: ${link}` : NO_CONSOLE);
  return {
    title: `selfhost: ${KIND_NAMES[item.kind]}${item.blocking ? ", an agent waits" : ""}`,
    body: lines.join("\n"),
    type: "warning",
  };
}

/**
 * An item's digest line: its kind and summary, with the rule that raised it, its repository and
 * its agent when the summary does not name one. Ids only, never the item's text.
 */
function digestLine(item: ReviewItem): string {
  const summary = summaryOf(item);
  const rule = plainId(item.why?.rule_id);
  const agent = item.agent ? AGENT_NAMES[item.agent.vendor] : undefined;
  const notes = [
    rule ? `rule ${rule}` : undefined,
    plainId(item.repo),
    agent && !summary.includes(agent) ? agent : undefined,
    item.blocking ? "an agent waits" : undefined,
  ].filter((note) => note !== undefined);
  const after = notes.length > 0 ? ` (${notes.join(", ")})` : "";
  return `- ${KIND_NAMES[item.kind]}: ${summary}${after}`;
}

/** A person's digest of their open review items, best first, the same line once with a count. */
export function digestMessage(
  items: readonly ReviewItem[],
  cadence: Exclude<NotifyCadence, "off">,
  consoleUrl: string | undefined,
): Message {
  const counts = new Map<string, number>();
  for (const item of items) {
    const line = digestLine(item);
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const lines = [...counts].map(([line, n]) => (n > 1 ? `${line}, ${n} times` : line));
  const shown = lines.slice(0, DIGEST_LINES);
  const more = lines.length - shown.length;
  const link = listLink(consoleUrl);
  const count = `${items.length} ${items.length === 1 ? "item" : "items"}`;
  return {
    title: `selfhost: ${count} on your review list`,
    body: [
      `Your ${cadence} digest: ${count} waiting for you.`,
      ...shown,
      ...(more > 0 ? [`...and ${more} more kinds of item.`] : []),
      link ? `Review list: ${link}` : "Open them with selfhost inbox or selfhost console.",
    ].join("\n"),
    type: "info",
  };
}

/** A budget alert at 50%, 80% or 100% (alert.raised budget or budget_exceeded). */
export function spendAlertMessage(event: LedgerEvent, consoleUrl: string | undefined): Message {
  const data = event.data ?? {};
  const percent = typeof data.percent === "number" ? data.percent : 100;
  // The alert's own person (its actor or owner) may be named; any other email stays masked.
  const subject = eventIdentities(event);
  const message =
    typeof data.message === "string" ? clean(data.message, subject) : "A budget was spent";
  const suggestion = typeof data.suggestion === "string" ? clean(data.suggestion) : undefined;
  const link = listLink(consoleUrl, "spend");
  return {
    title: percent >= 100 ? "selfhost: budget spent" : `selfhost: ${percent}% of a budget spent`,
    body: [
      `${message}.`,
      ...(suggestion ? [suggestion] : []),
      link ? `Spend: ${link}` : "See it with selfhost spend.",
    ].join("\n"),
    type: percent >= 100 ? "failure" : "warning",
  };
}

/** The budget owner's daily digest. Amounts in USD. */
export interface SpendDigest {
  /** Each budget the owner holds, with spend in its current period. */
  budgets: {
    team: string;
    period: "day" | "week" | "month";
    limit_usd: number;
    spent_usd: number;
  }[];
  /** Spend in the last 24 hours by person, most first. */
  top_spenders: { person: string; team: string; usd: number }[];
  /** Teams whose last 24 hours most outgrew their daily average of the 7 days before. */
  growing_teams: { team: string; last_day_usd: number; daily_average_usd: number }[];
  /** Runs whose gateway key hit its cap in the last 24 hours. */
  capped_runs: { team: string; run_id: string; limit_usd: number }[];
}

/** Dollars with cents, or with as many places as a small amount (a test cap of $0.002) needs. */
const usd = (value: number) => {
  if (value === 0 || Math.abs(value) >= 0.01) return `$${value.toFixed(2)}`;
  const places = Math.min(8, 1 - Math.floor(Math.log10(Math.abs(value))));
  return `$${value.toFixed(places)}`;
};

export function isEmptyDigest(digest: SpendDigest): boolean {
  return (
    digest.top_spenders.length === 0 &&
    digest.growing_teams.length === 0 &&
    digest.capped_runs.length === 0 &&
    digest.budgets.every((budget) => budget.spent_usd === 0)
  );
}

export function spendDigestMessage(digest: SpendDigest, consoleUrl: string | undefined): Message {
  const lines: string[] = [];
  if (digest.budgets.length > 0) {
    lines.push("Budgets:");
    for (const b of digest.budgets) {
      const share = b.limit_usd > 0 ? Math.round((b.spent_usd / b.limit_usd) * 100) : 0;
      lines.push(
        `- ${b.team}: ${usd(b.spent_usd)} of ${usd(b.limit_usd)} this ${b.period} (${share}%)`,
      );
    }
  }
  lines.push("Top spenders, last 24 hours:");
  if (digest.top_spenders.length === 0) lines.push("- none");
  for (const s of digest.top_spenders) lines.push(`- ${s.person} (${s.team}): ${usd(s.usd)}`);
  if (digest.growing_teams.length > 0) {
    lines.push("Fastest-growing teams:");
    for (const t of digest.growing_teams) {
      lines.push(
        `- ${t.team}: ${usd(t.last_day_usd)} in the last 24 hours, against ${usd(t.daily_average_usd)} a day before`,
      );
    }
  }
  if (digest.capped_runs.length > 0) {
    lines.push("Runs that hit their cap:");
    for (const r of digest.capped_runs) {
      lines.push(`- ${plainId(r.run_id) ?? "a run"} (${r.team}), cap ${usd(r.limit_usd)}`);
    }
  }
  const link = listLink(consoleUrl, "spend");
  lines.push(link ? `Spend: ${link}` : "See it with selfhost spend.");
  return { title: "selfhost: daily spend digest", body: lines.join("\n"), type: "info" };
}

export function testMessage(person: string): Message {
  return {
    title: "selfhost: test notification",
    body: `This target works. Alerts and digests for ${person} will arrive here.`,
    type: "info",
  };
}
