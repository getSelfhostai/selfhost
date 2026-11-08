import { PACKAGE_RULE_PREFIX, type TracerTool } from "@selfhost/schema";
import {
  BRIEF_MARKER,
  BRIEF_SECTIONS,
  type Brief,
  type BriefBlock,
  type BriefCommand,
  type BriefSection,
  type CommandResult,
  type RiskyLine,
} from "./types.js";

/** GitHub's limit on an issue or pull request comment body, in characters. */
export const GITHUB_COMMENT_LIMIT = 65_536;

/** Items each list shows before "and N more"; they shrink when the comment would be too long. */
export const LIST_LIMITS = {
  plan: 15,
  risky: 30,
  files: 100,
  commands: 50,
  tests: 30,
  blocked: 30,
  trace: 20,
} as const;

type Limits = Record<keyof typeof LIST_LIMITS, number>;

/** Lists longer than this go inside a collapsed <details> block. */
const COLLAPSE_AFTER = 10;

const TRACER_NAMES: Record<TracerTool, string> = {
  langfuse: "Langfuse",
  phoenix: "Phoenix",
  datadog: "Datadog",
  otlp: "the tracer",
};

const TITLES: Record<BriefSection, string> = {
  task: "Task",
  plan: "Plan",
  risky_lines: "Lines to look at",
  files: "Files touched",
  commands: "Commands run",
  tests: "Tests run",
  blocked: "Blocked actions",
  cost: "Cost",
  trace: "Trace",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** An inline code span that holds any text, backticks included, on one line. */
export function code(text: string): string {
  const value = text.replace(/\r?\n/g, " ");
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** A fenced block that shows text as typed: no Markdown, no HTML, no mentions. */
function block(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** Plain text on one line, with the characters that would start Markdown or HTML escaped. */
export function escapeText(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/[\\`*[\]<>|~]/g, "\\$&")
    .replace(/(?<!\w)_|_(?!\w)/g, "\\_");
}

function link(text: string, url: string | undefined): string {
  return url ? `[${code(text)}](${url})` : code(text);
}

function list<T>(items: T[], cap: number, line: (item: T) => string): string[] {
  const shown = items.slice(0, cap).map(line);
  if (items.length > cap) shown.push(`- and ${items.length - cap} more`);
  return shown;
}

function collapsible(summary: string, lines: string[], count: number): string[] {
  if (count <= COLLAPSE_AFTER) return lines;
  return [`<details><summary>${summary}</summary>`, "", ...lines, "", "</details>"];
}

const RESULT_TEXT: Record<CommandResult, string> = {
  passed: "passed",
  failed: "failed",
  unknown: "finished, outcome not recorded",
  no_result: "no result recorded",
};

const RESULT_COUNT: Record<CommandResult, string> = {
  passed: "passed",
  failed: "failed",
  unknown: "with no recorded outcome",
  no_result: "with no recorded result",
};

const LAST_RUN: Record<CommandResult, string> = {
  passed: "The last run passed.",
  failed: "The last run failed.",
  unknown: "The last run finished with no recorded outcome.",
  no_result: "The last run has no recorded result.",
};

function riskyLine(item: RiskyLine): string {
  const where = link(item.line === undefined ? item.path : `${item.path}:${item.line}`, item.url);
  switch (item.kind) {
    case "protected_path":
      return `- Protected path: ${where} matches ${code(item.detail)}`;
    case "new_dependency":
      return `- New dependency ${code(item.detail)}: ${where}`;
    case "deleted_test_file":
      return `- Deleted test file: ${where}${item.detail ? `, ${item.detail}` : ""}`;
    case "deleted_test":
      return `- Deleted test: ${where} ${code(item.detail)}`;
    case "skipped_test":
      return /\.only$|^f\w+$/.test(item.detail)
        ? `- Focused test, so the rest of its file is skipped: ${where} ${code(item.detail)}`
        : `- Skipped test: ${where} ${code(item.detail)}`;
  }
}

function blockedLine(item: BriefBlock): string {
  // The package guard's verdicts are about an install: a block stops it, an ask flags it.
  const install = item.rule_id.startsWith(PACKAGE_RULE_PREFIX) ? " the install" : "";
  const verb =
    item.verdict === "block"
      ? item.mode === "enforce"
        ? `blocked${install}`
        : `would have blocked${install} (observe mode)`
      : install
        ? item.mode === "enforce"
          ? "flagged the install and stopped it for approval"
          : "flagged the install (observe mode)"
        : item.mode === "enforce"
          ? "stopped for approval"
          : "would have stopped for approval (observe mode)";
  const what = item.target
    ? ` ${code(item.target)}`
    : item.tool
      ? ` a ${code(item.tool)} call`
      : "";
  const irreversible = item.irreversible ? ", an irreversible action" : "";
  const reason = item.reason ? `: ${escapeText(item.reason)}` : "";
  return `- ${code(item.rule_id)} ${verb}${what}${irreversible}${reason}`;
}

/** Identical commands on one line, in the order they first ran. */
function commandLines(
  commands: BriefCommand[],
): { command: string; runs: number; failed: number }[] {
  const grouped = new Map<string, { command: string; runs: number; failed: number }>();
  for (const command of commands) {
    const entry = grouped.get(command.command) ?? { command: command.command, runs: 0, failed: 0 };
    entry.runs += 1;
    if (command.result === "failed") entry.failed += 1;
    grouped.set(command.command, entry);
  }
  return [...grouped.values()];
}

const ESTIMATED = {
  none: "",
  some: " Part of it is estimated from token counts.",
  all: " Estimated from token counts.",
} as const;

const usd = (value: number) => (value > 0 && value < 0.01 ? "under $0.01" : `$${value.toFixed(2)}`);

function count(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** "2026-10-12 09:00 to 09:18 UTC", with the second date only when the day differs. */
function span(start: string, end: string): string {
  const [from, to] = [new Date(start), new Date(end)];
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return `${start} to ${end}`;
  const [day, time] = from.toISOString().slice(0, 16).split("T");
  const [endDay, endTime] = to.toISOString().slice(0, 16).split("T");
  return `${day} ${time} to ${endDay === day ? "" : `${endDay} `}${endTime} UTC`;
}

function section(brief: Brief, name: BriefSection, limits: Limits): string[] {
  const lines: string[] = [];
  switch (name) {
    case "task": {
      const { task } = brief;
      if (task.title) {
        const from = task.titleFrom === "commit" ? " (first commit subject; no pull request)" : "";
        lines.push(`**${escapeText(task.title)}**${from}`);
      }
      if (task.description) lines.push("", block(task.description));
      if (task.prompt) lines.push("", "First prompt:", "", block(task.prompt));
      break;
    }
    case "plan": {
      const { steps, updates } = brief.plan;
      if (steps.length > 0) {
        lines.push(
          "From the description:",
          "",
          ...list(steps, limits.plan, (s) => `- ${escapeText(s)}`),
        );
      }
      if (updates.length > 0) {
        const tools = [...new Set(updates.map((u) => u.tool))].sort().map(code).join(", ");
        if (lines.length > 0) lines.push("");
        const times = updates.length === 1 ? "once" : `${updates.length} times`;
        lines.push(`The run updated its plan ${times} (${tools}).`);
        const summaries = updates.filter((u) => u.summary);
        if (summaries.length > 0) {
          lines.push(
            "",
            ...list(summaries, limits.plan, (u) => `- ${escapeText(u.summary ?? "")}`),
          );
        }
      }
      break;
    }
    case "risky_lines":
      lines.push(...list(brief.risky, limits.risky, riskyLine));
      break;
    case "files": {
      const { files } = brief;
      if (files.length === 0) break;
      const additions = files.reduce((sum, f) => sum + f.additions, 0);
      const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
      const protectedCount = files.filter((f) => f.protected).length;
      const under = protectedCount > 0 ? `, ${protectedCount} under protected paths` : "";
      lines.push(`${plural(files.length, "file")}, +${additions} -${deletions}${under}.`, "");
      const items = list(files, limits.files, (file) => {
        const from = file.previousPath ? ` from ${code(file.previousPath)}` : "";
        const flag = file.protected ? ", protected path" : "";
        return `- ${link(file.path, file.url)} ${file.status}${from}, +${file.additions} -${file.deletions}${flag}`;
      });
      lines.push(...collapsible(plural(files.length, "file"), items, files.length));
      break;
    }
    case "commands": {
      const { commands } = brief;
      if (commands.length === 0) break;
      const failed = commands.filter((c) => c.result === "failed").length;
      lines.push(
        `${plural(commands.length, "command")}${failed > 0 ? `, ${failed} failed` : ""}.`,
        "",
      );
      const grouped = commandLines(commands);
      const items = list(grouped, limits.commands, (entry) => {
        const parts = [
          ...(entry.runs > 1 ? [`${entry.runs} times`] : []),
          ...(entry.failed > 0 ? [entry.runs > 1 ? `${entry.failed} failed` : "failed"] : []),
        ];
        return `- ${code(entry.command)}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
      });
      lines.push(...collapsible(plural(grouped.length, "distinct command"), items, grouped.length));
      break;
    }
    case "tests": {
      const { tests } = brief;
      const last = tests[tests.length - 1];
      if (!last) break;
      const counts = (["passed", "failed", "unknown", "no_result"] as const)
        .map((result) => ({ result, n: tests.filter((t) => t.result === result).length }))
        .filter(({ n }) => n > 0)
        .map(({ result, n }) => `${n} ${RESULT_COUNT[result]}`);
      lines.push(
        `${plural(tests.length, "test run")}: ${counts.join(", ")}. ${LAST_RUN[last.result]}`,
        "",
        ...list(tests, limits.tests, (test) => {
          const error = test.error ? `, ${code(test.error)}` : "";
          return `- ${code(test.command)}: ${RESULT_TEXT[test.result]}${error}`;
        }),
      );
      break;
    }
    case "blocked":
      lines.push(...list(brief.blocked, limits.blocked, blockedLine));
      break;
    case "cost": {
      const { cost } = brief;
      if (!cost) break;
      const models = cost.models.length > 0 ? ` (${cost.models.map(code).join(", ")})` : "";
      lines.push(
        `${usd(cost.usd)} across ${plural(cost.sessions, "session")}: ${plural(cost.requests, "model request")}, ${count(cost.tokens)} tokens${models}.${ESTIMATED[cost.estimated]}`,
      );
      break;
    }
    case "trace":
      lines.push(
        ...list(brief.trace, limits.trace, (session) => {
          const about = [
            ...(session.agent ? [session.agent] : []),
            plural(session.events, "event"),
            ...(session.start ? [span(session.start, session.end)] : []),
          ].join(", ");
          const where = session.url
            ? `[run view](${session.url})`
            : `run ${code(session.command ?? "")} where its ledger is`;
          const traced = session.tracerUrl
            ? `, [trace in ${TRACER_NAMES[session.tracer ?? "otlp"]}](${session.tracerUrl})`
            : "";
          return `- ${code(session.id)} (${about}): ${where}${traced}`;
        }),
      );
      break;
  }
  for (const note of brief.notes[name] ?? []) {
    if (lines.length > 0) lines.push("");
    lines.push(escapeText(note));
  }
  return [`### ${TITLES[name]}`, "", ...lines];
}

