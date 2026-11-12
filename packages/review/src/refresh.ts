import {
  type Database,
  databaseOf,
  type Ledger,
  type Queryable,
  recordDecision,
  stableEventId,
} from "@selfhost/ledger";
import {
  HANDOFF_EVENT_KIND,
  handoffOf,
  type LedgerEvent,
  PERSON_ROLES,
  PERSON_VERDICTS,
  type PersonRole,
  type PersonVerdict,
  type ResolvedSelfhostConfig,
  type ReviewAnswer,
  type ReviewItem,
} from "@selfhost/schema";
import { decisionRefusal } from "./authorize.js";
import {
  actionsFor,
  type BuildContext,
  deliveryOf,
  groupOf,
  mergeItem,
  newItem,
  routeContext,
  routeInput,
  withoutRevoked,
} from "./build.js";
import { type CodeOwners, parseCodeOwners } from "./codeowners.js";
import { handedOverItem } from "./handoff.js";
import { decisionSubject, internalsOf, type ReviewList } from "./list.js";
import { buildPolicyReport } from "./policy-report.js";
import { escalateRoute, routeItem } from "./routing.js";
import { applySecondOpinion, catchUpOpinions } from "./second-opinion.js";
import { closedPullRequest, type Draft, draftFor, pullRequestKey } from "./signals.js";
import {
  claimItem,
  finishClaim,
  getItem,
  hasItemWithKey,
  insertItem,
  openItemByKey,
  openWaitingItems,
  releaseClaim,
  type StoredItem,
  updateItem,
} from "./store.js";

export interface RefreshOptions {
  /** selfhost.toml for events with no team policy. Default: the list's. */
  config?: ResolvedSelfhostConfig;
  /** Default: the list's clock. */
  now?: () => Date;
  /**
   * The CODEOWNERS text of a repository (owner/name), for the `codeowners` target of
   * [[review.routes]]. Default: none, so that target names nobody.
   */
  codeowners?: (repo: string) => Promise<string | undefined>;
  /** Where a decision that was not applied is reported, one line each. Default: console.warn. */
  log?: (line: string) => void;
}

export interface RefreshResult {
  /** Items opened by this refresh, weekly reports included. */
  created: number;
  /** Items changed: a signal added, closed by later activity, answered elsewhere, timed out. */
  updated: number;
  /**
   * Answers written on another path (a laptop's synced decision, POST /v1/decisions) that the
   * decider may not give, so the item stays as it was. Only set when there are some.
   */
  refused?: RefusedDecision[];
  /**
   * The pull request URLs of `pr` items this refresh escalated to another route, so whoever
   * shows the route on GitHub (the review request) can push it now. Only set when there are some.
   */
  escalated?: string[];
}

/** A decision event the refresh did not apply to its item, and why. */
export interface RefusedDecision {
  event_id: string;
  item_id: string;
  by: string;
  reason: string;
}

/** Who records a timeout's deny: selfhost itself, as a system actor. */
export const TIMEOUT_DECIDER = "selfhost";

const REVIEW_LOCK = 7_403_120_004;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Re-read this much before the last refresh, for events whose transaction committed late. */
const OVERLAP_MS = 10 * MINUTE_MS;
/** Older approvals, questions and alerts no longer need anyone. PRs and answers always count. */
const HORIZON_MS = 7 * DAY_MS;
const PAGE = 500;
const ATTEMPTS = 3;
const EPOCH = "1970-01-01T00:00:00.000Z";

const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const json = <T>(value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as T;
const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);
const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

type Roles = Record<PersonRole, string[]>;

interface Run {
  now: Date;
  configFor: (team: string | null) => ResolvedSelfhostConfig;
  result: RefreshResult;
  persons: Map<string, string | undefined>;
  roles: Map<string, Roles>;
  revoked: Map<string, string[]>;
  codeowners: (repo: string | undefined) => Promise<CodeOwners | undefined>;
}

