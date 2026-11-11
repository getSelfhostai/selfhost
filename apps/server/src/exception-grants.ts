import { randomBytes } from "node:crypto";
import { databaseOf, type Ledger } from "@selfhost/ledger";
import { decisionRefusal, type ReviewList } from "@selfhost/review";
import {
  type ApiError,
  createValidator,
  EXCEPTION_GRANT_STATUS_SCHEMA,
  type ExceptionGrant,
  type ExceptionGrantState,
  type ExceptionGrantStatus,
  type ExceptionGrantUseRequest,
  ExceptionGrantUseRequestSchema,
  type LedgerEvent,
  type Person,
  type ResolvedSelfhostConfig,
  type ReviewItem,
} from "@selfhost/schema";
import type { Context, Env, Hono } from "hono";
import type { ExceptionKeyring } from "./exception-keys.js";

/**
 * One-time exceptions in team mode. A laptop's hook blocks a call and names an exception id; a
 * person the team allows (decisionRefusal in @selfhost/review) approves it; the requester's
 * laptop then fetches the grant, which this server signs with its Ed25519 key. The grant binds
 * the exception id, a nonce, the call's fingerprint and rules as the blocked call's event
 * reported them, the session, the repository, the requester, the approver and the expiry. The
 * hook verifies the signature with the server's public key the laptop pinned, so nobody on the
 * laptop can write a grant, and allows the call once.
 *
 * A grant is signed once, on the first fetch after the approval, and kept in exception_grants,
 * so later fetches return the same one. When the laptop reports the use (on its next sync), the
 * server marks it used and hands it out no more. That last part is best effort: a laptop that
 * never syncs again never reports it, and the hook verifies offline, so the laptop's own record
 * of used nonces is what stops a second use there.
 */

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isApproval = (verdict: string): verdict is "approve" | "override" =>
  verdict === "approve" || verdict === "override";
const MINUTE_MS = 60_000;

const apiError = (code: string, message: string): ApiError => ({ error: { code, message } });
const useBody = createValidator(ExceptionGrantUseRequestSchema);

export interface ExceptionGrantRouteOptions {
  /** The signing keys; without them every route answers 503. */
  keys?: ExceptionKeyring;
  now?: () => Date;
  person?: (c: Context) => Person | undefined;
  /** The review list that holds an item and its team, as the review routes find it. */
  holder: (c: Context, id: string) => Promise<{ list: ReviewList; team: string | undefined }>;
  /** The 404 for an item none of the caller's lists hold, with Retry-After while it is built. */
  missing: (c: Context, id: string) => Promise<Response>;
  configOf: (team: string | null) => Promise<ResolvedSelfhostConfig>;
}

interface GrantRow {
  body: ExceptionGrant;
  requested_by: string;
  used_at: string | Date | null;
}

const same = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

const status = (
  id: string,
  state: ExceptionGrantState,
  extra: { grant?: ExceptionGrant; reason?: string } = {},
): ExceptionGrantStatus => ({ schema: EXCEPTION_GRANT_STATUS_SCHEMA, id, state, ...extra });

/** The blocked call's event: the one among the item's sources that named this exception. */
async function requestEvent(
  ledger: Ledger,
  item: ReviewItem,
  id: string,
): Promise<LedgerEvent | undefined> {
  if (item.source_event_ids.length === 0) return undefined;
  const rows = await databaseOf(ledger).query<{ body: LedgerEvent }>(
    `SELECT body FROM events
     WHERE id = ANY($1::uuid[]) AND lower(body#>>'{data,exception,id}') = $2
     ORDER BY ts DESC LIMIT 1`,
    [item.source_event_ids, id],
  );
  return rows[0]?.body;
}

function requestOf(event: LedgerEvent): { fingerprint: string; rules: string[] } | undefined {
  const exception = event.data?.exception as Record<string, unknown> | undefined;
  const fingerprint = exception?.fingerprint;
  const rules = exception?.rules;
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) return undefined;
  if (!Array.isArray(rules) || !rules.every((rule) => typeof rule === "string" && rule !== "")) {
    return undefined;
  }
  return { fingerprint, rules: rules as string[] };
}