function header(brief: Brief): string {
  const { agent, target, files } = brief;
  const who = agent
    ? `Agent: ${code(`${agent.vendor}${agent.model ? ` ${agent.model}` : ""}`)}.`
    : "No agent attributed.";
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const sessions = brief.trace.length > 0 ? `, ${plural(brief.trace.length, "agent session")}` : "";
  return `${who} ${plural(target.commits.length, "commit")}, ${plural(files.length, "file")}, +${additions} -${deletions}${sessions}.`;
}

function render(brief: Brief, limits: Limits): string {
  const parts = [BRIEF_MARKER, "## Review brief", "", header(brief)];
  for (const name of BRIEF_SECTIONS) parts.push("", ...section(brief, name, limits));
  return `${parts.join("\n")}\n`;
}

function scaled(factor: number): Limits {
  return Object.fromEntries(
    Object.entries(LIST_LIMITS).map(([key, value]) => [key, Math.floor(value * factor)]),
  ) as Limits;
}

/**
 * The brief as a GitHub comment in Markdown, starting with BRIEF_MARKER. Every section is
 * present, with a note when it has nothing to show. Long lists end in "and N more", and shrink
 * until the comment fits in `maxChars` (GitHub's limit by default). The same brief always
 * renders to the same text.
 */
export function renderBrief(brief: Brief, options: { maxChars?: number } = {}): string {
  const max = options.maxChars ?? GITHUB_COMMENT_LIMIT;
  for (const factor of [1, 0.5, 0.25, 0.1, 0]) {
    const text = render(brief, scaled(factor));
    if (text.length <= max) return text;
  }
  const cut = "\n\nThe brief was cut to fit the comment size limit.\n";
  return `${render(brief, scaled(0)).slice(0, Math.max(0, max - cut.length))}${cut}`;
}

/**
 * One paragraph for the check run summary: the agent and the size of the change, how many lines
 * to look at, then the tests and blocked actions, or why no run was found. The same brief always
 * gives the same text.
 */
export function summarizeBrief(brief: Brief): string {
  const parts = [header(brief)];
  parts.push(
    brief.risky.length > 0
      ? `${plural(brief.risky.length, "line")} to look at.`
      : "Nothing flagged to look at.",
  );
  if (brief.trace.length === 0) {
    parts.push(...(brief.notes.trace ?? []).map(escapeText));
  } else {
    const last = brief.tests[brief.tests.length - 1];
    parts.push(
      last
        ? `${plural(brief.tests.length, "test run")}. ${LAST_RUN[last.result]}`
        : "No tests ran in this run.",
    );
    if (brief.blocked.length > 0) parts.push(`${plural(brief.blocked.length, "blocked action")}.`);
  }
  return parts.join(" ");
}

/** true for a comment body that is a brief, so the delivery edits it instead of posting again. */
export function isBriefComment(body: string): boolean {
  return body.startsWith(BRIEF_MARKER);
}