/** Signals the list reads: everything that opens, adds to, closes or answers an item. */
const SIGNALS = `
SELECT e.id::text AS id, e.body, e.team, e.ingested_at FROM events e
WHERE e.ingested_at >= $1::timestamptz
  AND (e.kind IN ('pr.opened', 'pr.merged', 'pr.closed', 'pr.linked', 'decision.recorded',
      'review.submitted', 'run.handed_off')
    OR (e.ts >= $2::timestamptz AND (
      e.kind IN ('approval.requested', 'alert.raised', 'risk.learned')
      OR (e.kind = 'policy.evaluated'
        AND coalesce(e.body#>>'{decision,mode}', 'enforce') = 'enforce'
        AND e.body#>>'{decision,verdict}' IN ('block', 'ask')))))
  AND NOT EXISTS (SELECT 1 FROM review_signals s WHERE s.event_id = e.id)
ORDER BY e.ts, e.id
LIMIT $3`;

/**
 * The first event after a wait began that shows it is over: the person typed a prompt or the
 * session ended, or, for an approval, the tool it waited on ran. Only events up to the
 * deadline count: after it the approval has timed out.
 */
const RESOLVER = `
SELECT e.id::text AS id FROM events e
WHERE e.session_id = $1 AND coalesce(e.team, '') = $2 AND e.ts > $3::timestamptz
  AND ($4::timestamptz IS NULL OR e.ts <= $4::timestamptz)
  AND ($5::timestamptz IS NULL OR e.ts < $5::timestamptz)
  AND ((e.kind IN ('prompt.submitted', 'session.ended')
      AND coalesce(e.body#>>'{data,hook_event}', '') <> 'notify')
    OR ($6::boolean AND e.kind = 'tool.result'
      AND ($7::text IS NULL OR e.body#>>'{tool,name}' = $7::text)))
ORDER BY e.ts, e.id
LIMIT 1`;

/** Each team's policy in use: its stored selfhost.toml on top of its org's floor. */
async function teamConfigs(
  ledger: Ledger,
  db: Queryable,
  defaults: ResolvedSelfhostConfig,
): Promise<(team: string | null) => ResolvedSelfhostConfig> {
  const rows = await db.query<{ id: string }>(
    `SELECT t.id FROM teams t JOIN orgs o ON o.id = t.org_id
     WHERE t.policy_text IS NOT NULL OR o.policy_text IS NOT NULL`,
  );
  const configs = new Map<string, ResolvedSelfhostConfig>();
  for (const row of rows) {
    try {
      const policy = await ledger.orgs.effectivePolicy(row.id);
      if (policy) configs.set(row.id, policy.config);
    } catch {
      // Only valid text is stored, so this means the schema changed under it: use the defaults.
    }
  }
  return (team) => (team === null ? defaults : (configs.get(team) ?? defaults));
}

/**
 * A team's people by role: owners and admins approve its exceptions; routes name roles. People
 * revoked from the team have no role in it.
 */
async function teamRoles(tx: Queryable, team: string, run: Run): Promise<Roles> {
  const cached = run.roles.get(team);
  if (cached) return cached;
  const rows = await tx.query<{ id: string; role: string; revoked: boolean }>(
    "SELECT id, role, revoked_at IS NOT NULL AS revoked FROM people WHERE team_id = $1 ORDER BY id",
    [team],
  );
  const roles = Object.fromEntries(PERSON_ROLES.map((role) => [role, [] as string[]])) as Roles;
  const revoked: string[] = [];
  for (const row of rows) {
    if (row.revoked) revoked.push(row.id);
    else roles[row.role as PersonRole]?.push(row.id);
  }
  run.roles.set(team, roles);
  run.revoked.set(team, revoked);
  return roles;
}

/** The people revoked from a team: routing never names them. */
async function teamRevoked(tx: Queryable, team: string, run: Run): Promise<string[]> {
  await teamRoles(tx, team, run);
  return run.revoked.get(team) ?? [];
}

