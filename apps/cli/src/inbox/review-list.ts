import type { ReviewList as FullReviewList } from "@selfhost/review";

/**
 * The part of the review list both inbox modes act on: the local store in solo mode and the
 * team server's API in team mode.
 */
export type ReviewList = Pick<FullReviewList, "list" | "get" | "decide" | "snooze">;
