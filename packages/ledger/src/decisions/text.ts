import type { LedgerEvent } from "@selfhost/schema";
import { decisionPaths } from "./record.js";
import type { DecisionPage } from "./store.js";

/** "  label: value", with later lines of a multi-line value indented under it. */
function field(label: string, value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  const [first = "", ...rest] = value.trimEnd().split(/\r?\n/);
  return [`  ${label}: ${first}`, ...rest.map((line) => `    ${line}`)];
}

function headline(event: LedgerEvent): string {
  const decision = event.decision;
  const verdict = decision?.verdict ?? "unknown";
  if (event.kind === "policy.evaluated") {
    const mode = decision?.mode ? ` (${decision.mode})` : "";
    return `${event.id}  ${event.ts}  ${verdict} by rule ${decision?.rule_id ?? "unknown"}${mode}`;
  }
  return `${event.id}  ${event.ts}  ${verdict} by ${decision?.by ?? event.actor.id}`;
}

/** One decision or rule verdict as plain text: its id first, then what, why and links. */
export function renderDecision(event: LedgerEvent, replacedBy: string[] = []): string {
  const decision = event.decision;
  const question = event.data?.question;
  const paths = decisionPaths(event);
  // Files and pull requests have their own lines; a command or URL target is shown as is.
  const target = event.target;
  const other = target && target.type !== "file" && target.type !== "pr" ? target : undefined;
  const prUrl = event.links?.pr_url ?? (target?.type === "pr" ? target.value : undefined);
  const lines = [
    headline(event),
    ...field("question", typeof question === "string" ? question : undefined),
    ...field("reason", decision?.reason),
    ...field("rule", event.kind === "policy.evaluated" ? undefined : decision?.rule_id),
    ...field("item", decision?.item_id ?? event.links?.item_id),
    ...field("run", event.run_id),
    ...field("repo", event.repo),
    ...field("files", paths.length > 0 ? paths.join(", ") : undefined),
    ...field(other?.type ?? "target", other?.value),
    ...field("pr", prUrl),
    ...field("commit", event.links?.commit_sha),
    ...field("run url", event.links?.run_url),
    ...field("replaces", decision?.replaces_event_id),
    ...field("replaced by", replacedBy.length > 0 ? replacedBy.join(", ") : undefined),
  ];
  return lines.join("\n");
}

/**
 * A page of decisions as plain text, newest first, for terminals and agents: the HTTP API's
 * format=text, `selfhost decisions` and the MCP tool all print this.
 */
export function renderDecisions(page: DecisionPage): string {
  if (page.events.length === 0) return "No decisions match.";
  const count = page.events.length;
  const blocks = page.events.map((event) =>
    renderDecision(event, page.replacedBy[event.id.toLowerCase()]),
  );
  const more = page.nextCursor ? [`next_cursor: ${page.nextCursor}`] : [];
  return [
    `${count} decision${count === 1 ? "" : "s"}, newest first.`,
    "",
    blocks.join("\n\n"),
    ...(more.length > 0 ? ["", ...more] : []),
  ].join("\n");
}
