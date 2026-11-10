import type { LedgerWriter } from "@selfhost/importers";
import { type LedgerEvent, MAX_EVENT_BATCH, PERSON_VERDICTS } from "@selfhost/schema";
import { TeamApiError, type TeamClient } from "./client.js";

export interface RemoteWriterOptions {
  /** Person actors are sent as this person, the one the token belongs to. */
  person: string;
  /** Retries after the first attempt. Default 4. */
  retries?: number;
  /** Wait before the first retry, doubled for each one after. Default 500 ms. */
  baseDelayMs?: number;
  /** Longest wait between attempts, also the cap on Retry-After. Default 30 s. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RemoteTotals {
  sent: number;
  accepted: number;
  duplicates: number;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Worth another try: no answer, a timeout, rate limiting or a server error. */
function retryable(error: unknown): boolean {
  if (!(error instanceof TeamApiError)) return false;
  return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
}

/**
 * Sends events to the team server's POST /v1/events in batches of up to 1000, retrying with
 * exponential backoff when the server is unreachable, slow, rate limiting or failing. Event ids
 * are idempotency keys, so a batch sent twice is stored once. A refused batch (an invalid event,
 * a revoked token) is not retried.
 *
 * The local ledger keeps each event as it was imported; the copy sent here carries the joined
 * person as actor.id on person events, and as decision.by on a person's decisions, which is the
 * only person the server accepts for the token: a decision recorded here with --person for
 * someone else reaches the server as this person's own. Agent actors are sent unchanged.
 */
export class RemoteWriter implements LedgerWriter {
  readonly totals: RemoteTotals = { sent: 0, accepted: 0, duplicates: 0 };
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: TeamClient,
    private readonly options: RemoteWriterOptions,
  ) {
    this.retries = options.retries ?? 4;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.sleep = options.sleep ?? sleep;
  }

  /**
   * The API answers with counts, not ids, so the ids returned are split by position: the
   * counts are right, but in a batch with both new and known events the ids may not be.
   */
  async append(events: LedgerEvent[]): Promise<{ accepted: string[]; duplicates: string[] }> {
    const result = { accepted: [] as string[], duplicates: [] as string[] };
    for (let start = 0; start < events.length; start += MAX_EVENT_BATCH) {
      const batch = events.slice(start, start + MAX_EVENT_BATCH).map((e) => this.asPerson(e));
      const counts = await this.send(batch);
      const ids = batch.map((event) => event.id);
      result.accepted.push(...ids.slice(0, counts.accepted));
      result.duplicates.push(...ids.slice(counts.accepted));
      this.totals.sent += batch.length;
      this.totals.accepted += counts.accepted;
      this.totals.duplicates += counts.duplicates;
    }
    return result;
  }

  private async send(batch: LedgerEvent[]) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.pushEvents(batch);
      } catch (error) {
        if (!retryable(error) || attempt >= this.retries) throw error;
        const backoff = this.baseDelayMs * 2 ** attempt;
        const asked =
          error instanceof TeamApiError && error.retryAfter ? error.retryAfter * 1000 : 0;
        await this.sleep(Math.min(this.maxDelayMs, Math.max(backoff, asked)));
      }
    }
  }

  private asPerson(event: LedgerEvent): LedgerEvent {
    const { person } = this.options;
    if (event.actor.kind !== "person") return event;
    const { decision } = event;
    const ownDecision =
      decision === undefined ||
      decision.by === undefined ||
      decision.by === person ||
      !(PERSON_VERDICTS as readonly string[]).includes(decision.verdict);
    if (event.actor.id === person && ownDecision) return event;
    return {
      ...event,
      actor: { ...event.actor, id: person },
      ...(ownDecision ? {} : { decision: { ...decision, by: person } }),
    };
  }
}
