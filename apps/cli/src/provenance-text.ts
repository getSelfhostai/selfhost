import type { ProvenanceReport } from "@selfhost/schema";
import { percent, plural, table } from "./format.js";
import { agentName } from "./scan/report.js";

const rateText = (rate: number | null) => (rate === null ? "-" : percent(rate));

export const authorName = (vendor: string, model: string | null) =>
  vendor === "unattributed"
    ? "unattributed"
    : model
      ? `${agentName(vendor)} (${model})`
      : agentName(vendor);

/** One line for `selfhost scan`. */
export function provenanceSummary(report: ProvenanceReport): string {
  const { totals } = report;
  if (totals.lines === 0) return "no merges to the main branch in this window";
  const rate = totals.agent_revert_rework_rate;
  const top = report.modules
    .filter((row) => row.agent_lines > 0)
    .slice(0, 3)
    .map((row) => `${row.module} ${row.agent_lines}`)
    .join(", ");
  return [
    `agents wrote ${totals.agent_lines} of ${plural(totals.lines, "merged line")} (${percent(totals.agent_share)})`,
    rate === null
      ? undefined
      : `${percent(rate)} of agent lines reverted or reworked within ${report.window_days} days`,
    top ? `most in ${top}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}

export const REWORK_RULE =
  "Rework: a later commit on the main branch changed or deleted the line within the window (fix-forward edits count). Revert: a commit that says it reverts the change, or one that removes all of it that was left and adds back no more than a tenth as many lines.";

/** Terminal text: totals, then by agent, by module, by person and vendor stats. */
export function provenanceText(report: ProvenanceReport): string[] {
  const out: string[] = [];
  const write = (line: string) => out.push(line);
  const indent = (line: string) => out.push(`  ${line}`);
  const { totals } = report;
  const where = report.branch
    ? `${report.repo ?? "repository"}, ${report.branch} at ${report.head?.slice(0, 12)}`
    : `${report.repo ?? "repository"} (${report.note ?? report.status})`;
  write(
    `selfhost provenance: ${where}, merges ${report.from.slice(0, 10)} to ${report.to.slice(0, 10)}`,
  );
  if (totals.lines === 0) {
    write("No lines merged to the main branch in this window.");
    return out;
  }
  write(
    `Lines merged: ${totals.lines}, ${totals.agent_lines} by agents (${percent(totals.agent_share)}), in ${plural(totals.landings, "merge")}.`,
  );
  if (totals.agent_revert_rework_rate !== null) {
    write(
      `Agent lines reverted or reworked within ${report.window_days} days of merge: ${(totals.agent_reverted_lines ?? 0) + (totals.agent_reworked_lines ?? 0)} of ${totals.agent_lines} (${percent(totals.agent_revert_rework_rate)}).`,
    );
  }
  write("");
  write("By agent and model");
  table(
    [
      ["AGENT", "LINES", "SHARE", "RUNS", "REVERTED", "REWORKED", "RATE", "IN WINDOW"],
      ...report.by_agent.map((row) => [
        authorName(row.vendor, row.model),
        String(row.lines),
        percent(row.share),
        String(row.runs),
        String(row.reverted_lines ?? "-"),
        String(row.reworked_lines ?? "-"),
        rateText(row.revert_rework_rate),
        String(row.open_lines ?? "-"),
      ]),
    ],
    indent,
    7,
  );
  if (report.modules.length > 0) {
    write("");
    write(
      `Modules by agent-written lines (flagged above ${percent(report.threshold)} with at least ${report.min_module_lines} agent lines)`,
    );
    table(
      [
        ["#", "MODULE", "LINES", "AGENT", "SHARE", "RATE", ""],
        ...report.modules.map((row) => [
          String(row.rank),
          row.module,
          String(row.lines),
          String(row.agent_lines),
          percent(row.agent_share),
          rateText(row.agent_revert_rework_rate),
          row.above_threshold ? "above threshold" : "",
        ]),
      ],
      indent,
      0,
    );
  }
  write("");
  write("By person");
  table(
    [
      ["PERSON", "LINES", "BY AGENTS", "SHARE"],
      ...report.by_person.map((row) => [
        row.person,
        String(row.lines),
        String(row.agent_lines),
        percent(row.agent_share),
      ]),
    ],
    indent,
    3,
  );
  if (report.vendor_reported.length > 0) {
    write("");
    write(
      `Vendor stats, as reported, not used above: ${report.vendor_reported
        .map(
          (row) =>
            `${agentName(row.vendor)} ${row.lines_added} added, ${row.lines_removed} removed`,
        )
        .join("; ")}`,
    );
  }
  write("");
  write(
    `Lines are non-blank lines that landed on ${report.branch ?? "the main branch"}; moved and reindented lines keep their author. ${REWORK_RULE}`,
  );
  return out;
}