/**
 * What routing needs about a team scope, on a team server: its people by role, approvers, and
 * who holds its budget ([notify] budget_owners, else its owners).
 */
async function teamRouting(
  tx: Queryable,
  team: string | null,
  run: Run,
): Promise<Pick<BuildContext, "roles" | "approvers" | "budgetOwners" | "revoked">> {
  if (team === null) return {};
  const roles = await teamRoles(tx, team, run);
  const revoked = await teamRevoked(tx, team, run);
  const named = run.configFor(team).notify.budget_owners;
  return {
    roles,
    approvers: [...roles.owner, ...roles.admin].sort(),
    budgetOwners: withoutRevoked(named.length > 0 ? [...named] : [...roles.owner], revoked),
    revoked,
  };
}

/** Parsed CODEOWNERS per repository, read once per refresh. */
function codeownersReader(
  read: RefreshOptions["codeowners"],
): (repo: string | undefined) => Promise<CodeOwners | undefined> {
  const parsed = new Map<string, Promise<CodeOwners | undefined>>();
  return (repo) => {
    if (!read || !repo) return Promise.resolve(undefined);
    const key = repo.toLowerCase();
    let found = parsed.get(key);
    if (!found) {
      found = read(repo).then(
        (text) => (text === undefined ? undefined : parseCodeOwners(text)),
        () => undefined,
      );
      parsed.set(key, found);
    }
    return found;
  };
}

const personKey = (team: string | null, sessionId: string) => `${team ?? ""}\n${sessionId}`;

/**
 * The person a session belongs to: the new owner of its newest handoff, else the actor of its
 * first event written as a person.
 */
async function sessionPerson(
  tx: Queryable,
  team: string | null,
  sessionId: string | undefined,
  run: Run,
): Promise<string | undefined> {
  if (sessionId === undefined) return undefined;
  const key = personKey(team, sessionId);
  if (run.persons.has(key)) return run.persons.get(key);
  const [row] = await tx.query<{ person: string | null }>(
    `SELECT coalesce(
       (SELECT body#>>'{data,owner}' FROM events
        WHERE session_id = $1 AND kind = '${HANDOFF_EVENT_KIND}' AND coalesce(team, '') = $2
        ORDER BY ts DESC, id DESC LIMIT 1),
       (SELECT actor_id FROM events
        WHERE session_id = $1 AND actor_kind = 'person' AND coalesce(team, '') = $2
        ORDER BY ts, id LIMIT 1)) AS person`,
    [sessionId, team ?? ""],
  );
  const person = row?.person ?? undefined;
  run.persons.set(key, person);
  return person;
}

/**
 * A run changed hands: its open items move to the new owner (see handedOverItem), and items it
 * raises from now on go to them too.
 */
