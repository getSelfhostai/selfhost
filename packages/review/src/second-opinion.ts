import type { Queryable } from "@selfhost/ledger";
import {
  type LedgerEvent,
  overallSecondOpinion,
  type ResolvedSelfhostConfig,
  type ReviewItem,
  SECOND_OPINION_EVENT_KIND,
  type SecondOpinion,
  secondOpinionOf,
  secondOpinionPull,
} from "@selfhost/schema";
import { deliveryOf } from "./build.js";
import { mergeOpinions, withSecondOpinionRisk } from "./opinions.js";
import { pullRequestKey } from "./signals.js";
import { getItem, latestItemByKey, openItemByKey, type StoredItem, updateItem } from "./store.js";

const ATTEMPTS = 3;

const json = <T>(value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as T;

interface Context {
  config: ResolvedSelfhostConfig;
  now: Date;
}

const overall = (opinions: readonly SecondOpinion[]) => {
  const second_opinion = overallSecondOpinion(opinions);
  return second_opinion ? { second_opinion } : {};
};

/** Writes opinions onto an open pr item. false when another writer changed it first. */
async function attach(
  tx: Queryable,
  stored: StoredItem,
  opinions: readonly SecondOpinion[],
  ctx: Context,
): Promise<boolean> {
  const second_opinions = mergeOpinions(stored.item.second_opinions, opinions);
  const risk = withSecondOpinionRisk(stored.item.risk, second_opinions, ctx.config);
  const ids = [...new Set([...stored.item.source_event_ids, ...opinions.map((o) => o.event_id)])];
  const item: ReviewItem = {
    ...stored.item,
    updated_at: ctx.now.toISOString(),
    source_event_ids: ids,
    second_opinions,
    ...overall(second_opinions),
    risk,
    delivery: deliveryOf({ ...stored.item, risk }, ctx.config),
  };
  return updateItem(tx, { ...stored, item });
}

/** The open pr item for a pull request: in the event's team, or in any team for an event with none. */
async function openPullItem(
  tx: Queryable,
  team: string | null,
  url: string,
): Promise<StoredItem | undefined> {
  const key = pullRequestKey(url);
  const open = await openItemByKey(tx, team, key);
  if (open || team !== null) return open;
  const latest = await latestItemByKey(tx, {}, key);
  return latest?.item.state === "open" ? latest : undefined;
}

export interface OpinionResult {
  itemId?: string;
  updated: boolean;
}

/**
 * A review.submitted event: the reviewer's verdict joins the open pr item of its pull request,
 * replacing that tool's earlier one, and raises the item's risk when it asks for changes or
 * flags something severe. No open item, nothing changes: a pr item opened later picks the
 * opinion up from the ledger (`catchUpOpinions`).
 */
export async function applySecondOpinion(
  tx: Queryable,
  event: LedgerEvent,
  team: string | null,
  ctx: Context,
): Promise<OpinionResult> {
  const opinion = secondOpinionOf(event);
  const url = secondOpinionPull(event);
  if (!opinion || !url) return { updated: false };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const stored = await openPullItem(tx, team, url);
    if (!stored) return { updated: false };
    if (await attach(tx, stored, [opinion], ctx)) return { itemId: stored.item.id, updated: true };
  }
  return { updated: false };
}

/**
 * Second opinions on a pr item's pull request that the ledger had before the item: a reviewer can
 * finish before the laptop that opened the pull request syncs its pr.opened event.
 */
export async function catchUpOpinions(
  tx: Queryable,
  itemId: string,
  ctx: Context,
): Promise<boolean> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const stored = await getItem(tx, itemId, {});
    if (stored?.item.kind !== "pr" || stored.item.state !== "open" || !stored.item.url) {
      return false;
    }
    const rows = await tx.query<{ body: unknown }>(
      `SELECT body FROM events
       WHERE kind = $1 AND coalesce(body#>>'{links,pr_url}', body#>>'{target,value}') = $2
         AND ($3::text IS NULL OR coalesce(team, '') IN ($3::text, ''))
       ORDER BY ts, id`,
      [SECOND_OPINION_EVENT_KIND, stored.item.url, stored.team],
    );
    const known = new Set(stored.item.source_event_ids);
    const opinions = rows
      .map((row) => secondOpinionOf(json<LedgerEvent>(row.body)))
      .filter((opinion): opinion is SecondOpinion => !!opinion && !known.has(opinion.event_id));
    if (opinions.length === 0) return false;
    if (await attach(tx, stored, opinions, ctx)) return true;
  }
  return false;
}
