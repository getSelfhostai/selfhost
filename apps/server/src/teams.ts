import { createHash, timingSafeEqual } from "node:crypto";
import type { JoinRefusal, Ledger } from "@selfhost/ledger";
import {
  allowedActions,
  CreateTeamRequestSchema,
  type CreateTeamResponse,
  createValidator,
  DEFAULT_ORG_ID,
  type IngestEventsError,
  JoinRequestSchema,
  type JoinResponse,
  type MeResponse,
  type Person,
  type RevokeTokensResponse,
  TEAM_ACTIONS,
  upgradeEvent,
} from "@selfhost/schema";
import { type Context, Hono } from "hono";
import {
  apiError,
  authorize,
  type Caller,
  type PersonCaller,
  personCaller,
  type Router,
} from "./access.js";
import { requireBearerToken } from "./auth.js";
import { eventRoutes, MAX_BODY_BYTES } from "./events.js";
import { limit, readBody, rethrow, SMALL_BODY_BYTES } from "./http.js";
import { teamId } from "./ids.js";
import { createOrgRoute, orgRoutes } from "./orgs.js";
import { peopleRoutes } from "./people.js";
import { policyRoutes } from "./policy.js";
import { forwardedEmail, type SigninOptions, signedInPerson } from "./signin.js";
import { usageRoutes } from "./usage.js";

export interface TeamRouteOptions {
  ledger: Ledger;
  /** The admin token. */
  token: string;
  /** Adds more routes a person token may call; the person is in `c.env.person`. */
  personRoutes?: (person: Hono<PersonEnv>) => void;
  /** Clock for budgets and overviews. */
  now?: () => Date;
  /** Console sign-in through a proxy that forwards the person's email (see signin.ts). */
  signin?: SigninOptions;
}

export type PersonEnv = { Bindings: { person: Person; caller: PersonCaller } };
type EventsEnv = { team: string };
type BatchError = IngestEventsError["errors"][number];

/** Routes that need no bearer token: /v1/join takes the invite code in the body instead. */
const PUBLIC_PATHS = new Set(["/v1/health", "/v1/join"]);
const ADMIN: Caller = { kind: "admin" };

const createTeamBody = createValidator(CreateTeamRequestSchema);
const joinBody = createValidator(JoinRequestSchema);

const REFUSED_INVITE: Record<JoinRefusal, string> = {
  unknown: "Unknown invite code",
  expired: "This invite code has expired. Ask a team admin for a new one.",
  revoked: "This invite code was revoked. Ask a team admin for a new one.",
  wrong_person: "This invite is for someone else. Join with the email it was sent to.",
  existing_person:
    "This person is already in the team or another team of its org, and a team-wide invite only adds new people. Ask a team admin to add them (selfhost team add <person>), for an invite for this person (selfhost team invite --email <person>), or to revoke them and invite them again.",
};

export { teamId } from "./ids.js";

/**
 * Teams, orgs, invites and person tokens. Call it before the admin token check: it serves
 * /v1/join, whose credential is the invite in the body, and answers every request that carries
 * a person token itself, so a person token reaches only the person routes below. Requests with
 * the admin token or no valid token go on to the rest of the app unchanged.
 *
 * Routes both kinds of token share (policy, people, roles, repos, overviews) check the caller's
 * role in the team against the permission table in @selfhost/schema; the admin token can do
 * everything.
 *
 * There is no route that forwards anything to a model provider: agents keep talking to their
 * vendors directly, and this server only stores events and the team policy.
 */
