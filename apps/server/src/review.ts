import type { Ledger } from "@selfhost/ledger";
import {
  AlreadyAnsweredError,
  openReviewList,
  type RefreshResult,
  ReviewInputError,
  ReviewItemNotFoundError,
  type ReviewList,
  refreshReviewList,
} from "@selfhost/review";
import {
  type ApiError,
  createValidator,
  type DecisionRequest,
  DecisionRequestSchema,
  type Person,
  type PersonRole,
  REVIEW_ITEM_STATES,
  type ResolvedSelfhostConfig,
  type ReviewItem,
  type ReviewItemConflict,
  type ReviewItemState,
  type SnoozeRequest,
  SnoozeRequestSchema,
  type ValidationResult,
} from "@selfhost/schema";
import type { Context, Env, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { raiseBudgetAlerts } from "./budget-alerts.js";
import { teamConfig, withRunLinks } from "./runs.js";

/** A decision or snooze is a few fields; anything this big is not one. */
const MAX_ACTION_BYTES = 64 * 1024;
const QUERY_KEYS = new Set(["state", "owner", "team", "limit", "cursor"]);

export const REVIEW_REFRESH_INTERVAL_MS = 15_000;
/** How often the refresh job checks spend against each team's [budget]. */
const BUDGET_CHECK_MS = 60_000;

export interface ReviewRouteOptions {
  /** selfhost.toml for events with no team policy. */
  config?: ResolvedSelfhostConfig;
  now?: () => Date;
  /** The person a person token belongs to; undefined for the admin token. */
  person?: (c: Context) => Person | undefined;
  /**
   * Every team the person token's person is in, their own first: they read and act on the
   * items of each. Default: their own team only.
   */
  teams?: (c: Context) => Promise<string[]>;
  /** The person token's role in a team, for who may approve another person's exception. */
  role?: (c: Context, team: string) => Promise<PersonRole | undefined>;
  /**
   * SELFHOST_PUBLIC_URL, the console's address for the run links on items. Default: the
   * request's own origin.
   */
  publicUrl?: string;
  /**
   * Checked before an answer is recorded: the response that refuses it, such as a 403 for an
   * item only some roles may answer, or undefined to go on.
   */
  beforeDecision?: (c: Context, id: string) => Promise<Response | undefined>;
}

const apiError = (code: string, message: string): ApiError => ({ error: { code, message } });

const decisionBody = createValidator(DecisionRequestSchema);
const snoozeBody = createValidator(SnoozeRequestSchema);

function conflict(c: Context, error: AlreadyAnsweredError) {
  const body: ReviewItemConflict = {
    error: { code: "not_open", message: `This item is ${error.item.state}, not open` },
    item: error.item,
  };
  return c.json(body, 409);
}

async function readBody<T>(
  c: Context,
  validator: { validate(value: unknown): ValidationResult<T> },
  code: string,
): Promise<T | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(apiError(code, "Expected a JSON body"), 400);
  }
  const result = validator.validate(body);
  if (result.ok) return result.value;
  const [first] = result.errors;
  return c.json(apiError(code, `${first?.field}: ${first?.message}`), 400);
}

/**
 * The review list over HTTP: GET /v1/review-items and /v1/review-items/{id}, and POST
 * .../decision and .../snooze. A person token reads and acts on its own team's items and acts
 * as its own person; the admin token reads every item and names who acts in `by`.
 */
