import { PAGE_LIMIT_MAX, REVIEW_ITEM_STATES, type ReviewItem } from "@selfhost/schema";
import { type Fetch, TeamApiError, TeamClient } from "../team/client.js";
import type { ReviewList } from "./review-list.js";
import { closedText } from "./text.js";

/** An answer or snooze on an item that is no longer open, with the item as it is now. */
export class ReviewItemClosedError extends Error {
  override name = "ReviewItemClosedError";

  constructor(readonly item: ReviewItem) {
    super(`${item.id} was ${closedText(item)}`);
  }
}

const isReviewItem = (value: unknown): value is ReviewItem =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ReviewItem).id === "string" &&
  typeof (value as ReviewItem).state === "string";

/** The closed item an error carries, from this module or from the local review list. */
export function closedItem(error: unknown): ReviewItem | undefined {
  const item = (error as { item?: unknown } | null)?.item;
  return isReviewItem(item) && item.state !== "open" ? item : undefined;
}

/**
 * The review list on the team server, over its /v1 API with the person token from
 * `selfhost join`. The server records each decision as the token's person, at its own clock,
 * and writes the decision.recorded event itself.
 */
export function httpReviewList(server: string, token: string, fetch: Fetch): ReviewList {
  const client = new TeamClient(server, token, fetch);

  const list: ReviewList = {
    list: (query) => client.reviewItems(query),

    // The API has no single-item read, so this pages through each state's list.
    async get(id) {
      for (const state of REVIEW_ITEM_STATES) {
        let cursor: string | undefined;
        do {
          const page = await client.reviewItems({ state, limit: PAGE_LIMIT_MAX, cursor });
          const found = page.items.find((item) => item.id === id);
          if (found) return found;
          cursor = page.next_cursor ?? undefined;
        } while (cursor);
      }
      return undefined;
    },

    async decide(id, { verdict, reason }) {
      try {
        return await client.decideReviewItem(id, { verdict, ...(reason ? { reason } : {}) });
      } catch (error) {
        throw await closedError(error, id);
      }
    },

    async snooze(id, { until }) {
      try {
        return await client.snoozeReviewItem(id, until);
      } catch (error) {
        throw await closedError(error, id);
      }
    },
  };

  /** A 409 becomes a ReviewItemClosedError, reading the item when the answer did not carry it. */
  async function closedError(error: unknown, id: string): Promise<unknown> {
    if (!(error instanceof TeamApiError) || error.status !== 409) return error;
    const carried = (error.body as { item?: unknown } | undefined)?.item;
    const item = isReviewItem(carried) ? carried : await list.get(id).catch(() => undefined);
    return item && item.state !== "open" ? new ReviewItemClosedError(item) : error;
  }

  return list;
}
