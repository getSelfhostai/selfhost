import { CONTEXT_READER_NAMES, type ContextReader } from "@selfhost/agents";
import { percent, plural, roiSummary, tokens, usd } from "../format.js";
import { provenanceSummary } from "../provenance-text.js";
import type {
  ContextConflict,
  ContextDuplicate,
  ContextFileRow,
  ContextSection,
  SingleAgentRule,
} from "./context/index.js";
import type { ScanReport } from "./report.js";

export const GIT_NUMBERS =
  "commit share per agent, agent PRs merged with no review and spend on sessions with no commit";

/** "a", "a and b", "a, b and c". */
export function listText(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function table(rows: string[][], right: ReadonlySet<number>): string[] {
  const widths = rows[0]?.map((_, col) => Math.max(...rows.map((row) => row[col]?.length ?? 0)));
  return rows.map((row) =>
    row
      .map((cell, col) =>
        right.has(col) ? cell.padStart(widths?.[col] ?? 0) : cell.padEnd(widths?.[col] ?? 0),
      )
      .join("  ")
      .trimEnd(),
  );
}

export function commitShareText(report: ScanReport): string {
  return (report.git.commit_share ?? [])
    .map((row) => `${row.agent} ${percent(row.share)} (${row.commits})`)
    .join(", ");
}

function gitLines(report: ScanReport): string[] {
  const { git } = report;
  if (git.status === "needs_repo") {
    return [`Git: ${GIT_NUMBERS} need a git repo. Run selfhost scan --repo <dir>.`];
  }
  if (git.status === "not_joined") {
    return [
      `Git: could not join the sessions with git in ${git.repo}, so ${GIT_NUMBERS} are not shown.`,
    ];
  }
  const merges = git.unreviewed_merges;
  const idle = git.no_commit_spend;
  return [
    `Git: ${git.repo}`,
    ...table(
      [
        ["Commits by agent", commitShareText(report) || "no commits in this window"],
        ["Agent PRs merged with no review", `${merges?.count ?? 0} of ${merges?.merged ?? 0}`],
        [
          "Spend on sessions with no commit",
          `${usd(idle?.usd ?? 0)}, ${percent(idle?.share ?? 0)} of spend, ${plural(idle?.sessions ?? 0, "session")}`,
        ],
        ...(report.roi
          ? [["Cost per merged agent PR", `${roiSummary(report.roi)} (selfhost roi)`]]
          : []),
        ...(report.provenance
          ? [["Merged lines", `${provenanceSummary(report.provenance)} (selfhost provenance)`]]
          : []),
      ],
      new Set(),
    ).map((line) => `  ${line}`),
  ];
}

function costLines(report: ScanReport): string[] {
  const { totals, cost } = report;
  const lines = [
    `Cost by agent and model: ${usd(totals.usd)}, ${tokens(totals.tokens)} tokens, ${totals.requests} requests`,
  ];
  if (cost.by_model.length === 0) return lines;
  const rows = [
    ["AGENT", "MODEL", "REQUESTS", "TOKENS", "USD", "SHARE"],
    ...cost.by_model.map((row) => [
      row.agent,
      row.model ?? "unknown",
      String(row.requests),
      tokens(row.tokens),
      usd(row.usd),
      percent(row.share),
    ]),
  ];
  lines.push(...table(rows, new Set([2, 3, 4, 5])).map((line) => `  ${line}`));
  if (cost.by_agent.length > 1) {
    const parts = cost.by_agent.map(
      (row) => `${row.agent} ${usd(row.usd)} (${percent(row.share)})`,
    );
    lines.push(`  By agent: ${parts.join(", ")}`);
  }
  return lines;
}

function leakLines(report: ScanReport): string[] {
  if (report.leaks.length === 0) {
    return ["Leaks: none found (status loops, cache misses, retry loops, oversized context)."];
  }
  const { totals } = report;
  const lines = [
    `Leaks: ${usd(totals.leak_usd)} of spend (${percent(totals.leak_share)}) in requests these rules picked out`,
  ];
  for (const leak of report.leaks) {
    lines.push(`  ${leak.title}: ${leak.detail}`);
    lines.push(`    Rule: ${leak.rule}.`);
  }
  return lines;
}

function topLines(report: ScanReport): string[] {
  if (report.top_sessions.length === 0) return [];
  const rows = [
    ["", "USD", "AGENT", "PROJECT", "DAY", "SESSION", "WHY"],
    ...report.top_sessions.map((session, index) => [
      `${index + 1}.`,
      usd(session.usd),
      session.agent,
      session.project ?? "-",
      session.start.slice(0, 10),
      session.session_id.slice(0, 8),
      session.reason,
    ]),
  ];
  return [`Most expensive sessions`, ...table(rows, new Set([1])).map((line) => `  ${line}`)];
}

function forecastLines(report: ScanReport): string[] {
  const forecast = report.forecast;
  if (!forecast) return [];
  const runsOut = forecast.runs_out_at
    ? `runs out ${forecast.runs_out_at.slice(0, 10)}`
    : "lasts the period";
  return [
    `Plan forecast: ${forecast.plan}, ${percent(forecast.used_share)} of the limit used; ${runsOut} (period ends ${forecast.period_end.slice(0, 10)}).`,
  ];
}

/** How many context files the text and HTML tables show; --json lists them all. */
export const CONTEXT_ROWS = 12;

export const readerNames = (readers: readonly ContextReader[]) =>
  readers.length === 0
    ? "no agent"
    : readers.map((reader) => CONTEXT_READER_NAMES[reader]).join(", ");

export const LOAD_WORDS: Record<ContextFileRow["load"], string> = {
  always: "always",
  description: "description",
  on_demand: "on demand",
};

/** Costliest first, then the most tokens in every session, then by path. */
export function contextRows(section: ContextSection): ContextFileRow[] {
  return [...section.files].sort(
    (a, b) =>
      b.usd_per_week - a.usd_per_week ||
      b.always_tokens - a.always_tokens ||
      a.path.localeCompare(b.path),
  );
}

export function contextPath(file: ContextFileRow): string {
  return file.mcp_servers ? `${file.path} (MCP: ${file.mcp_servers.join(", ")})` : file.path;
}

/** "Cursor gets both", "Codex and Cursor get both". */
export function bothText(readers: readonly ContextReader[], verb: "get" | "load"): string {
  if (readers.length === 0) return "";
  const names = listText(readers.map((reader) => CONTEXT_READER_NAMES[reader]));
  return `${names} ${readers.length === 1 ? `${verb}s` : verb} both`;
}

export function conflictText(conflict: ContextConflict): string {
  const both = bothText(conflict.same_agent, "get");
  return `${conflict.title}: ${conflict.detail}.${both ? ` ${both}.` : ""}`;
}

export function singleAgentText(rule: SingleAgentRule): string {
  const what = rule.server ? `MCP server ${rule.server} in ${rule.path}` : rule.path;
  return `${what}: ${CONTEXT_READER_NAMES[rule.reader]} only`;
}

export function duplicateText(dup: ContextDuplicate): string {
  const how =
    dup.match === "exact"
      ? "exact copies"
      : `${dup.shared_lines} shared lines, ${percent(dup.overlap)} of the shorter file`;
  const twice = bothText(dup.loaded_twice_by, "load");
  return `${listText(dup.files)}: ${how}${twice ? `; ${twice}` : ""}`;
}

export function contextSummary(section: ContextSection): string {
  return (
    `${plural(section.totals.files, "file")}, ${section.totals.always_loaded} in every session, ` +
    `${usd(section.totals.usd_per_week)} a week, ${plural(section.conflicts.length, "conflict")}, ` +
    `${plural(section.duplicates.length, "duplicate")}`
  );
}

function contextLines(report: ScanReport): string[] {
  const section = report.context;
  if (section.files.length === 0) {
    return [
      "Context: no CLAUDE.md, AGENTS.md, rules, skills or MCP configs found in the repository or the home folder.",
    ];
  }
  const rows = contextRows(section);
  const lines = [`Context: ${contextSummary(section)}`];
  const grid = [
    ["PATH", "LOAD", "TOKENS/SESSION", "SESSIONS/WK", "USD/WK", "READ BY"],
    ...rows
      .slice(0, CONTEXT_ROWS)
      .map((file) => [
        contextPath(file),
        LOAD_WORDS[file.load],
        file.mcp_servers || file.always_tokens === 0 ? "-" : tokens(file.always_tokens),
        file.sessions_per_week.toFixed(1),
        usd(file.usd_per_week),
        readerNames(file.readers),
      ]),
  ];
  lines.push(...table(grid, new Set([2, 3, 4])).map((line) => `  ${line}`));
  if (rows.length > CONTEXT_ROWS) {
    lines.push(`  and ${rows.length - CONTEXT_ROWS} more (selfhost scan --json lists them all)`);
  }
  if (section.duplicates.length > 0) {
    lines.push("  Duplicates");
    for (const dup of section.duplicates) lines.push(`    ${duplicateText(dup)}`);
  }
  if (section.conflicts.length > 0) {
    lines.push("  Conflicts");
    for (const conflict of section.conflicts) {
      lines.push(`    ${conflictText(conflict)}`, `      Rule: ${conflict.rule}.`);
    }
  }
  if (section.single_agent.length > 0) {
    lines.push(
      `  Seen by one agent only (agents here: ${readerNames(section.agents_in_use)})`,
      ...section.single_agent.map((rule) => `    ${singleAgentText(rule)}`),
    );
  }
  if (section.unpriced_agents.length > 0) {
    lines.push(
      `  ${listText(section.unpriced_agents.map((reader) => CONTEXT_READER_NAMES[reader]))} also read some of these files but keep no logs selfhost reads, so their sessions are not counted.`,
    );
  }
  lines.push(`  Tokens: ${section.tokenizer}.`, `  Price: ${section.pricing}.`);
  return lines;
}

/**
 * Terminal text: the git numbers first, then cost, leaks, the most expensive sessions and the
 * context files.
 */
export function renderText(report: ScanReport, written: string[] = []): string[] {
  const { totals } = report;
  const agents = listText(report.agents.map((agent) => agent.agent));
  const header =
    totals.sessions === 0
      ? `selfhost scan: ${report.from} to ${report.to}. No Claude Code or Codex session logs in this window.`
      : `selfhost scan: ${report.from} to ${report.to}, ${plural(totals.sessions, "session")} from ${agents}`;
  const sections = [
    [header],
    gitLines(report),
    totals.sessions === 0 ? [] : costLines(report),
    totals.sessions === 0 ? [] : leakLines(report),
    topLines(report),
    forecastLines(report),
    contextLines(report),
    [...written, report.credit, report.next],
  ].filter((section) => section.length > 0);
  return sections.flatMap((section, index) => (index === 0 ? section : ["", ...section]));
}
