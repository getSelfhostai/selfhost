import { stableEventId } from "@selfhost/ledger";
import { anyGlobMatches, globMatches, normalizePath } from "@selfhost/policy";
import {
  type LedgerEvent,
  REVIEW_ITEM_SCHEMA,
  type ResolvedSelfhostConfig,
  type ReviewAction,
  type ReviewItem,
  type ReviewItemKind,
} from "@selfhost/schema";
import { routeItem } from "./routing.js";
import type { Draft } from "./signals.js";

const MINUTE_MS = 60_000;

export interface BuildContext {
  config: ResolvedSelfhostConfig;
  now: Date;
  /** events.team of the signal: the team scope the item lives in. */
  team: string | null;
  /** The session's person when the signal names none. */
  sessionPerson?: string;
}

const iso = (ts: string) => new Date(ts).toISOString();

export function itemId(team: string | null, dedupeKey: string, event: LedgerEvent): string {
  return stableEventId(event.ts, `review_item\n${team ?? ""}\n${dedupeKey}\n${event.id}`);
}

export function actionsFor(kind: ReviewItemKind, url: string | undefined): ReviewAction[] {
  const actions: ReviewAction[] =
    kind === "question" ? ["answer", "snooze"] : ["approve", "deny", "snooze"];
  return url ? [...actions, "open"] : actions;
}

/** Group of items from one run, else one session. */
export function groupOf(event: Pick<LedgerEvent, "run_id" | "session_id">): string | undefined {
  if (event.run_id) return `run:${event.run_id}`;
  if (event.session_id) return `session:${event.session_id}`;
  return undefined;
}

/** A change under [review] high_risk_paths ranks as high risk whatever the signal said. */
export function withPathRisk(
  risk: ReviewItem["risk"],
  paths: readonly string[],
  config: ResolvedSelfhostConfig,
): ReviewItem["risk"] {
  const globs = config.review.high_risk_paths;
  const normalized = paths.map(normalizePath);
  if (!normalized.some((path) => anyGlobMatches(globs, path))) return risk;
  const hit = globs.filter((glob) => normalized.some((path) => globMatches(glob, path)));
  const reason = `Touches ${hit.join(", ")} ([review] high_risk_paths)`;
  return {
    score: Math.max(risk.score, config.review.high_risk_threshold),
    reasons: risk.reasons.includes(reason) ? risk.reasons : [...risk.reasons, reason],
  };
}

/** instant when an agent is blocked or risk is high, else digest. */
export function deliveryOf(
  item: Pick<ReviewItem, "blocking" | "risk">,
  config: ResolvedSelfhostConfig,
): ReviewItem["delivery"] {
  return item.blocking || item.risk.score >= config.review.high_risk_threshold
    ? "instant"
    : "digest";
}

function routed(item: ReviewItem, paths: readonly string[], ctx: BuildContext, draft: Draft) {
  const { owners, route } = routeItem(ctx.config, {
    paths,
    person: draft.person ?? ctx.sessionPerson,
    team: draft.team,
  });
  const risk = withPathRisk(item.risk, paths, ctx.config);
  return { ...item, owners, route, risk, delivery: deliveryOf({ ...item, risk }, ctx.config) };
}

/** A new open item from its first signal. */
export function newItem(draft: Draft, event: LedgerEvent, ctx: BuildContext): ReviewItem {
  const createdAt = iso(event.ts);
  const group = groupOf(event);
  const item: ReviewItem = {
    id: draft.id ?? itemId(ctx.team, draft.dedupeKey, event),
    schema: REVIEW_ITEM_SCHEMA,
    kind: draft.kind,
    title: draft.title,
    created_at: createdAt,
    updated_at: ctx.now.toISOString(),
    state: "open",
    blocking: draft.blocking,
    risk: { score: draft.score, reasons: draft.reasons },
    ...(event.repo ? { repo: event.repo } : {}),
    ...(draft.url ? { url: draft.url } : {}),
    owners: [],
    ...(event.agent ? { agent: event.agent } : {}),
    ...(event.session_id ? { session_id: event.session_id } : {}),
    ...(event.run_id ? { run_id: event.run_id } : {}),
    source_event_ids: [event.id],
    why: draft.why,
    ...(draft.timesOut
      ? {
          deadline: new Date(
            Date.parse(createdAt) + ctx.config.review.approval_timeout_minutes * MINUTE_MS,
          ).toISOString(),
        }
      : {}),
    actions: actionsFor(draft.kind, draft.url),
    ...(group ? { group } : {}),
    ...(draft.brief ? { brief: draft.brief } : {}),
  };
  return routed(item, draft.paths, ctx, draft);
}

/**
 * Adds a later signal to an open item. Its id joins source_event_ids; a higher risk, or a PR's
 * own new score, replaces the risk and the reason; the deadline stays, since the agent has been
 * waiting since the first signal. A signal with a brief replaces the brief, and one that attaches
 * to the item while an agent waits makes it blocking.
 */
export function mergeItem(
  item: ReviewItem,
  paths: readonly string[],
  draft: Draft,
  event: LedgerEvent,
  ctx: BuildContext,
): ReviewItem {
  const ids = item.source_event_ids.includes(event.id)
    ? item.source_event_ids
    : [...item.source_event_ids, event.id];
  const higher = draft.scored || draft.score > item.risk.score;
  const merged: ReviewItem = {
    ...item,
    ...(item.kind === "pr" ? { title: draft.title } : {}),
    updated_at: ctx.now.toISOString(),
    source_event_ids: ids,
    ...(higher ? { risk: { score: draft.score, reasons: draft.reasons }, why: draft.why } : {}),
    ...(!item.repo && event.repo ? { repo: event.repo } : {}),
    ...(!item.run_id && event.run_id ? { run_id: event.run_id } : {}),
    ...(draft.brief ? { brief: draft.brief } : {}),
    ...(draft.attach && draft.blocking ? { blocking: true } : {}),
  };
  return routed(merged, paths, ctx, draft);
}
