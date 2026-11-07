import type { ReviewItem } from "@selfhost/schema";

/** Thrown when an action needs an open item and this one is answered, dismissed or expired. */
export class AlreadyAnsweredError extends Error {
  override name = "AlreadyAnsweredError";
  /** The item as it is now. */
  readonly item: ReviewItem;

  constructor(item: ReviewItem) {
    super(`Review item ${item.id} is ${item.state}, not open`);
    this.item = item;
  }
}

/** Thrown when no item has this id, or it belongs to another team. */
export class ReviewItemNotFoundError extends Error {
  override name = "ReviewItemNotFoundError";
  readonly id: string;

  constructor(id: string) {
    super(`No review item ${id}`);
    this.id = id;
  }
}

/** Thrown for an invalid action or query. Nothing was written. */
export class ReviewInputError extends Error {
  override name = "ReviewInputError";
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}