export function teamRoutes(
  app: Hono,
  { ledger, token, personRoutes, now, signin }: TeamRouteOptions,
): void {
  const { teams } = ledger;
  const isAdminToken = sameAs(token);
  const adminOnly = requireBearerToken(token);

  // The ordinary events routes, limited to one team. Writes reach them only after their events
  // are stamped.
  const events = new Hono();
  eventRoutes(events, ledger, { team: (c) => (c.env as EventsEnv).team });
  events.onError(rethrow);

  const person = new Hono<PersonEnv>();
  person.onError(rethrow);
  person.notFound((c) =>
    c.json(
      apiError(
        "forbidden",
        "A person token works in the teams of its org it belongs to: their events, review items, people, repos, policy, budget and overviews, and what its role allows there. This route needs the admin token.",
      ),
      403,
    ),
  );

  person.post("/v1/events", limit(MAX_BODY_BYTES), async (c) => {
    const stamped = stampEvents(await c.req.text(), c.env.person);
    if ("errors" in stamped) {
      const body: IngestEventsError = {
        error: {
          code: "invalid_events",
          message: `${stamped.errors.length} problem(s) found, nothing was written`,
        },
        errors: stamped.errors,
      };
      return c.json(body, 400);
    }
    return events.request(
      "/v1/events",
      { method: "POST", headers: { "content-type": "application/json" }, body: stamped.body },
      { team: c.env.person.team } satisfies EventsEnv,
    );
  });

  // A person reads the events of any team of the org they are in; their own by default.
  person.get("/v1/events", async (c) => {
    const team = c.req.query("team") ?? c.env.person.team;
    const refused = await authorize(c, c.env.caller, team, "read");
    if (refused) return refused;
    return events.fetch(c.req.raw, { team } satisfies EventsEnv);
  });

  // selfhost team leave: the token making the request stops working.
  person.delete("/v1/me/token", async (c) => {
    const revoked = await teams.revokeToken(bearerToken(c.req.header("authorization")) ?? "");
    if (!revoked) return unauthorized(c, "Missing or invalid bearer token");
    return c.json(revoked satisfies RevokeTokensResponse);
  });

  person.get("/v1/me", async (c) => {
    const own = c.env.person;
    const team = await teams.getTeam(own.team);
    const { memberships } = await c.env.caller.scope();
    return c.json({
      kind: "person",
      person: own,
      ...(team ? { team } : {}),
      role: own.role,
      allowed: allowedActions(own.role),
      memberships,
    } satisfies MeResponse);
  });

  const asPerson: Router = {
    on(method, path, handler, bodyLimit) {
      const run = (c: Context<PersonEnv>) => handler(c, c.env.caller);
      if (bodyLimit) person.on(method, path, bodyLimit, run);
      else person.on(method, path, run);
    },
  };
  sharedRoutes(asPerson, ledger, now);
  personRoutes?.(person);

  app.use("*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    const bearer = bearerToken(c.req.header("authorization"));
    // Signed in at the proxy in front of the console: reads only, as the person.
    const email = bearer === undefined ? forwardedEmail(c, signin) : undefined;
    if (email !== undefined) {
      const found = signedInPerson(c, email, await teams.peopleWithAccess(email));
      if (found instanceof Response) return found;
      return person.fetch(c.req.raw, { person: found, caller: personCaller(teams, found) });
    }
    if (bearer === undefined || isAdminToken(bearer)) return next();
    const found = await teams.personForToken(bearer);
    // An unknown token goes on to the admin check, which answers 401.
    if (!found) return next();
    return person.fetch(c.req.raw, { person: found, caller: personCaller(teams, found) });
  });

  app.post("/v1/join", limit(SMALL_BODY_BYTES), async (c) => {
    const body = await readBody(c, joinBody);
    if (body instanceof Response) return body;
    const id = body.person.trim();
    if (id === "") return c.json(apiError("invalid_request", "person: Expected an id"), 400);
    const joined = await teams.join(body.invite, { id, name: body.name?.trim() || undefined });
    if ("refused" in joined) {
      return unauthorized(c, REFUSED_INVITE[joined.refused], "invalid_invite");
    }
    return c.json(joined satisfies JoinResponse);
  });

  app.post("/v1/teams", adminOnly, limit(SMALL_BODY_BYTES), async (c) => {
    const body = await readBody(c, createTeamBody);
    if (body instanceof Response) return body;
    const name = body.name.trim();
    const id = teamId(name);
    if (!id) {
      return c.json(
        apiError("invalid_request", "name: Expected at least one letter or digit"),
        400,
      );
    }
    const org = body.org ?? DEFAULT_ORG_ID;
    if (!(await ledger.orgs.getOrg(org))) {
      return c.json(apiError("not_found", `No org ${org}`), 404);
    }
    const created = await teams.createTeam(
      { id, name, org },
      { ttlSeconds: body.invite_ttl_seconds },
    );
    if (!created) {
      return c.json(apiError("team_exists", `A team with id ${id} already exists`), 409);
    }
    return c.json(created satisfies CreateTeamResponse, 201);
  });

  createOrgRoute(app, ledger, adminOnly);

  app.get("/v1/me", adminOnly, (c) =>
    c.json({ kind: "admin", allowed: [...TEAM_ACTIONS] } satisfies MeResponse),
  );

  app.delete("/v1/me/token", adminOnly, (c) =>
    c.json(
      apiError(
        "forbidden",
        "The admin token is set on the server (SELFHOST_TOKEN or the token file in its data dir) and cannot be revoked here",
      ),
      403,
    ),
  );

  const asAdmin: Router = {
    on(method, path, handler, bodyLimit) {
      const run = (c: Context) => handler(c, ADMIN);
      if (bodyLimit) app.on(method, path, adminOnly, bodyLimit, run);
      else app.on(method, path, adminOnly, run);
    },
  };
  sharedRoutes(asAdmin, ledger, now);
}