async function applyHandoff(
  tx: Queryable,
  event: LedgerEvent,
  team: string | null,
  run: Run,
): Promise<undefined> {
  const data = handoffOf(event);
  if (!data || event.session_id === undefined) return undefined;
  run.persons.delete(personKey(team, event.session_id));
  const rows = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM review_items
     WHERE state = 'open' AND session_id = $1 AND coalesce(team, '') = $2 ORDER BY created_at, id`,
    [event.session_id, team ?? ""],
  );
  for (const { id } of rows) {
    const stored = await getItem(tx, id, {});
    const next = stored && handedOverItem(stored.item, data, run.now);
    if (stored && next && (await updateItem(tx, { ...stored, item: next }))) {
      run.result.updated += 1;
    }
  }
  return undefined;
}

async function firstResolver(
  tx: Queryable,
  stored: StoredItem,
  before?: string,
): Promise<string | undefined> {
  const { item } = stored;
  if (!item.session_id) return undefined;
  const [row] = await tx.query<{ id: string }>(RESOLVER, [
    item.session_id,
    stored.team ?? "",
    stored.signalAt,
    item.deadline ?? null,
    before ?? null,
    item.kind === "approval",
    stored.tool ?? null,
  ]);
  return row?.id;
}

/** Closes an item because of a ledger event, which joins its source events. */
async function close(
  tx: Queryable,
  stored: StoredItem,
  eventId: string,
  run: Run,
  state: ReviewItem["state"],
  answer?: ReviewAnswer,
): Promise<boolean> {
  const item: ReviewItem = {
    ...stored.item,
    state,
    updated_at: run.now.toISOString(),
    source_event_ids: union(stored.item.source_event_ids, [eventId]),
    ...(answer ? { answer } : {}),
  };
  const written = await updateItem(tx, { ...stored, item });
  if (written) run.result.updated += 1;
  return written;
}

/**
 * Why a decision written on another path does not answer a team server's item: the same rule the
 * review item route applies (decisionRefusal). A person token's event (`team` set) decides as
 * its own person only, in their role in the item's team; the admin token's (no team) names
 * anyone. Items with no team are one machine's own and are never refused.
 */
async function refuseDecision(
  tx: Queryable,
  stored: StoredItem,
  event: LedgerEvent,
  by: string,
  team: string | null,
  run: Run,
): Promise<string | undefined> {
  if (stored.team === null) return undefined;
  const trusted = team === null;
  if (!trusted && by.toLowerCase() !== event.actor.id.toLowerCase()) {
    return `The decision names ${by}, but it was sent with ${event.actor.id}'s token: a person decides only as themselves.`;
  }
  const roles = trusted ? undefined : await teamRoles(tx, stored.team, run);
  const id = by.toLowerCase();
  const role = roles
    ? PERSON_ROLES.find((r) => roles[r].some((person) => person.toLowerCase() === id))
    : undefined;
  return decisionRefusal(
    stored.item,
    stored.team,
    event.decision?.verdict as PersonVerdict,
    { by, ...(role ? { role } : {}), trusted },
    run.configFor(stored.team),
  );
}

/** A decision recorded on another path (POST /v1/decisions, selfhost decide, GitHub, chat). */
async function applyDecision(
  tx: Queryable,
  event: LedgerEvent,
  team: string | null,
  run: Run,
): Promise<string | undefined> {
  const decision = event.decision;
  if (!decision || event.actor.kind !== "person") return undefined;
  if (!(PERSON_VERDICTS as readonly string[]).includes(decision.verdict)) return undefined;
  const itemId = decision.item_id ?? event.links?.item_id;
  let stored: StoredItem | undefined;
  if (itemId) {
    stored = await getItem(tx, itemId, {});
    // A person token's decision answers only its own team's items.
    if (stored && team !== null && stored.team !== team) stored = undefined;
  } else if (event.links?.pr_url) {
    stored = await openItemByKey(tx, team, `pr:${event.links.pr_url}`);
  }
  if (!stored) return undefined;
  const { item } = stored;
  const replaces =
    item.state === "answered" &&
    decision.replaces_event_id !== undefined &&
    item.answer?.decision_event_id.toLowerCase() === decision.replaces_event_id.toLowerCase();
  if (item.state !== "open" && !replaces) return item.id;
  const by = decision.by ?? event.actor.id;
  const refusal = await refuseDecision(tx, stored, event, by, team, run);
  if (refusal !== undefined) {
    const refused = { event_id: event.id, item_id: item.id, by, reason: refusal };
    run.result.refused = [...(run.result.refused ?? []), refused];
    return item.id;
  }
  await close(tx, stored, event.id, run, "answered", {
    by,
    verdict: decision.verdict,
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    at: event.ts,
    decision_event_id: event.id,
  });
  return item.id;
}

/**
 * Adds a signal to the open item it names, in its own team scope. undefined when the item is
 * not on the list (or is another kind); a closed item keeps the signal and changes nothing.
 */
