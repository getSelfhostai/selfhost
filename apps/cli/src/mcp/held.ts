import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ledger } from "@selfhost/ledger";
import { MCP_EXCEPTION_REQUEST, MCP_QUESTION_REQUEST, type ReviewList } from "@selfhost/review";
import {
  type AgentRef,
  type LedgerEvent,
  PAGE_LIMIT_MAX,
  REVIEW_ITEM_SCHEMA,
  type ReviewItem,
} from "@selfhost/schema";
import { feedDir } from "../tail/feed.js";

/**
 * What `selfhost import --watch` saves for the selfhost MCP server while it holds the embedded
 * ledger: every item an agent opened or asked about through selfhost mcp in the last day, in its
 * current state, so get_answer sees the answer. Written with the spend snapshot.
 */
export interface McpItemsSnapshot {
  schema: "selfhost.mcp_items/v1";
  written_at: string;
  pid: number;
  person: string;
  items: ReviewItem[];
}

/** How far back the snapshot looks for requests made through selfhost mcp. */
const SNAPSHOT_DAYS_MS = 24 * 60 * 60 * 1000;

const MCP_REQUESTS = new Set<unknown>([MCP_EXCEPTION_REQUEST, MCP_QUESTION_REQUEST]);

export const mcpItemsPath = (env: NodeJS.ProcessEnv, configPath: string) =>
  join(feedDir(env, configPath), "mcp-items.json");

/** Ids of the items `person`'s agents asked about through selfhost mcp since `from`. */
async function requestedItems(ledger: Ledger, person: string, from: Date): Promise<string[]> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await ledger.query({
      kind: "approval.requested",
      person,
      from: from.toISOString(),
      limit: PAGE_LIMIT_MAX,
      ...(cursor ? { cursor } : {}),
    });
    for (const event of page.events) {
      const id = event.links?.item_id?.toLowerCase();
      if (id && MCP_REQUESTS.has(event.data?.request)) ids.add(id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return [...ids];
}

/** Written to a temporary file and renamed, so a reader never sees half of it. */
export async function writeMcpItems(
  ledger: Ledger,
  list: Pick<ReviewList, "get">,
  person: string,
  path: string,
  now: Date,
): Promise<void> {
  const ids = await requestedItems(ledger, person, new Date(now.getTime() - SNAPSHOT_DAYS_MS));
  const items: ReviewItem[] = [];
  for (const id of ids) {
    const item = await list.get(id);
    if (item) items.push(item);
  }
  const snapshot: McpItemsSnapshot = {
    schema: "selfhost.mcp_items/v1",
    written_at: now.toISOString(),
    pid: process.pid,
    person,
    items,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readMcpItems(path: string): McpItemsSnapshot | undefined {
  try {
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as McpItemsSnapshot;
    return snapshot?.schema === "selfhost.mcp_items/v1" ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

/** The newer of two copies of one item, by updated_at. */
export function newer(a: ReviewItem | undefined, b: ReviewItem | undefined) {
  if (!a || !b) return a ?? b;
  return Date.parse(b.updated_at) > Date.parse(a.updated_at) ? b : a;
}

/**
 * The item a request spooled for the watcher opens or adds to, as the agent is told about it
 * before the watcher has imported it: open, owned by the person, the agent waiting on it.
 */
export function pendingItem(
  event: LedgerEvent,
  kind: "question" | "exception",
  title: string,
  person: string,
): ReviewItem {
  const agent: AgentRef | undefined = event.agent;
  return {
    id: event.links?.item_id ?? event.id,
    schema: REVIEW_ITEM_SCHEMA,
    kind,
    title,
    created_at: event.ts,
    updated_at: event.ts,
    state: "open",
    blocking: true,
    risk: { score: 0, reasons: [] },
    ...(event.repo ? { repo: event.repo } : {}),
    owners: [person],
    ...(agent ? { agent } : {}),
    ...(kind === "exception" ? { requested_by: person } : {}),
    source_event_ids: [event.id],
  };
}
