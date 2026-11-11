import type { Handoff } from "@selfhost/schema";
import { usd } from "../format.js";

const AGENT_NAMES: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  goose: "Goose",
  cursor: "Cursor",
  copilot: "Copilot",
};

export const agentName = (handoff: Pick<Handoff, "agent">) =>
  (handoff.agent && AGENT_NAMES[handoff.agent.vendor]) ?? "the agent";

/** Where the brief goes in the new owner's clone; .git/info/exclude keeps it out of commits. */
export const BRIEF_DIR = ".selfhost/handoff";

export const briefPath = (handoff: Pick<Handoff, "id">) => `${BRIEF_DIR}/${handoff.id}.md`;

/** How the new owner picks the session up: the agent's own resume, or a new session. */
export interface ResumePlan {
  /** The command to run in the clone. */
  command: string;
  /** true when it resumes the session itself, with its history. */
  native: boolean;
  /** One line on why it is or is not a native resume. */
  why: string;
}

const list = (items: readonly string[], max: number) => {
  const shown = items.slice(0, max).map((item) => `- ${item}`);
  if (items.length > max) shown.push(`- and ${items.length - max} more`);
  return shown;
};

/**
 * The handoff brief: a short Markdown file for the new owner and the agent they start, with
 * what the run did, where its work is, what is still open and how to carry on. Everything in it
 * comes from the handoff record, which the server redacted.
 */
export function renderBrief(handoff: Handoff, resume: ResumePlan): string {
  const agent = agentName(handoff);
  const lines = [
    `# Handoff: ${agent} run ${handoff.run_id}`,
    "",
    `${handoff.from} handed this run to ${handoff.to} on ${handoff.created_at}${handoff.by !== handoff.from ? ` (handed over by ${handoff.by})` : ""}.`,
  ];
  if (handoff.note) lines.push("", "## Note", "", handoff.note);
  lines.push("", "## Where the work is", "");
  if (handoff.repo) lines.push(`- Repository: ${handoff.repo}`);
  if (handoff.branch) {
    lines.push(
      `- Branch: ${handoff.branch}${handoff.commit ? ` at ${handoff.commit.slice(0, 12)}` : ""}`,
    );
  } else if (handoff.commit) {
    lines.push(`- Commit: ${handoff.commit.slice(0, 12)} (no branch named)`);
  }
  if (handoff.pushed === false) {
    lines.push("- Some commits were not pushed when it was handed over: ask for them.");
  }
  if (handoff.uncommitted.length > 0) {
    lines.push(
      `- ${handoff.uncommitted.length} file(s) had changes that were not committed, and stayed on the previous owner's machine:`,
      ...list(handoff.uncommitted, 20).map((line) => `  ${line}`),
    );
  }
  lines.push(
    `- Cost so far: ${usd(handoff.cost_usd)} (${handoff.tokens.toLocaleString("en-US")} tokens)`,
  );
  lines.push(`- Run in the console: ${handoff.run_url}`);
  if (handoff.files.length > 0) {
    lines.push("", "## Files the run touched", "", ...list(handoff.files, 40));
  }
  if (handoff.open_items.length > 0) {
    lines.push(
      "",
      "## Still open on the review list",
      "",
      ...handoff.open_items.map(
        (item) => `- ${item.title} (${item.kind}${item.blocking ? ", the agent waits on it" : ""})`,
      ),
    );
  }
  if (handoff.turns.length > 0) {
    lines.push(
      "",
      "## Last turns",
      "",
      ...handoff.turns.map((turn) => `- ${turn.ts.slice(11, 16)} ${turn.text}`),
    );
  }
  lines.push("", "## Carry on", "", resume.why, "", "```", resume.command, "```", "");
  return lines.join("\n");
}
