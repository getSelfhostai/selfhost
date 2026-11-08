import { percent, plural, roiSummary, tokens, usd } from "../format.js";
import { AGENT_COLORS, escapeXml as e } from "./render-html.js";
import { listText } from "./render-text.js";
import type { ScanReport } from "./report.js";

const WIDTH = 1200;
const HEIGHT = 630;
const LEFT = 64;
const BAR_WIDTH = WIDTH - LEFT * 2;
const FONT = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

function stat(x: number, label: string, value: string): string {
  return `<text x="${x}" y="350" class="label">${e(label)}</text><text x="${x}" y="402" class="value">${e(value)}</text>`;
}

function gitPart(report: ScanReport): string {
  const { git } = report;
  if (git.status !== "joined") {
    return `<text x="${LEFT}" y="500" class="muted">Commit share, unreviewed merges and spend on sessions with no commit need a git repo.</text>`;
  }
  const shares = (git.commit_share ?? []).filter((row) => row.share > 0);
  let x = LEFT;
  const segments = shares
    .map((row) => {
      const width = row.share * BAR_WIDTH;
      const rect = `<rect x="${x.toFixed(1)}" y="460" width="${width.toFixed(1)}" height="16" fill="${AGENT_COLORS[row.vendor] ?? "#64748b"}"/>`;
      x += width;
      return rect;
    })
    .join("");
  const legend = shares
    .slice(0, 4)
    .map((row) => `${row.agent} ${percent(row.share)}`)
    .join("  ·  ");
  return `<clipPath id="bar"><rect x="${LEFT}" y="460" width="${BAR_WIDTH}" height="16" rx="8"/></clipPath><rect x="${LEFT}" y="460" width="${BAR_WIDTH}" height="16" rx="8" fill="#2c2c29"/><g clip-path="url(#bar)">${segments}</g><text x="${LEFT}" y="520" class="small">${e(legend)} of commits${git.repo ? ` in ${e(git.repo)}` : ""}</text>`;
}

/** One line under the commit share: merged lines by agents and their revert and rework rate. */
function provenancePart(report: ScanReport): string {
  const p = report.provenance;
  if (!p || p.totals.lines === 0 || report.git.status !== "joined") return "";
  const rate = p.totals.agent_revert_rework_rate;
  const text = `Agents wrote ${percent(p.totals.agent_share)} of merged lines${rate === null ? "" : `; ${percent(rate)} of them reverted or reworked within ${p.window_days} days`}`;
  return `<text x="${LEFT}" y="442" class="small">${e(text)}</text>`;
}

/** One line under the headline: cost per merged agent PR, with a git join. */
function roiPart(report: ScanReport): string {
  if (!report.roi || report.git.status !== "joined") return "";
  return `<text x="${LEFT}" y="300" class="small">${e(`Cost per merged agent PR: ${roiSummary(report.roi)}`)}</text>`;
}

function contextPart(report: ScanReport): string {
  const section = report.context;
  if (section.files.length === 0) return "";
  const text = `Always-loaded context ${usd(section.totals.usd_per_week)} a week  ·  ${plural(section.conflicts.length, "conflict")}  ·  ${plural(section.duplicates.length, "duplicate")} across ${plural(section.totals.files, "context file")}`;
  return `<text x="${LEFT}" y="556" class="small">${e(text)}</text>`;
}

/** An SVG image card with the scan's totals, for sharing. */
export function renderSvg(report: ScanReport): string {
  const { totals, git } = report;
  const agents = listText(report.agents.map((agent) => agent.agent)) || "no agents";
  const stats =
    git.status === "joined"
      ? [
          stat(
            LEFT,
            "Spend with a leak",
            `${usd(totals.leak_usd)} (${percent(totals.leak_share)})`,
          ),
          stat(
            420,
            "Agent PRs merged with no review",
            `${git.unreviewed_merges?.count ?? 0} of ${git.unreviewed_merges?.merged ?? 0}`,
          ),
          stat(776, "Spend on sessions with no commit", usd(git.no_commit_spend?.usd ?? 0)),
        ]
      : [
          stat(
            LEFT,
            "Spend with a leak",
            `${usd(totals.leak_usd)} (${percent(totals.leak_share)})`,
          ),
          stat(420, "Requests", String(totals.requests)),
          stat(776, "Tokens", tokens(totals.tokens)),
        ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="selfhost scan: ${e(usd(totals.usd))} on coding agents from ${e(report.from)} to ${e(report.to)}">
<style>
text { font-family: ${FONT}; fill: #ededea; }
.muted { fill: #9a9a93; font-size: 26px; }
.label { fill: #9a9a93; font-size: 22px; }
.value { font-size: 40px; font-weight: 650; }
.small { fill: #c9c9c3; font-size: 24px; }
.foot { fill: #7d7d77; font-size: 20px; }
</style>
<rect width="${WIDTH}" height="${HEIGHT}" fill="#141413"/>
<rect x="0" y="0" width="${WIDTH}" height="6" fill="#fb923c"/>
<text x="${LEFT}" y="84" class="muted">selfhost scan</text>
<text x="${WIDTH - LEFT}" y="84" class="muted" text-anchor="end">${e(report.from)} to ${e(report.to)}</text>
<text x="${LEFT}" y="210" font-size="104" font-weight="700">${e(usd(totals.usd))}</text>
<text x="${LEFT}" y="262" class="muted">on coding agents, ${plural(totals.sessions, "session")} from ${e(agents)}</text>
${roiPart(report)}
${stats.join("\n")}
${provenancePart(report)}
${gitPart(report)}
${contextPart(report)}
<text x="${LEFT}" y="590" class="foot">Totals only, no prompts or code. Token counts and prices via ccusage.</text>
</svg>
`;
}