async function attachTo(
  tx: Queryable,
  draft: Draft & { id: string },
  event: LedgerEvent,
  team: string | null,
  ctx: BuildContext,
  run: Run,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const stored = await getItem(tx, draft.id, {});
    if (!stored || stored.item.kind !== draft.kind) return undefined;
    if (team !== null && stored.team !== team) return undefined;
    if (stored.item.state !== "open") return stored.item.id;
    const paths = union(stored.paths, draft.paths);
    const tool = stored.tool ?? draft.tool;
    const item = mergeItem(stored.item, paths, { ...draft, ...(tool ? { tool } : {}) }, event, ctx);
    const written = await updateItem(tx, {
      ...stored,
      item,
      paths,
      signalAt: later(stored.signalAt, iso(event.ts)),
    });
    if (written) {
      run.result.updated += 1;
      return item.id;
    }
  }
  return undefined;
}

/** Opens an item for the signal, or adds the signal to the open item with its key. */
async function applyDraft(
  tx: Queryable,
  event: LedgerEvent,
  team: string | null,
  run: Run,
): Promise<string | undefined> {
  const draft = draftFor(event);
  if (!draft) return undefined;
  const config = run.configFor(team);
  const codeowners = config.review.routes.length > 0 ? await run.codeowners(event.repo) : undefined;
  const ctx: BuildContext = {
    config,
    now: run.now,
    team,
    ...(draft.person
      ? {}
      : { sessionPerson: await sessionPerson(tx, team, event.session_id, run) }),
    ...(await teamRouting(tx, team, run)),
    ...(codeowners ? { codeowners } : {}),
  };
  if (draft.attach && draft.id !== undefined) {
    return attachTo(tx, { ...draft, id: draft.id }, event, team, ctx, run);
  }
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let open = await openItemByKey(tx, team, draft.dedupeKey);
    // A signal that names its own item replaces an open one with another id: the agent and the
    // person were told the new id.
    if (open && draft.id !== undefined && open.item.id !== draft.id) {
      if (!(await close(tx, open, event.id, run, "dismissed"))) continue;
      open = undefined;
    }
    // A wait that ended before this signal is over; the signal starts a new one.
    if (open && draft.blocking && open.item.blocking) {
      const resolver = await firstResolver(tx, open, event.ts);
      if (resolver) {
        if (!(await close(tx, open, resolver, run, "dismissed"))) continue;
        open = undefined;
      }
    }
    if (!open) {
      // The item a signal names may exist already, closed; the signal belongs to it.
      if (draft.id !== undefined && (await getItem(tx, draft.id, {}))) return draft.id;
      const item = newItem(draft, event, ctx);
      await insertItem(tx, {
        item,
        team,
        dedupeKey: draft.dedupeKey,
        signalAt: item.created_at,
        ...(draft.tool ? { tool: draft.tool } : {}),
        paths: draft.paths,
      });
      run.result.created += 1;
      return item.id;
    }
    const paths = union(open.paths, draft.paths);
    const tool = open.tool ?? draft.tool;
    const item = mergeItem(open.item, paths, { ...draft, ...(tool ? { tool } : {}) }, event, ctx);
    const written = await updateItem(tx, {
      ...open,
      item,
      paths,
      signalAt: later(open.signalAt, iso(event.ts)),
      ...(tool ? { tool } : {}),
    });
    if (written) {
      run.result.updated += 1;
      return item.id;
    }
  }
  return undefined;
}

/**
 * pr.linked: the session behind a pull request whose item opened before that session reached
 * the server. The open `pr` item gets the session (and its run), so it links to the run.
 */
async function linkPullItem(
  tx: Queryable,
  event: LedgerEvent,
  team: string | null,
  run: Run,
): Promise<string | undefined> {
  const url = event.links?.pr_url ?? (event.target?.type === "pr" ? event.target.value : undefined);
  if (!url || !event.session_id) return undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const open = await openItemByKey(tx, team, pullRequestKey(url));
    if (!open || open.item.session_id) return open?.item.id;
    const run_id = open.item.run_id ?? event.run_id;
    const group =
      open.item.group ??
      groupOf({
        session_id: event.session_id,
        ...(run_id ? { run_id } : {}),
      });
    const item = {
      ...open.item,
      session_id: event.session_id,
      ...(run_id ? { run_id } : {}),
      ...(group ? { group } : {}),
      updated_at: run.now.toISOString(),
      source_event_ids: open.item.source_event_ids.includes(event.id)
        ? open.item.source_event_ids
        : [...open.item.source_event_ids, event.id],
    };
    if (await updateItem(tx, { ...open, item })) {
      run.result.updated += 1;
      return item.id;
    }
  }
  return undefined;
}

