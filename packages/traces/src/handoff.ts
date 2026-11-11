import {
  HANDOFF_FILES_MAX,
  type HandoffTurn,
  handoffOf,
  type LedgerEvent,
  maskSecrets,
  type RedactionPattern,
} from "@selfhost/schema";

const LINE_MAX = 200;

const firstLine = (text: string) => {
  const line = text.split("\n").find((part) => part.trim() !== "") ?? "";
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 3)}...` : line;
};

const order = (a: LedgerEvent, b: LedgerEvent) =>
  Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id);

/**
 * One line for an event a person picking up the run would want to read, or undefined for the
 * ones they would not (cost, tool results, hook bookkeeping). The event is already redacted, so
 * a prompt's text shows only while log_prompts kept it.
 */
export function turnText(event: LedgerEvent): string | undefined {
  const input = event.tool?.input_summary ?? event.target?.value;
  switch (event.kind) {
    case "prompt.submitted": {
      const prompt = event.data?.prompt;
      return typeof prompt === "string" && prompt.trim() !== ""
        ? `Prompt: ${firstLine(prompt)}`
        : "Prompt (text not logged)";
    }
    case "tool.called":
      return `${event.tool?.name ?? "Tool"}${input ? `: ${firstLine(input)}` : ""}`;
    case "approval.requested":
      return `Asked a person${input ? `: ${firstLine(input)}` : ""}`;
    case "decision.recorded": {
      const decision = event.decision;
      const reason = decision?.reason ? `: ${firstLine(decision.reason)}` : "";
      return `Decision ${decision?.verdict ?? "recorded"}${decision?.by ? ` by ${decision.by}` : ""}${reason}`;
    }
    case "policy.evaluated": {
      const verdict = event.decision?.verdict;
      if (verdict !== "block" && verdict !== "ask") return undefined;
      const did = verdict === "block" ? "blocked" : "asked a person about";
      const mode = event.decision?.mode === "observe" ? "would have " : "";
      return `Rule ${event.decision?.rule_id ?? ""} ${mode}${did}${input ? ` ${firstLine(input)}` : " a call"}`.replace(
        "  ",
        " ",
      );
    }
    case "commit.created":
      return `Commit ${event.links?.commit_sha?.slice(0, 12) ?? ""}`.trim();
    case "pr.opened":
      return `Opened ${event.links?.pr_url ?? "a pull request"}`;
    case "alert.raised":
      return `Alert: ${String(event.data?.alert ?? "")}`;
    case "session.ended":
      return "Session ended";
    case "run.handed_off": {
      const handoff = handoffOf(event);
      return handoff
        ? `Handed from ${handoff.previous_owner} to ${handoff.owner}`
        : "Handed to another person";
    }
    default:
      return undefined;
  }
}

/**
 * The run's last `count` turns, oldest first, each one line masked again under `patterns`, so a
 * value the team's [[redaction]] patterns name stays masked even in text written before them.
 * Each tool call (by its tool_use_id) shows once, however many copies of it were stored.
 */
export function lastTurns(
  events: readonly LedgerEvent[],
  count: number,
  patterns: readonly RedactionPattern[] = [],
): HandoffTurn[] {
  const turns: HandoffTurn[] = [];
  // A tool call reported by both the hook and the session log, or by two ledgers, shows once.
  const calls = new Set<string>();
  for (const event of [...events].sort(order)) {
    const call = event.kind === "tool.called" ? event.data?.tool_use_id : undefined;
    if (typeof call === "string" && call !== "") {
      const key = `${event.agent?.vendor ?? ""}\n${event.session_id ?? ""}\n${call}`;
      if (calls.has(key)) continue;
      calls.add(key);
    }
    const text = turnText(event);
    if (text !== undefined) {
      turns.push({ ts: event.ts, kind: event.kind, text: maskSecrets(text, patterns).text });
    }
  }
  return turns.slice(-count);
}

/** Files the run's tool calls named, in the order they were first touched. */
export function touchedFiles(events: readonly LedgerEvent[]): string[] {
  const files: string[] = [];
  for (const event of [...events].sort(order)) {
    if (event.kind !== "tool.called" || event.target?.type !== "file") continue;
    const path = event.target.value;
    if (!files.includes(path)) files.push(path);
    if (files.length >= HANDOFF_FILES_MAX) break;
  }
  return files;
}