export function exceptionGrantRoutes<E extends Env>(
  app: Hono<E>,
  ledger: Ledger,
  options: ExceptionGrantRouteOptions,
): void {
  const { keys } = options;
  const clock = () => options.now?.() ?? new Date();
  const db = () => databaseOf(ledger);
  const unavailable = (c: Context) =>
    c.json(apiError("unavailable", "This server signs no exception grants."), 503);

  const stored = async (id: string): Promise<GrantRow | undefined> =>
    (
      await db().query<GrantRow>(
        "SELECT body, requested_by, used_at FROM exception_grants WHERE id = $1",
        [id],
      )
    )[0];

  /** The grant's state as stored: used, expired or granted. */
  const fromRow = (id: string, row: GrantRow, now: Date): ExceptionGrantStatus => {
    if (row.used_at !== null) return status(id, "used");
    if (Date.parse(row.body.expires_at) <= now.getTime()) return status(id, "expired");
    return status(id, "granted", { grant: row.body });
  };

  /** Who asks: a person token, for their own exceptions only. */
  const caller = (c: Context): Person | Response => {
    const person = options.person?.(c);
    if (!person) {
      return c.json(
        apiError(
          "forbidden",
          "Exception grants go to the person whose agent asked, with their person token.",
        ),
        403,
      );
    }
    return person;
  };
  const notTheirs = (c: Context) =>
    c.json(
      apiError("forbidden", "Only the person whose agent was blocked fetches this exception."),
      403,
    );

  app.get("/v1/exception-keys", (c) => (keys ? c.json(keys.publicKeys()) : unavailable(c)));

  app.post("/v1/exception-keys/rotate", (c) => {
    if (!keys) return unavailable(c);
    if (options.person?.(c)) {
      return c.json(apiError("forbidden", "Rotating the signing key needs the admin token."), 403);
    }
    keys.rotate(clock());
    return c.json(keys.publicKeys());
  });

  app.get("/v1/exception-grants/:id", async (c) => {
    if (!keys) return unavailable(c);
    const person = caller(c);
    if (person instanceof Response) return person;
    const id = c.req.param("id").toLowerCase();
    if (!ID.test(id)) return c.json(apiError("not_found", `No exception ${id}`), 404);
    const now = clock();
    const row = await stored(id);
    if (row) {
      if (!same(row.requested_by, person.id)) return notTheirs(c);
      return c.json(fromRow(id, row, now));
    }
    const { list, team } = await options.holder(c, id);
    const item = await list.get(id);
    if (!item) return options.missing(c, id);
    if (item.kind !== "exception") {
      return c.json(apiError("not_found", `Review item ${id} is not an exception`), 404);
    }
    if (!same(item.requested_by, person.id)) return notTheirs(c);
    if (item.state === "open") return c.json(status(id, "waiting"));
    const answer = item.answer;
    if (item.state !== "answered" || !answer || !isApproval(answer.verdict)) {
      const reason = answer
        ? `${answer.by} answered ${answer.verdict}`
        : `the item is ${item.state}`;
      return c.json(status(id, "refused", { reason }));
    }
    const config = await options.configOf(team ?? null);
    // Every path an answer reaches this server by checks it with decisionRefusal when it is
    // recorded. Checked again here: the self-approval rule always, and an approver who is in the
    // team with their role now. One who is not (the admin token names anyone) is held to the
    // self-approval rule only, as when the answer was recorded.
    const approver = team ? await ledger.teams.getPerson(team, answer.by) : undefined;
    const refused = decisionRefusal(
      item,
      team ?? "",
      answer.verdict,
      approver ? { by: answer.by, role: approver.role } : { by: answer.by, trusted: true },
      config,
    );
    if (refused !== undefined) return c.json(status(id, "refused", { reason: refused }));
    const event = await requestEvent(ledger, item, id);
    const request = event && requestOf(event);
    if (!event || !request || !same(String(event.data?.sent_by ?? ""), person.id)) {
      return c.json(
        status(id, "refused", { reason: "The blocked call's event from this person is missing." }),
      );
    }
    const approvedAt = new Date(answer.at);
    const expires = approvedAt.getTime() + config.review.exception_expiry_minutes * MINUTE_MS;
    if (expires <= now.getTime()) return c.json(status(id, "expired"));
    const grant = keys.sign({
      schema: "selfhost.exception_grant/v2",
      id,
      nonce: randomBytes(16).toString("hex"),
      fingerprint: request.fingerprint,
      rules: request.rules,
      agent: item.agent?.vendor ?? event.agent?.vendor ?? "unknown",
      session_id: item.session_id ?? event.session_id ?? null,
      repo: item.repo ?? event.repo ?? null,
      requested_by: person.id,
      approved_by: answer.by,
      decision_event_id: answer.decision_event_id,
      team: team ?? person.team,
      approved_at: approvedAt.toISOString(),
      issued_at: now.toISOString(),
      expires_at: new Date(expires).toISOString(),
    });
    // Two fetches at once both sign; the first row written is the grant both get.
    await db().query(
      `INSERT INTO exception_grants
         (id, team, requested_by, approved_by, key_id, nonce, issued_at, expires_at, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        grant.team,
        grant.requested_by,
        grant.approved_by,
        grant.key_id,
        grant.nonce,
        grant.issued_at,
        grant.expires_at,
        JSON.stringify(grant),
      ],
    );
    const saved = await stored(id);
    return c.json(saved ? fromRow(id, saved, now) : status(id, "granted", { grant }));
  });

  app.post("/v1/exception-grants/:id/use", async (c) => {
    if (!keys) return unavailable(c);
    const person = caller(c);
    if (person instanceof Response) return person;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(apiError("invalid_request", "Expected a JSON body"), 400);
    }
    const checked = useBody.validate(body);
    if (!checked.ok) {
      const [first] = checked.errors;
      return c.json(apiError("invalid_request", `${first?.field}: ${first?.message}`), 400);
    }
    const use: ExceptionGrantUseRequest = checked.value;
    const id = c.req.param("id").toLowerCase();
    const row = ID.test(id) ? await stored(id) : undefined;
    if (!row) return c.json(apiError("not_found", `No grant was issued for ${id}`), 404);
    if (!same(row.requested_by, person.id)) return notTheirs(c);
    if (row.body.nonce !== use.nonce) {
      return c.json(apiError("conflict", "That nonce is not this grant's."), 409);
    }
    await db().query(
      "UPDATE exception_grants SET used_at = $2, used_by = $3 WHERE id = $1 AND used_at IS NULL",
      [id, clock().toISOString(), use.machine ?? null],
    );
    return c.json(status(id, "used"));
  });
}