async function applySignal(
  tx: Queryable,
  event: LedgerEvent,
  team: string | null,
  run: Run,
): Promise<string | undefined> {
  if (event.kind === "decision.recorded") return applyDecision(tx, event, team, run);
  if (event.kind === HANDOFF_EVENT_KIND) return applyHandoff(tx, event, team, run);
  if (event.kind === "review.submitted") {
    const done = await applySecondOpinion(tx, event, team, {
      config: run.configFor(team),
      now: run.now,
    });
    if (done.updated) run.result.updated += 1;
    return done.itemId;
  }
  if (event.kind === "pr.linked") return linkPullItem(tx, event, team, run);
  const closedPr = closedPullRequest(event);
  if (closedPr) {
    const open = await openItemByKey(tx, team, `pr:${closedPr}`);
    if (open) await close(tx, open, event.id, run, "dismissed");
    return open?.item.id;
  }
  const itemId = await applyDraft(tx, event, team, run);
  if (itemId && event.kind === "pr.opened") {
    await catchUpOpinions(tx, itemId, { config: run.configFor(team), now: run.now });
  }
  return itemId;
}

/** Reads every signal the list has not read yet, oldest first. */
async function readSignals(tx: Queryable, run: Run): Promise<void> {
  const [progress] = await tx.query<{ ingested_at: unknown }>(
    "SELECT ingested_at FROM review_progress WHERE id = 'ledger'",
  );
  const last = progress ? iso(progress.ingested_at) : undefined;
  const from = last ? new Date(Date.parse(last) - OVERLAP_MS).toISOString() : EPOCH;
  const horizon = new Date(run.now.getTime() - HORIZON_MS).toISOString();
  let newest = last;
  for (;;) {
    const rows = await tx.query<{
      id: string;
      body: unknown;
      team: string | null;
      ingested_at: unknown;
    }>(SIGNALS, [from, horizon, PAGE]);
    if (rows.length === 0) break;
    for (const row of rows) {
      const itemId = await applySignal(tx, json<LedgerEvent>(row.body), row.team, run);
      await tx.query(
        `INSERT INTO review_signals (event_id, item_id) VALUES ($1::uuid, $2::uuid)
         ON CONFLICT (event_id) DO NOTHING`,
        [row.id, itemId ?? null],
      );
      const ingested = iso(row.ingested_at);
      if (newest === undefined || ingested > newest) newest = ingested;
    }
  }
  if (newest !== undefined && newest !== last) {
    await tx.query(
      `INSERT INTO review_progress (id, ingested_at) VALUES ('ledger', $1::timestamptz)
       ON CONFLICT (id) DO UPDATE SET ingested_at = EXCLUDED.ingested_at`,
      [newest],
    );
  }
}

/** Closes approvals and questions whose session moved on before their deadline. */
async function endWaits(tx: Queryable, run: Run): Promise<void> {
  for (const stored of await openWaitingItems(tx)) {
    const resolver = await firstResolver(tx, stored);
    if (resolver) await close(tx, stored, resolver, run, "dismissed");
  }
}

/**
 * Moves every open item whose route's escalates_at has passed to the next route that matches it
 * (or [review] fallback), as escalateRoute decides. The earlier owners keep the item too.
 */
