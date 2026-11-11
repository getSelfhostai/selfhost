import { type ReviewItem, shortId, shortIds } from "@selfhost/schema";
import { duration } from "../alerts/text.js";
import { plural, table } from "../format.js";
import type { QueuedAction } from "./store.js";
import type { ReplayEntry } from "./sync.js";

const compact = (id: string) => id.replaceAll("-", "").toLowerCase();

export { shortId, shortIds };

const FULL_ID = /^[0-9a-f]{32}$/;

/** A full item id as typed, or undefined when it is a prefix. */
export function fullId(arg: string): string | undefined {
  const hex = compact(arg.trim());
  if (!FULL_ID.test(hex)) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The one item whose id starts or ends with `arg` (dashes and case ignored). When several do,
 * the one the caller may act on (`mine`), since that is the list they were shown; when that
 * still leaves more than one, the error lists only theirs, never other people's items.
 */
export function resolveId(
  arg: string,
  items: readonly ReviewItem[],
  where: string,
  mine: (item: ReviewItem) => boolean = () => true,
): string {
  const full = fullId(arg);
  if (full) return full;
  const part = compact(arg.trim());
  if (!/^[0-9a-f]{4,}$/.test(part)) {
    throw new Error(`Expected an item id or at least 4 characters of one, got "${arg}"`);
  }
  const matches = items.filter((item) => {
    const hex = compact(item.id);
    return hex.startsWith(part) || hex.endsWith(part);
  });
  if (matches.length === 1 && matches[0]) return matches[0].id;
  if (matches.length === 0) throw new Error(`No open item ${where} starts or ends with ${arg}`);
  const yours = matches.filter(mine);
  if (yours.length === 1 && yours[0]) return yours[0].id;
  if (yours.length === 0) {
    throw new Error(
      `${arg} matches ${matches.length} items, none of them yours to answer. Type more of the id, as selfhost inbox shows it.`,
    );
  }
  const ids = yours.map((item) => item.id).join(", ");
  throw new Error(`${arg} matches ${yours.length} of your items, type more of the id: ${ids}`);
}

/** "already answered by bob@example.com: deny", "already expired". */
export function closedText(item: ReviewItem): string {
  if (item.answer) return `already answered by ${item.answer.by}: ${item.answer.verdict}`;
  return `already ${item.state}`;
}

const age = (item: ReviewItem, now: Date) => duration(now.getTime() - Date.parse(item.created_at));

/** The kind as the list shows it: an exception item is a request, the call already denied. */
const kindText = (item: ReviewItem) =>
  item.kind === "exception" ? "exception requested" : item.kind;

/**
 * An exception the person's own agent asked for that went to nobody: they are the team's only
 * owner or admin, and nobody approves their own exception. The inbox shows it to them anyway,
 * since nobody else sees it, as one that needs another approver.
 */
export function needsAnotherApprover(item: ReviewItem, person: string | undefined): boolean {
  return (
    item.kind === "exception" &&
    item.state === "open" &&
    item.route?.step === "none" &&
    item.owners.length === 0 &&
    person !== undefined &&
    item.requested_by?.toLowerCase() === person.toLowerCase()
  );
}

/** What to do about an exception that needs another approver. */
export const ANOTHER_APPROVER_HOW =
  "Invite an admin to approve it (selfhost team invite, then selfhost team role <person> admin once they join), or set [review] self_approve_exceptions = true in the team's selfhost.toml (selfhost team policy push selfhost.toml).";

/** The refusal for approving one's own exception as the team's only owner or admin. */
export const SOLE_APPROVER_REFUSAL = `You cannot approve an exception your own agent asked for, and you are the team's only owner or admin, so nobody else can approve it either. ${ANOTHER_APPROVER_HOW}`;

/** The list as aligned columns, with the shortest ids that tell the items apart. */
export function itemRows(items: readonly ReviewItem[], now: Date, person?: string): string[][] {
  const short = shortIds(items.map((item) => item.id));
  const kind = (item: ReviewItem) =>
    needsAnotherApprover(item, person)
      ? `${kindText(item)}, needs another approver`
      : item.blocking
        ? `${kindText(item)}, blocking`
        : kindText(item);
  return [
    ["ID", "KIND", "RISK", "AGE", "TITLE"],
    ...items.map((item) => [
      short.get(item.id) ?? item.id,
      kind(item),
      String(item.risk.score),
      age(item, now),
      item.repo ? `${item.title} (${item.repo})` : item.title,
    ]),
  ];
}

export function writeItems(
  items: readonly ReviewItem[],
  now: Date,
  write: (line: string) => void,
  person?: string,
): void {
  if (items.length === 0) {
    write("Nothing to review.");
    return;
  }
  const blocking = items.filter((item) => item.blocking).length;
  write(`${plural(items.length, "item")} to review${blocking ? `, ${blocking} blocking` : ""}:`);
  table(itemRows(items, now, person), write);
  write("");
  write("Act on one with selfhost inbox approve|deny|snooze|open <id>.");
  if (items.some((item) => needsAnotherApprover(item, person))) {
    write(
      `Needs another approver: your own agent asked, and you are the team's only owner or admin, so the item went to nobody. You can deny it. ${ANOTHER_APPROVER_HOW}`,
    );
  }
}

/** Everything `inbox open` shows about an item, its brief last. */
export function itemLines(item: ReviewItem, now: Date): string[] {
  const facts = [
    `${kindText(item)}${item.blocking ? ", an agent is waiting" : ""}`,
    `risk ${item.risk.score}`,
    item.state,
    `${age(item, now)} old`,
  ];
  const lines = [item.title, `${item.id} · ${facts.join(" · ")}`];
  if (item.repo) lines.push(`Repo: ${item.repo}`);
  if (item.agent) lines.push(`Agent: ${item.agent.name ?? item.agent.vendor}`);
  if (item.owners.length > 0) lines.push(`Owners: ${item.owners.join(", ")}`);
  if (item.url) lines.push(`Link: ${item.url}`);
  if (item.route) {
    const { step, from, why } = item.route;
    lines.push(
      step === "none"
        ? `Routed to nobody${why ? `: ${why}` : ""}`
        : `Routed by ${from}${why ? `: ${why}` : ""}`,
    );
  }
  if (item.why) {
    const rule = item.why.rule_id ? ` (rule ${item.why.rule_id})` : "";
    lines.push(`Why${rule}: ${item.why.text}`);
  }
  for (const reason of item.risk.reasons) lines.push(`  - ${reason}`);
  if (item.answer) {
    const why = item.answer.reason ? `: ${item.answer.reason}` : "";
    lines.push(`Answered ${item.answer.verdict} by ${item.answer.by} at ${item.answer.at}${why}`);
  }
  if (item.brief) lines.push("", item.brief.trimEnd());
  return lines;
}

export function queuedText(action: QueuedAction): string {
  const until = action.until ? ` until ${action.until}` : "";
  const reason = action.reason ? ` (${action.reason})` : "";
  return `${action.action} ${shortId(action.item_id)}${until}${reason}`;
}

/** One line per replayed action. */
export function replayLines(results: readonly ReplayEntry[]): string[] {
  return results.map(({ queued, outcome, message }) => {
    const what = queuedText(queued);
    if (outcome === "applied") return `Synced queued ${what}.`;
    if (outcome === "conflict") return `Not applied: ${what}, ${message}.`;
    return `Dropped queued ${what}: ${message}.`;
  });
}
