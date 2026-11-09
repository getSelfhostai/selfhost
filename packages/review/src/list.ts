import { setTimeout as sleep } from "node:timers/promises";
import {
  type Database,
  DecisionInputError,
  databaseOf,
  type Ledger,
  recordDecision,
} from "@selfhost/ledger";
import {
  type DecisionResponse,
  type DecisionSurface,
  PERSON_VERDICTS,
  type PersonVerdict,
  type ResolvedSelfhostConfig,
  type ReviewItem,
  type ReviewItemState,
  type ReviewItemsPage,
  validateConfig,
} from "@selfhost/schema";
import { routeInput } from "./build.js";
import { AlreadyAnsweredError, ReviewInputError, ReviewItemNotFoundError } from "./errors.js";
import type { RouteInput } from "./routing.js";
import { pullRequestKey } from "./signals.js";
import {
  claimItem,
  finishClaim,
  getItem,
  latestItemByKey,
  listItems,
  openWaitsOf,
  releaseClaim,
  type Scope,
  type StoredItem,
  snoozeItem,
} from "./store.js";

export interface ReviewListQuery {
  state?: ReviewItemState;
  owner?: string;
  /** Only items this person owns or whose signals came from their own events or sessions. */
  for?: string;
  limit?: number;
  cursor?: string;
}

export interface DecideInput {
  verdict: PersonVerdict;
  by: string;
  reason?: string;
  /** When the person decided. Default: now. */
  at?: string;
  /** Where the person decided, recorded on the decision. Default: api. */
  surface?: DecisionSurface;
}

/**
 * The review list every surface reads: the API, the CLI inbox, GitHub, Slack, Telegram, MCP and
 * the console. Answers and snoozes made through one surface show on every other surface's next
 * read, because they all read and write the same rows.
 */
export interface ReviewList {
  /** Items in rank order (see rank.ts). state defaults to open. */
  list(query: ReviewListQuery): Promise<ReviewItemsPage>;
  get(id: string): Promise<ReviewItem | undefined>;
  /**
   * The `pr` item for an agent pull request, by its URL: the open one, else the one opened last.
   * Undefined when the list has none for it.
   */
  pullRequest(url: string): Promise<ReviewItem | undefined>;
  /**
   * Answers an open item: writes one decision.recorded event with recordDecision, then closes
   * the item as answered. Throws AlreadyAnsweredError when the item is not open, and nothing is
   * written.
   */
  decide(id: string, input: DecideInput): Promise<DecisionResponse>;
  /** Ranks an open item after the rest until `until`; a time in the past ends the snooze. */
  snooze(id: string, input: { by: string; until: string }): Promise<ReviewItem>;
  /**
   * Open items of these sessions or runs that an agent waits on, or that are exceptions: what
   * keeps auto-approve from approving the pull request they made.
   */
  waits(runs: { sessions: readonly string[]; runIds: readonly string[] }): Promise<ReviewItem[]>;
  /**
   * Closes an open item as approved by selfhost itself (a system actor, not a person), with
   * the decision recorded elsewhere: auto-approve. false when the item was not open.
   */
  closeApproved(id: string, answer: ReviewItem["answer"] & object): Promise<boolean>;
}

export interface ReviewListOptions {
  /** selfhost.toml for events with no team policy. Default: the built-in defaults. */
  config?: ResolvedSelfhostConfig;
  now?: () => Date;
  /** Only this team's items (events.team), as a person token sees them. Default: every item. */
  team?: string;
}

/** What refreshReviewList needs from a list it did not open. */
export interface ListInternals {
  ledger: Ledger;
  db: Database;
  config: ResolvedSelfhostConfig;
  now: () => Date;
  scope: Scope;
}

const internals = new WeakMap<ReviewList, ListInternals>();

export function internalsOf(list: ReviewList): ListInternals {
  const found = internals.get(list);
  if (!found) throw new Error("Expected a review list from openReviewList");
  return found;
}

export function defaultConfig(): ResolvedSelfhostConfig {
  const result = validateConfig({ version: 1 });
  if (!result.ok) throw new Error("The default selfhost.toml does not validate");
  return result.config;
}

/** How long decide waits for another surface's answer in flight before giving up. */
const CLAIM_WAIT_MS = 2_000;
const CLAIM_POLL_MS = 50;
/** CreateDecisionRequest takes at most this many paths. */
const MAX_DECISION_PATHS = 1000;

function nonBlank(field: string, value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") throw new ReviewInputError(field, "Expected the person who acted");
  return trimmed;
}

function isTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** The question a decision on this item answers, and what it is about, for the decision log. */
export function decisionSubject(stored: StoredItem) {
  const { item } = stored;
  return {
    item_id: item.id,
    question: item.title,
    ...(item.run_id ? { run_id: item.run_id } : {}),
    ...(item.why?.rule_id ? { rule_id: item.why.rule_id } : {}),
    ...(item.repo ? { repo: item.repo } : {}),
    ...(item.kind === "pr" && item.url ? { pr_url: item.url } : {}),
    ...(stored.paths.length > 0 ? { paths: stored.paths.slice(0, MAX_DECISION_PATHS) } : {}),
  };
}

/**
 * Opens the review list stored in the ledger's database (migration 0004_review_items). Items
 * come from refreshReviewList; this reads them and records answers and snoozes.
 */