async function escalate(tx: Queryable, run: Run): Promise<void> {
  const rows = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM review_items
     WHERE state = 'open' AND (body#>>'{route,escalates_at}')::timestamptz <= $1::timestamptz
     ORDER BY body#>>'{route,escalates_at}', id`,
    [run.now.toISOString()],
  );
  for (const { id } of rows) {
    const stored = await getItem(tx, id, {});
    const { item } = stored ?? {};
    if (!stored || !item || item.state !== "open" || !item.route) continue;
    const config = run.configFor(stored.team);
    const codeowners = await run.codeowners(item.repo);
    const ctx = {
      config,
      ...(await teamRouting(tx, stored.team, run)),
      ...(codeowners ? { codeowners } : {}),
    };
    const input = routeInput(item, stored.paths, stored.tool ? { tool: stored.tool } : {});
    const { routing, escalated } = escalateRoute(
      config,
      input,
      { owners: item.owners, route: item.route },
      routeContext(item, ctx, run.now),
    );
    const next: ReviewItem = {
      ...item,
      owners: withoutRevoked(routing.owners, ctx.revoked),
      route: routing.route,
      updated_at: run.now.toISOString(),
    };
    if (await updateItem(tx, { ...stored, item: next })) {
      run.result.updated += 1;
      if (escalated && item.kind === "pr" && item.url) {
        run.result.escalated = [...(run.result.escalated ?? []), item.url];
      }
    }
  }
}

/** Monday 00:00 UTC of the week `now` falls in. */
export function weekStart(now: Date): Date {
  const day = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return new Date(day - ((now.getUTCDay() + 6) % 7) * DAY_MS);
}

/**
 * The weekly would-block report: once a week (Monday to Monday, UTC) has ended, one
 * policy_report item per team scope whose rules in observe mode fired that week.
 */
async function weeklyReports(tx: Queryable, run: Run): Promise<void> {
  const until = weekStart(run.now);
  const since = new Date(until.getTime() - 7 * DAY_MS);
  const key = `policy_report:${since.toISOString()}`;
  const observed = `kind = 'policy.evaluated' AND ts >= $1::timestamptz AND ts < $2::timestamptz
    AND body#>>'{decision,mode}' = 'observe' AND body#>>'{decision,verdict}' IN ('block', 'ask')`;
  const scopes = await tx.query<{ team: string }>(
    `SELECT DISTINCT coalesce(team, '') AS team FROM events WHERE ${observed} ORDER BY 1`,
    [since.toISOString(), until.toISOString()],
  );
  for (const { team: scope } of scopes) {
    const team = scope === "" ? null : scope;
    if (await hasItemWithKey(tx, team, key)) continue;
    const rows = await tx.query<{ body: unknown }>(
      `SELECT body FROM events WHERE ${observed} AND coalesce(team, '') = $3 ORDER BY ts, id`,
      [since.toISOString(), until.toISOString(), scope],
    );
    const config = run.configFor(team);
    const report = buildPolicyReport(
      rows.map((row) => json<LedgerEvent>(row.body)),
      { since, until, now: run.now, rules: config.rules },
    );
    if (report.source_event_ids.length === 0) continue;
    const { owners, route } = routeItem(
      config,
      { paths: [], kind: "policy_report", risk: report.risk.score },
      { ...(team === null ? {} : { roles: await teamRoles(tx, team, run) }), now: until },
    );
    const item: ReviewItem = {
      ...report,
      id: stableEventId(since.toISOString(), `review_item\n${scope}\n${key}`),
      owners: team === null ? owners : withoutRevoked(owners, await teamRevoked(tx, team, run)),
      why: {
        signal: "policy.evaluated",
        text: "Rules in observe mode record what they would have blocked; this is last week's.",
      },
      actions: actionsFor("policy_report", undefined),
      delivery: deliveryOf(report, config),
      route,
    };
    await insertItem(tx, { item, team, dedupeKey: key, signalAt: until.toISOString(), paths: [] });
    run.result.created += 1;
  }
}

/**
 * Denies every blocking approval past its deadline: one decision.recorded event each, by
 * selfhost with surface timeout. The id comes from the item and the deadline, so a second
 * refresh (or a second server) writes nothing new.
 */