/** The routes both kinds of token reach, each checking the caller's role. */
function sharedRoutes(router: Router, ledger: Ledger, now: (() => Date) | undefined): void {
  policyRoutes(router, ledger);
  peopleRoutes(router, ledger);
  orgRoutes(router, ledger, now ? { now } : {});
  usageRoutes(router, ledger, now ? { now } : {});
}

/**
 * Checks a person token's events before they are written: an event with no actor is filled in
 * as the person, a person actor must be that person, system actors are refused, and team is
 * set to the person's team. The ledger then moves each event to the team that owns its run's
 * repo, if another team of the org does. A body that is not a JSON object with an events array
 * is passed on as it is, for the events route to report. Events in an older accepted schema
 * version are upgraded first, so the checks read the current shape.
 */
export function stampEvents(
  text: string,
  person: Person,
): { body: string } | { errors: BatchError[] } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { body: text };
  }
  if (!isObject(body) || !Array.isArray(body.events)) return { body: text };
  const errors: BatchError[] = [];
  const stamped = body.events.map((value: unknown, index) => {
    const upgraded = upgradeEvent(value);
    const event = upgraded.ok ? upgraded.value : value;
    if (!isObject(event)) return event;
    const actor = event.actor ?? { kind: "person", id: person.id };
    if (isObject(actor) && actor.kind === "person" && actor.id !== person.id) {
      errors.push({
        index,
        field: "actor.id",
        message: `Expected ${person.id}, the person this token belongs to`,
      });
    }
    if (isObject(actor) && actor.kind === "system") {
      errors.push({
        index,
        field: "actor.kind",
        message: "A person token cannot write system events",
      });
    }
    return { ...event, actor, team: person.team };
  });
  if (errors.length > 0) return { errors };
  return { body: JSON.stringify({ ...body, events: stamped }) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 401 in the shape the admin token check answers with. */
function unauthorized(c: Context, message: string, code = "unauthorized") {
  c.header("WWW-Authenticate", 'Bearer realm="selfhost"');
  return c.json(apiError(code, message), 401);
}

function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "")?.[1];
}

/** Constant-time comparison against one token, like the admin check in auth.ts. */
function sameAs(token: string): (candidate: string) => boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(token);
  return (candidate) => timingSafeEqual(digest(candidate), expected);
}
