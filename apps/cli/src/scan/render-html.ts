import { CONTEXT_READER_NAMES } from "@selfhost/agents";
import { percent, plural, tokens, usd } from "../format.js";
import {
  bothText,
  CONTEXT_ROWS,
  contextPath,
  contextRows,
  duplicateText,
  GIT_NUMBERS,
  LOAD_WORDS,
  listText,
  readerNames,
  singleAgentText,
} from "./render-text.js";
import type { ScanReport } from "./report.js";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for HTML and XML. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const e = escapeXml;

/** Bar colors per agent; shared with the share card. */
export const AGENT_COLORS: Record<string, string> = {
  claude_code: "#d97757",
  codex: "#3b82f6",
  opencode: "#8b5cf6",
  goose: "#14b8a6",
  cursor: "#eab308",
  copilot: "#ec4899",
  other: "#64748b",
  unattributed: "#94a3b8",
};

const color = (vendor: string) => AGENT_COLORS[vendor] ?? "#64748b";

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f7f7f5; --card: #ffffff; --fg: #1c1c1a; --muted: #6b6b66; --line: #e4e4df;
  --accent: #c2410c; --warn-bg: #fff4ed; --track: #ecece8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121211; --card: #1b1b19; --fg: #ededea; --muted: #9a9a93; --line: #2c2c29;
    --accent: #fb923c; --warn-bg: #2a1d14; --track: #2c2c29;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-text-size-adjust: 100%;
}
main { max-width: 960px; margin: 0 auto; padding: 32px 16px 48px; }
header p { margin: 0; }
.eyebrow { color: var(--muted); font-size: 13px; letter-spacing: .04em; text-transform: uppercase; }
h1 { font-size: 28px; line-height: 1.2; margin: 6px 0 8px; letter-spacing: -.01em; }
h2 { font-size: 17px; margin: 0 0 12px; }
.meta { color: var(--muted); }
.nw { white-space: nowrap; }
section { margin-top: 32px; }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; min-width: 0; }
.label { color: var(--muted); font-size: 13px; margin: 0 0 6px; }
.big { font-size: 28px; font-weight: 650; line-height: 1.1; margin: 0; font-variant-numeric: tabular-nums; }
.sub { color: var(--muted); font-size: 13px; margin: 6px 0 0; }
.note { background: var(--warn-bg); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--track); margin: 12px 0 10px; }
.bar span { display: block; height: 100%; }
.legend { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.legend li { display: flex; gap: 8px; align-items: center; justify-content: space-between; padding: 2px 0; overflow-wrap: anywhere; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 6px; flex: none; }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
table { border-collapse: collapse; width: 100%; font-size: 14px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 500; font-size: 12px; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; }
td.wrap { white-space: normal; min-width: 220px; }
.mini { display: inline-block; vertical-align: middle; width: 60px; height: 6px; border-radius: 3px; background: var(--track); margin-left: 8px; overflow: hidden; }
.mini span { display: block; height: 100%; background: var(--accent); }
.leaks { display: grid; gap: 10px; }
.leak h3 { font-size: 15px; margin: 0; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.leak h3 span { color: var(--accent); font-variant-numeric: tabular-nums; }
.leak p { margin: 6px 0 0; }
.rule { color: var(--muted); font-size: 13px; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
footer { margin-top: 40px; color: var(--muted); font-size: 13px; border-top: 1px solid var(--line); padding-top: 16px; }
footer p { margin: 4px 0; }
footer strong { color: var(--fg); font-weight: 600; }
a { color: inherit; }
`;

function tile(label: string, big: string, sub: string, extra = ""): string {
  return `<div class="card"><p class="label">${e(label)}</p><p class="big">${e(big)}</p>${extra}<p class="sub">${e(sub)}</p></div>`;
}

function gitSection(report: ScanReport): string {
  const { git } = report;
  if (git.status !== "joined") {
    const text =
      git.status === "needs_repo"
        ? `The ${GIT_NUMBERS} need a git repo. Run selfhost scan --repo <dir>.`
        : `Could not join the sessions with git in ${git.repo}, so the ${GIT_NUMBERS} are not shown.`;
    return `<section><h2>Who wrote the code</h2><p class="note">${e(text)}</p></section>`;
  }
  const shares = git.commit_share ?? [];
  const commits = shares.reduce((total, row) => total + row.commits, 0);
  const lead = shares.find((row) => row.vendor !== "unattributed");
  const bar = `<div class="bar" role="img" aria-label="Share of commits by agent">${shares
    .filter((row) => row.share > 0)
    .map(
      (row) =>
        `<span style="width:${(row.share * 100).toFixed(2)}%;background:${color(row.vendor)}" title="${e(row.agent)} ${percent(row.share)}"></span>`,
    )
    .join("")}</div>`;
  const legend = `<ul class="legend">${shares
    .map(
      (row) =>
        `<li><span><i class="dot" style="background:${color(row.vendor)}"></i>${e(row.agent)}</span><span>${percent(row.share)} (${row.commits})</span></li>`,
    )
    .join("")}</ul>`;
  const merges = git.unreviewed_merges;
  const idle = git.no_commit_spend;
  const prs = (merges?.prs ?? [])
    .slice(0, 8)
    .map((pr) => `<a href="${e(pr.url)}">#${pr.number}</a>`)
    .join(", ");
  return `<section><h2>Who wrote the code${git.repo ? ` in ${e(git.repo)}` : ""}</h2><div class="grid">
${tile("Commits by agent", lead ? `${percent(lead.share)} ${lead.agent}` : "No agent commits", `${commits} commits in this window`, bar + legend)}
${tile("Agent PRs merged with no review", `${merges?.count ?? 0} of ${merges?.merged ?? 0}`, "no approval, or approved with no comments on a large diff", prs ? `<p class="sub">${prs}</p>` : "")}
${tile("Spend on sessions with no commit", usd(idle?.usd ?? 0), `${percent(idle?.share ?? 0)} of spend, ${plural(idle?.sessions ?? 0, "session")}`)}
</div></section>`;
}

function costSection(report: ScanReport): string {
  const { totals, cost } = report;
  const rows = cost.by_model
    .map(
      (row) =>
        `<tr><td><i class="dot" style="background:${color(row.vendor)}"></i>${e(row.agent)}</td><td><code>${e(row.model ?? "unknown")}</code></td><td class="num">${row.requests}</td><td class="num">${tokens(row.tokens)}</td><td class="num">${usd(row.usd)}</td><td class="num">${percent(row.share)}<span class="mini"><span style="width:${(row.share * 100).toFixed(2)}%"></span></span></td></tr>`,
    )
    .join("");
  const byAgent = cost.by_agent
    .map((row) =>
      tile(row.agent, usd(row.usd), `${percent(row.share)} of spend, ${row.requests} requests`),
    )
    .join("");
  return `<section><h2>Cost by agent and model</h2><div class="grid">
${tile("Total spend", usd(totals.usd), `${tokens(totals.tokens)} tokens, ${totals.requests} requests`)}
${byAgent}
</div>
<div class="scroll" style="margin-top:12px"><table><thead><tr><th>Agent</th><th>Model</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">USD</th><th class="num">Share</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function leakSection(report: ScanReport): string {
  const { totals } = report;
  if (report.leaks.length === 0) {
    return `<section><h2>Waste and leaks</h2><p class="note">No leaks found: no status loops, cache misses, retry loops or oversized context.</p></section>`;
  }
  const cards = report.leaks
    .map(
      (leak) =>
        `<div class="card leak"><h3>${e(leak.title)}<span>${usd(leak.usd)} · ${percent(leak.share)}</span></h3><p>${e(leak.detail)}</p><p class="rule">Rule: ${e(leak.rule)}.</p></div>`,
    )
    .join("");
  return `<section><h2>Waste and leaks</h2><div class="grid" style="margin-bottom:12px">
${tile("Spend with a leak", usd(totals.leak_usd), `${percent(totals.leak_share)} of spend, each request counted once`)}
</div><div class="leaks">${cards}</div></section>`;
}

function topSection(report: ScanReport): string {
  if (report.top_sessions.length === 0) return "";
  const rows = report.top_sessions
    .map(
      (session, index) =>
        `<tr><td>${index + 1}</td><td class="num">${usd(session.usd)}</td><td>${e(session.agent)}</td><td>${e(session.project ?? "-")}</td><td>${e(session.start.slice(0, 10))}</td><td><code>${e(session.session_id.slice(0, 8))}</code></td><td class="num">${session.requests}</td><td class="wrap">${e(session.reason)}</td></tr>`,
    )
    .join("");
  return `<section><h2>Most expensive sessions</h2><div class="scroll"><table><thead><tr><th></th><th class="num">USD</th><th>Agent</th><th>Project</th><th>Day</th><th>Session</th><th class="num">Requests</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function forecastSection(report: ScanReport): string {
  const forecast = report.forecast;
  if (!forecast) return "";
  const runsOut = forecast.runs_out_at
    ? `runs out ${forecast.runs_out_at.slice(0, 10)}`
    : "lasts the period";
  return `<section><h2>Plan forecast</h2><div class="grid">${tile(forecast.plan, percent(forecast.used_share), `of the limit used; ${runsOut} (period ends ${forecast.period_end.slice(0, 10)})`)}</div></section>`;
}

function contextSection(report: ScanReport): string {
  const section = report.context;
  if (section.files.length === 0) {
    return `<section><h2>Context files</h2><p class="note">No CLAUDE.md, AGENTS.md, rules, skills or MCP configs found in the repository or the home folder.</p></section>`;
  }
  const rows = contextRows(section);
  const body = rows
    .slice(0, CONTEXT_ROWS)
    .map(
      (file) =>
        `<tr><td><code>${e(contextPath(file))}</code></td><td>${e(LOAD_WORDS[file.load])}</td><td class="num">${file.mcp_servers || file.always_tokens === 0 ? "-" : tokens(file.always_tokens)}</td><td class="num">${file.sessions_per_week.toFixed(1)}</td><td class="num">${usd(file.usd_per_week)}</td><td class="wrap">${e(readerNames(file.readers))}</td></tr>`,
    )
    .join("");
  const more =
    rows.length > CONTEXT_ROWS
      ? `<p class="sub">And ${rows.length - CONTEXT_ROWS} more; selfhost scan --json lists them all.</p>`
      : "";
  const conflicts = section.conflicts
    .map((conflict) => {
      const both = bothText(conflict.same_agent, "get");
      return `<div class="card leak"><h3>${e(conflict.title)}</h3><p>${e(conflict.detail)}.${both ? ` ${e(both)}.` : ""}</p><p class="rule">Rule: ${e(conflict.rule)}.</p></div>`;
    })
    .join("");
  const items = (list: string[]) =>
    `<ul class="legend">${list.map((item) => `<li>${e(item)}</li>`).join("")}</ul>`;
  const duplicates = section.duplicates.length
    ? `<div class="card"><p class="label">Duplicates</p>${items(section.duplicates.map(duplicateText))}</div>`
    : "";
  const single = section.single_agent.length
    ? `<div class="card"><p class="label">Seen by one agent only (agents here: ${e(readerNames(section.agents_in_use))})</p>${items(
        section.single_agent.map(singleAgentText),
      )}</div>`
    : "";
  const unpriced = section.unpriced_agents.length
    ? ` ${listText(section.unpriced_agents.map((reader) => CONTEXT_READER_NAMES[reader]))} also read some of these files but keep no logs selfhost reads, so their sessions are not counted.`
    : "";
  return `<section><h2>Context files</h2><div class="grid">
${tile("Always-loaded context", `${usd(section.totals.usd_per_week)} a week`, `${tokens(Math.round(section.totals.tokens_per_week))} tokens a week across ${plural(section.totals.always_loaded, "file")}`)}
${tile("Conflicts", String(section.conflicts.length), "files that tell agents different things")}
${tile("Duplicates", String(section.duplicates.length), "copies of the same text that drift apart")}
</div>
<div class="scroll" style="margin-top:12px"><table><thead><tr><th>File</th><th>Load</th><th class="num">Tokens per session</th><th class="num">Sessions a week</th><th class="num">USD a week</th><th>Read by</th></tr></thead><tbody>${body}</tbody></table></div>${more}
${conflicts ? `<div class="leaks" style="margin-top:12px">${conflicts}</div>` : ""}
${duplicates || single ? `<div class="grid" style="margin-top:12px">${duplicates}${single}</div>` : ""}
<p class="sub">Tokens: ${e(section.tokenizer)}. Price: ${e(section.pricing)}.${e(unpriced)}</p></section>`;
}

/** One self-contained HTML page: agent share, unreviewed merges, cost, waste and context. */
export function renderHtml(report: ScanReport): string {
  const { totals } = report;
  const agents = listText(report.agents.map((agent) => agent.agent)) || "no agents";
  const body = [
    `<header><p class="eyebrow">selfhost scan</p><h1>Coding agent audit, <span class="nw">${e(report.from)}</span> to <span class="nw">${e(report.to)}</span></h1><p class="meta">${plural(totals.sessions, "session")} from ${e(agents)} · ${usd(totals.usd)} spend · totals and file paths only, no prompts or code</p></header>`,
    gitSection(report),
    totals.sessions > 0 ? costSection(report) : "",
    totals.sessions > 0 ? leakSection(report) : "",
    topSection(report),
    forecastSection(report),
    contextSection(report),
    `<footer><p>${e(report.credit)}</p><p><strong>${e(report.next)}</strong></p></footer>`,
  ]
    .filter((part) => part !== "")
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>selfhost scan ${e(report.from)} to ${e(report.to)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
