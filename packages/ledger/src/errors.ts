export interface LedgerFieldError {
  /** Position of the event in the batch, or -1 when the batch itself is wrong. */
  index: number;
  /** Field path, for example actor.kind. */
  path: string;
  message: string;
}

/** Thrown by append when any event in the batch is invalid. Nothing was written. */
export class LedgerValidationError extends Error {
  override name = "LedgerValidationError";
  readonly errors: LedgerFieldError[];

  constructor(errors: LedgerFieldError[]) {
    const first = errors[0];
    const where = !first
      ? ""
      : first.index < 0
        ? `: ${first.path}: ${first.message}`
        : `: events[${first.index}] ${first.path}: ${first.message}`;
    super(`Invalid events, nothing was written${where}`);
    this.errors = errors;
  }
}

/** Thrown by query when a filter value is invalid, for example a malformed cursor. */
export class LedgerQueryError extends Error {
  override name = "LedgerQueryError";
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}