export function openReviewList(ledger: Ledger, options: ReviewListOptions = {}): ReviewList {
  const db = databaseOf(ledger);
  const now = options.now ?? (() => new Date());
  const scope: Scope = options.team === undefined ? {} : { team: options.team };

  /** Claims the item, waiting briefly while another answer is in flight. */
  async function claim(id: string): Promise<StoredItem> {
    const deadline = Date.now() + CLAIM_WAIT_MS;
    for (;;) {
      const claimed = await claimItem(db, id, scope);
      if (claimed) return claimed;
      const current = await getItem(db, id, scope);
      if (!current) throw new ReviewItemNotFoundError(id);
      if (current.item.state !== "open" || Date.now() >= deadline) {
        throw new AlreadyAnsweredError(current.item);
      }
      await sleep(CLAIM_POLL_MS);
    }
  }

  const list: ReviewList = {
    list: (query) => {
      const { for: person, ...rest } = query ?? {};
      return listItems(db, scope, rest, now(), person);
    },

    async get(id) {
      return (await getItem(db, id, scope))?.item;
    },

    async pullRequest(url) {
      return (await latestItemByKey(db, scope, pullRequestKey(url)))?.item;
    },

    async decide(id, input) {
      if (!(PERSON_VERDICTS as readonly string[]).includes(input.verdict)) {
        throw new ReviewInputError("verdict", "Expected approve, deny, answer or override");
      }
      const by = nonBlank("by", input.by);
      if (input.at !== undefined && !isTime(input.at)) {
        throw new ReviewInputError("at", "Expected a date-time with a time zone");
      }
      const claimed = await claim(id);
      let decision: Awaited<ReturnType<typeof recordDecision>>;
      try {
        decision = await recordDecision(
          ledger,
          {
            verdict: input.verdict,
            by,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            ...decisionSubject(claimed),
            surface: input.surface ?? "api",
            ...(input.at !== undefined ? { ts: input.at } : {}),
          },
          { now: now(), ...(input.surface === "cli" ? { source: "cli" as const } : {}) },
        );
      } catch (error) {
        await releaseClaim(db, claimed);
        if (error instanceof DecisionInputError) {
          const [first] = error.errors;
          throw new ReviewInputError(first?.field ?? "decision", first?.message ?? error.message);
        }
        throw error;
      }
      const event = decision.event;
      const item: ReviewItem = {
        ...claimed.item,
        state: "answered",
        updated_at: now().toISOString(),
        answer: {
          by: event.decision?.by ?? by,
          verdict: input.verdict,
          ...(event.decision?.reason !== undefined ? { reason: event.decision.reason } : {}),
          at: event.ts,
          decision_event_id: event.id,
        },
      };
      if (!(await finishClaim(db, { ...claimed, item }))) {
        const current = await getItem(db, id, scope);
        throw new AlreadyAnsweredError(current?.item ?? claimed.item);
      }
      return { item, decision_event: event };
    },

    async snooze(id, input) {
      const by = nonBlank("by", input.by);
      if (typeof input.until !== "string" || !isTime(input.until)) {
        throw new ReviewInputError("until", "Expected a date-time with a time zone");
      }
      const at = now();
      const until = new Date(input.until);
      const change = {
        now: at.toISOString(),
        ...(until.getTime() > at.getTime() ? { until: until.toISOString(), by } : {}),
      };
      // Waits out an answer in flight, like decide: the snooze applies only if it stays open.
      const deadline = Date.now() + CLAIM_WAIT_MS;
      for (;;) {
        const snoozed = await snoozeItem(db, id, scope, change);
        if (snoozed) return snoozed;
        const current = await getItem(db, id, scope);
        if (!current) throw new ReviewItemNotFoundError(id);
        if (current.item.state !== "open" || Date.now() >= deadline) {
          throw new AlreadyAnsweredError(current.item);
        }
        await sleep(CLAIM_POLL_MS);
      }
    },

    waits: (runs) => openWaitsOf(db, scope, runs),

    async closeApproved(id, answer) {
      const claimed = await claimItem(db, id, scope);
      if (!claimed) return false;
      const item: ReviewItem = {
        ...claimed.item,
        state: "answered",
        updated_at: now().toISOString(),
        source_event_ids: [
          ...new Set([...claimed.item.source_event_ids, answer.decision_event_id]),
        ],
        answer,
      };
      if (await finishClaim(db, { ...claimed, item })) return true;
      await releaseClaim(db, claimed);
      return false;
    },
  };
  internals.set(list, { ledger, db, config: options.config ?? defaultConfig(), now, scope });
  return list;
}

/**
 * An item with what routing reads about it, including the files and tool the item itself does
 * not show, for `selfhost review routes --item`. Undefined when the list has no such item.
 */
export async function routeInputOf(
  list: ReviewList,
  id: string,
): Promise<{ item: ReviewItem; input: RouteInput } | undefined> {
  const { db, scope } = internalsOf(list);
  const stored = await getItem(db, id, scope);
  if (!stored) return undefined;
  const { item } = stored;
  // The session's person is not stored; an item routed to them names them as its owner.
  const person =
    item.requested_by ?? (item.route?.from === "the session's person" ? item.owners[0] : undefined);
  return {
    item,
    input: routeInput(item, stored.paths, {
      ...(stored.tool ? { tool: stored.tool } : {}),
      ...(person ? { person } : {}),
    }),
  };
}
