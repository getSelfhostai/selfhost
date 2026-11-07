import type {
  DecisionResponse,
  PersonVerdict,
  ReviewItem,
  ReviewItemState,
  ReviewItemsPage,
} from "@selfhost/schema";

/**
 * The review list as `@selfhost/review` exports it, copied here as a type until that package
 * lands: the local store in solo mode and the team server's API in team mode both implement it.
 */
export interface ReviewList {
  list(query: {
    state?: ReviewItemState;
    owner?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ReviewItemsPage>;
  get(id: string): Promise<ReviewItem | undefined>;
  /** Throws when the item is not open (409 over HTTP, with the current item). */
  decide(
    id: string,
    input: { verdict: PersonVerdict; by: string; reason?: string; at?: string },
  ): Promise<DecisionResponse>;
  snooze(id: string, input: { by: string; until: string }): Promise<ReviewItem>;
}
