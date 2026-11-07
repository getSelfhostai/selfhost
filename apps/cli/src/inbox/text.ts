import type { ReviewItem } from "@selfhost/schema";
import { duration } from "../alerts/text.js";
import { plural, table } from "../format.js";
import type { QueuedAction } from "./store.js";
import type { ReplayEntry } from "./sync.js";

const SHORT = 8;
const compact = (id: string) => id.replaceAll("-", "").toLowerCase();

/** The shortest prefix, at least 8 characters, that tells each id apart from the others. */
export function shortIds(ids: readonly string[]): Map<string, string> {
  const short = new Map<string, string>();
  for (const id of ids) {
    let length = SHORT;
    const taken = (n: number) =>
      ids.some((other) => other !== id && other.startsWith(id.slice(0, n)));
    while (length < id.length && (taken(length) || id[length - 1] === "-")) length++;
    short.set(id, id.slice(0, length));
  }
  return short;
}

const FULL_ID = /^[0-9a-f]{32}$/;

/** A full item id as typed, or undefined when it is a prefix. */
export function fullId(arg: string): string | undefined {
  const hex = compact(arg.trim());
  if (!FULL_ID.test(hex)) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The one item whose id starts with `arg` (dashes and case ignored). */
export function resolveId(arg: string, items: readonly ReviewItem[], where: string): string {
  const full = fullId(arg);
  if (full) return full;
  const prefix = compact(arg.trim());
  if (!/^[0-9a-f]{4,}$/.test(prefix)) {
    throw new Error(`Expected an item id or at least 4 characters of one, got "${arg}"`);
  }
  const matches = items.filter((item) => compact(item.id).startsWith(prefix));
  if (matches.length === 1 && matches[0]) return matches[0].id;
  if (matches.length === 0) throw new Error(`No open item ${where} starts with ${arg}`);
  const ids = matches.map((item) => item.id).join(", ");
  throw new Error(`${arg} matches ${matches.length} items, type more of the id: ${ids}`);
}

/** "already answered by bob@example.com: deny", "already expired". */
export function closedText(item: ReviewItem): string {
  if (item.answer) return `already answered by ${item.answer.by}: ${item.answer.verdict}`;
  return `already ${item.state}`;
}

const age = (item: ReviewItem, now: Date) => duration(now.getTime() - Date.parse(item.created_at));

/** The list as aligned columns, with the shortest ids that tell the items apart. */
export function itemRows(items: readonly ReviewItem[], now: Date): string[][] {
  const short = shortIds(items.map((item) => item.id));
  return [
    ["ID", "KIND", "RISK", "AGE", "TITLE"],
    ...items.map((item) => [
      short.get(item.id) ?? item.id,
      item.blocking ? `${item.kind}, blocking` : item.kind,
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
): void {
  if (items.length === 0) {
    write("Nothing to review.");
    return;
  }
  const blocking = items.filter((item) => item.blocking).length;
  write(`${plural(items.length, "item")} to review${blocking ? `, ${blocking} blocking` : ""}:`);
  table(itemRows(items, now), write);
  write("");
  write("Act on one with selfhost inbox approve|deny|snooze|open <id>.");
}

/** Everything `inbox open` shows about an item, its brief last. */
export function itemLines(item: ReviewItem, now: Date): string[] {
  const facts = [
    `${item.kind}${item.blocking ? ", an agent is waiting" : ""}`,
    `risk ${item.risk.score}`,
    item.state,
    `${age(item, now)} old`,
  ];
  const lines = [item.title, `${item.id} · ${facts.join(" · ")}`];
  if (item.repo) lines.push(`Repo: ${item.repo}`);
  if (item.agent) lines.push(`Agent: ${item.agent.name ?? item.agent.vendor}`);
  if (item.owners.length > 0) lines.push(`Owners: ${item.owners.join(", ")}`);
  if (item.url) lines.push(`Link: ${item.url}`);
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
  return `${action.action} ${action.item_id.slice(0, SHORT)}${until}${reason}`;
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