async function applyTimeouts(ledger: Ledger, db: Database, run: Run): Promise<void> {
  const due = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM review_items
     WHERE state = 'open' AND blocking AND deadline <= $1::timestamptz
     ORDER BY deadline, id`,
    [run.now.toISOString()],
  );
  for (const { id } of due) {
    const claimed = await claimItem(db, id, {});
    const deadline = claimed?.item.deadline;
    if (!claimed || !deadline) continue;
    const minutes = Math.round(
      (Date.parse(deadline) - Date.parse(claimed.item.created_at)) / MINUTE_MS,
    );
    let decision: Awaited<ReturnType<typeof recordDecision>>;
    try {
      decision = await recordDecision(
        ledger,
        {
          verdict: "deny",
          by: TIMEOUT_DECIDER,
          reason: `Nobody answered within ${minutes} minutes, so the approval timed out and was denied.`,
          ...decisionSubject(claimed),
          surface: "timeout",
          key: `review-timeout:${id}`,
          ts: deadline,
        },
        { system: true, source: "server" },
      );
    } catch (error) {
      await releaseClaim(db, claimed);
      throw error;
    }
    const { event } = decision;
    const item: ReviewItem = {
      ...claimed.item,
      state: "expired",
      updated_at: run.now.toISOString(),
      answer: {
        by: TIMEOUT_DECIDER,
        verdict: "deny",
        ...(event.decision?.reason !== undefined ? { reason: event.decision.reason } : {}),
        at: event.ts,
        decision_event_id: event.id,
      },
    };
    if (await finishClaim(db, { ...claimed, item })) run.result.updated += 1;
  }
}

/**
 * Brings the list up to date with the ledger: opens items for new signals (deduplicated by key,
 * grouped by run), adds repeats to the open item, closes items whose PR merged or closed or
 * whose session moved on, applies answers recorded on other paths, escalates items nobody
 * answered on their route in time, files last week's would-block report and denies blocking
 * approvals past their deadline. Safe to run often and from several
 * processes: every signal is read once, and refreshes take turns.
 */
/** Who hears that a refresh opened items, by ledger (see onItemsCreated). */
const createdListeners = new WeakMap<Ledger, Set<(created: number) => void>>();

/**
 * Calls `listener` after every refresh of this ledger's review list that opened items, whoever
 * ran it (the refresh job, an MCP question, a context proposal), with how many it opened: so
 * the notify pass can go out in seconds for each of them. Returns the call that stops it.
 */
export function onItemsCreated(ledger: Ledger, listener: (created: number) => void): () => void {
  let listeners = createdListeners.get(ledger);
  if (!listeners) {
    listeners = new Set();
    createdListeners.set(ledger, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function refreshReviewList(
  ledger: Ledger,
  list: ReviewList,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const internals = internalsOf(list);
  const db = databaseOf(ledger);
  const run: Run = {
    now: (options.now ?? internals.now)(),
    configFor: await teamConfigs(ledger, db, options.config ?? internals.config),
    result: { created: 0, updated: 0 },
    persons: new Map(),
    roles: new Map(),
    revoked: new Map(),
    codeowners: codeownersReader(options.codeowners),
  };
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [REVIEW_LOCK]);
    await readSignals(tx, run);
    await endWaits(tx, run);
    await escalate(tx, run);
    await weeklyReports(tx, run);
  });
  await applyTimeouts(ledger, db, run);
  const log = options.log ?? console.warn;
  if (run.result.created > 0) {
    for (const listener of createdListeners.get(ledger) ?? []) {
      try {
        listener(run.result.created);
      } catch (error) {
        log(
          `review list: a listener for new items failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  for (const refused of run.result.refused ?? []) {
    log(
      `review list: decision ${refused.event_id} by ${refused.by} on item ${refused.item_id} not applied: ${refused.reason}`,
    );
  }
  return run.result;
}