export function reviewRoutes<E extends Env>(
  app: Hono<E>,
  ledger: Ledger,
  options: ReviewRouteOptions = {},
): void {
  const lists = new Map<string, ReviewList>();
  const listFor = (team: string | undefined): ReviewList => {
    const key = team ?? "";
    let list = lists.get(key);
    if (!list) {
      list = openReviewList(ledger, {
        ...(options.config ? { config: options.config } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(team !== undefined ? { team } : {}),
      });
      lists.set(key, list);
    }
    return list;
  };
  const scope = (c: Context) => {
    const person = options.person?.(c);
    return { person, list: listFor(person?.team) };
  };
  /**
   * The list that holds an item and its team, so a person in several teams acts on any of
   * theirs. The admin token's list holds every item, with no team.
   */
  const holder = async (
    c: Context,
    id: string,
  ): Promise<{ list: ReviewList; team: string | undefined }> => {
    const person = options.person?.(c);
    const teams: (string | undefined)[] = person
      ? ((await options.teams?.(c)) ?? [person.team])
      : [undefined];
    for (const team of teams) {
      const list = listFor(team);
      if (await list.get(id)) return { list, team };
    }
    return { list: listFor(teams[0]), team: teams[0] };
  };
  const listWith = async (c: Context, id: string): Promise<ReviewList> =>
    (await holder(c, id)).list;
  const configOf = teamConfig(ledger, options.config);
  /** Items with links to their run in the console and in the team's tracer. */
  const linked = async (c: Context, items: ReviewItem[], team: string | undefined) =>
    withRunLinks(ledger, items, {
      server: options.publicUrl ?? new URL(c.req.url).origin,
      config: await configOf(team ?? null),
    });
  const limit = bodyLimit({
    maxSize: MAX_ACTION_BYTES,
    onError: (c) =>
      c.json(apiError("payload_too_large", `Request body over ${MAX_ACTION_BYTES} bytes`), 413),
  });
  /** Who acts: the person token's person, else `by` from the body (admin token). */
  const actor = (c: Context, by: string | undefined): string | Response => {
    const { person } = scope(c);
    if (person) {
      if (by !== undefined && by !== person.id) {
        return c.json(apiError("forbidden", "A person token acts as its own person"), 403);
      }
      return person.id;
    }
    if (by === undefined || by.trim() === "") {
      return c.json(apiError("invalid_request", "by: Required with the admin token"), 400);
    }
    return by;
  };

  app.get("/v1/review-items", async (c) => {
    const query: { state?: ReviewItemState; owner?: string; limit?: number; cursor?: string } = {};
    let team: string | undefined;
    for (const [key, values] of Object.entries(c.req.queries())) {
      const fail = (message: string) =>
        c.json(apiError("invalid_query", `${key}: ${message}`), 400);
      if (!QUERY_KEYS.has(key)) return fail("Unknown query parameter");
      if (values.length !== 1) return fail("Expected one value");
      const [value = ""] = values;
      if (key === "limit") {
        if (!/^\d+$/.test(value)) return fail("Expected an integer");
        query.limit = Number(value);
      } else if (key === "state") {
        if (!(REVIEW_ITEM_STATES as readonly string[]).includes(value)) {
          return fail(`Expected one of: ${REVIEW_ITEM_STATES.join(", ")}`);
        }
        query.state = value as ReviewItemState;
      } else if (key === "team") {
        team = value;
      } else if (key === "owner") {
        query.owner = value;
      } else {
        query.cursor = value;
      }
    }
    const person = options.person?.(c);
    if (person && team !== undefined && team !== person.team) {
      const teams = (await options.teams?.(c)) ?? [person.team];
      if (!teams.includes(team)) {
        return c.json(apiError("forbidden", `You are not in team ${team}.`), 403);
      }
    }
    try {
      const listed = person ? (team ?? person.team) : team;
      const page = await listFor(listed).list(query);
      return c.json({ ...page, items: await linked(c, page.items, listed) });
    } catch (error) {
      if (error instanceof ReviewInputError) {
        return c.json(apiError("invalid_query", error.message), 400);
      }
      throw error;
    }
  });

  app.get("/v1/review-items/:id", async (c) => {
    const id = c.req.param("id");
    const item = await (await listWith(c, id)).get(id);
    if (!item) return c.json(apiError("not_found", `No review item ${id}`), 404);
    const [withLinks] = await linked(c, [item], options.person?.(c)?.team);
    return c.json(withLinks ?? item);
  });

  /**
   * The 403 for approving an exception the caller may not: their own agent's, unless the team's
   * [review] self_approve_exceptions allows it, or another person's without the owner or admin
   * role. Denying is always allowed.
   */
  const exceptionRefusal = async (
    c: Context,
    item: ReviewItem,
    team: string | undefined,
    by: string,
    verdict: DecisionRequest["verdict"],
  ): Promise<Response | undefined> => {
    if (item.kind !== "exception" || (verdict !== "approve" && verdict !== "override")) {
      return undefined;
    }
    const requester = item.requested_by;
    if (requester !== undefined && requester.toLowerCase() === by.toLowerCase()) {
      if ((await configOf(team ?? null)).review.self_approve_exceptions) return undefined;
      return c.json(
        apiError(
          "forbidden",
          "You cannot approve an exception your own agent asked for. An owner or admin of the team approves it, or the team's selfhost.toml sets [review] self_approve_exceptions = true.",
        ),
        403,
      );
    }
    const person = options.person?.(c);
    if (!person) return undefined;
    const where = team ?? person.team;
    const role = (await options.role?.(c, where)) ?? person.role;
    if (role === "owner" || role === "admin") return undefined;
    return c.json(
      apiError(
        "forbidden",
        `Approving another person's exception needs the owner or admin role in team ${where}; you are a ${role} there.`,
      ),
      403,
    );
  };

  app.post("/v1/review-items/:id/decision", limit, async (c) => {
    const body = await readBody<DecisionRequest>(c, decisionBody, "invalid_decision");
    if (body instanceof Response) return body;
    const by = actor(c, body.by);
    if (by instanceof Response) return by;
    const id = c.req.param("id");
    const refusedFirst = await options.beforeDecision?.(c, id);
    if (refusedFirst) return refusedFirst;
    const { list, team } = await holder(c, id);
    const item = await list.get(id);
    if (item) {
      const refused = await exceptionRefusal(c, item, team, by, body.verdict);
      if (refused) return refused;
    }
    try {
      const response = await list.decide(id, {
        verdict: body.verdict,
        by,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        surface: "api",
      });
      return c.json(response);
    } catch (error) {
      if (error instanceof AlreadyAnsweredError) return conflict(c, error);
      if (error instanceof ReviewItemNotFoundError) {
        return c.json(apiError("not_found", error.message), 404);
      }
      if (error instanceof ReviewInputError) {
        return c.json(apiError("invalid_decision", error.message), 400);
      }
      throw error;
    }
  });

  app.post("/v1/review-items/:id/snooze", limit, async (c) => {
    const body = await readBody<SnoozeRequest>(c, snoozeBody, "invalid_request");
    if (body instanceof Response) return body;
    const by = actor(c, body.by);
    if (by instanceof Response) return by;
    const id = c.req.param("id");
    try {
      return c.json(await (await listWith(c, id)).snooze(id, { by, until: body.until }));
    } catch (error) {
      if (error instanceof AlreadyAnsweredError) return conflict(c, error);
      if (error instanceof ReviewItemNotFoundError) {
        return c.json(apiError("not_found", error.message), 404);
      }
      if (error instanceof ReviewInputError) {
        return c.json(apiError("invalid_request", error.message), 400);
      }
      throw error;
    }
  });
}

export interface ReviewRefreshJobOptions {
  config?: ResolvedSelfhostConfig;
  /** Default: every 15 seconds. */
  intervalMs?: number;
  /** Where the job reports. Default: console.log. */
  log?: (line: string) => void;
  now?: () => Date;
}

export interface ReviewRefreshJob {
  /** One refresh now. undefined when it failed; the failure is logged. */
  run(): Promise<RefreshResult | undefined>;
  stop(): void;
}

/**
 * Raises budget alerts from each team's spend (once a minute), then builds review items from
 * new ledger signals and applies approval timeouts, now and then every intervalMs, like the retention job: one refresh at a time, a timer that never keeps the
 * process alive, and a log line with counts only.
 */
export function startReviewRefreshJob(
  ledger: Ledger,
  options: ReviewRefreshJobOptions = {},
): ReviewRefreshJob {
  const { intervalMs = REVIEW_REFRESH_INTERVAL_MS, log = console.log } = options;
  const list = openReviewList(ledger, {
    ...(options.config ? { config: options.config } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  let running: Promise<RefreshResult | undefined> | undefined;
  let budgetsAt = 0;
  /** Budget alerts from ledger spend, at most once a minute, so the refresh files them. */
  const budgets = async () => {
    const at = options.now?.() ?? new Date();
    if (at.getTime() - budgetsAt < BUDGET_CHECK_MS) return;
    budgetsAt = at.getTime();
    try {
      const raised = await raiseBudgetAlerts(ledger, at);
      if (raised > 0) log(`budget alerts: ${raised} raised from spend`);
    } catch (error) {
      log(`budget alerts: failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  const run = () => {
    running ??= budgets()
      .then(() => refreshReviewList(ledger, list))
      .then(
        (result) => {
          if (result.created > 0 || result.updated > 0) {
            log(`review list: ${result.created} new, ${result.updated} changed`);
          }
          return result;
        },
        (error: unknown) => {
          log(`review list: refresh failed: ${error instanceof Error ? error.message : error}`);
          return undefined;
        },
      )
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  void run();
  return { run, stop: () => clearInterval(timer) };
}
