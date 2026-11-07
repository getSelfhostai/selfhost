import { createHash, timingSafeEqual } from "node:crypto";
import type { JoinRefusal, Ledger } from "@selfhost/ledger";
import {
  type ApiError,
  CreateInviteRequestSchema,
  type CreateInviteResponse,
  CreateTeamRequestSchema,
  type CreateTeamResponse,
  createValidator,
  type IngestEventsError,
  type InvalidPolicyError,
  type Invite,
  JoinRequestSchema,
  type JoinResponse,
  type MeResponse,
  type Person,
  PolicyQuerySchema,
  parseConfig,
  type RevokeTokensResponse,
  SetPolicyRequestSchema,
  type ValidationResult,
} from "@selfhost/schema";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireBearerToken } from "./auth.js";
import { eventRoutes, MAX_BODY_BYTES } from "./events.js";
import { policyResponse } from "./policy.js";

export interface TeamRouteOptions {
  ledger: Ledger;
  /** The admin token. */
  token: string;
}

type PersonEnv = { Bindings: { person: Person } };
type EventsEnv = { team: string };
type BatchError = IngestEventsError["errors"][number];

/** Routes that need no bearer token: /v1/join takes the invite code in the body instead. */
const PUBLIC_PATHS = new Set(["/v1/health", "/v1/join"]);
const SMALL_BODY_BYTES = 64 * 1024;
/** selfhost.toml text is capped at 1,000,000 characters; JSON escaping can grow it. */
const POLICY_BODY_BYTES = 8 * 1024 * 1024;
const OWNER_ROLES = new Set(["owner", "admin"]);

const createTeamBody = createValidator(CreateTeamRequestSchema);
const createInviteBody = createValidator(CreateInviteRequestSchema);
const joinBody = createValidator(JoinRequestSchema);
const setPolicyBody = createValidator(SetPolicyRequestSchema);
const policyQuery = createValidator(PolicyQuerySchema);

const apiError = (code: string, message: string): ApiError => ({ error: { code, message } });

const REFUSED_INVITE: Record<JoinRefusal, string> = {
  unknown: "Unknown invite code",
  expired: "This invite code has expired. Ask a team admin for a new one.",
  revoked: "This invite code was revoked. Ask a team admin for a new one.",
  wrong_person: "This invite is for someone else. Join with the email it was sent to.",
  existing_person:
    "This person is already in the team, and a team-wide invite only adds new people. Ask a team admin for an invite for this person (selfhost team invite --email <person>), or to revoke them and invite them again.",
};

const limit = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) =>
      c.json(apiError("payload_too_large", `Request body over ${maxSize} bytes`), 413),
  });

/** Team id from a team name: lower case words joined by dashes, at most 64 characters. */
export function teamId(name: string): string | undefined {
  const id = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
  return id === "" ? undefined : id;
}

/**
 * Teams, invites and person tokens. Call it before the admin token check: it serves /v1/join,
 * whose credential is the invite in the body, and answers every request that carries a person
 * token itself, so a person token reaches only the person routes below. Requests with the
 * admin token or no valid token go on to the rest of the app unchanged.
 *
 * There is no route that forwards anything to a model provider: agents keep talking to their
 * vendors directly, and this server only stores events and the team policy.
 */
export function teamRoutes(app: Hono, { ledger, token }: TeamRouteOptions): void {
  const { teams } = ledger;
  const isAdminToken = sameAs(token);
  const adminOnly = requireBearerToken(token);

  // The ordinary events routes, limited to the person's team. Writes reach them only after
  // their events are stamped.
  const events = new Hono();
  eventRoutes(events, ledger, { team: (c) => (c.env as EventsEnv).team });
  events.onError(rethrow);

  const person = new Hono<PersonEnv>();
  person.onError(rethrow);
  person.notFound((c) =>
    c.json(
      apiError(
        "forbidden",
        "A person token can write and read its team's events, read /v1/me and its team's policy, and revoke itself. This route needs the admin token.",
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

  person.get("/v1/events", (c) =>
    events.fetch(c.req.raw, { team: c.env.person.team } satisfies EventsEnv),
  );

  // selfhost team leave: the token making the request stops working.
  person.delete("/v1/me/token", async (c) => {
    const revoked = await teams.revokeToken(bearerToken(c.req.header("authorization")) ?? "");
    if (!revoked) return unauthorized(c, "Missing or invalid bearer token");
    return c.json(revoked satisfies RevokeTokensResponse);
  });

  person.get("/v1/me", async (c) => {
    const team = await teams.getTeam(c.env.person.team);
    return c.json({ kind: "person", person: c.env.person, team } satisfies MeResponse);
  });

  person.get("/v1/policy", async (c) => {
    const query = policyQuery.validate(c.req.query());
    if (!query.ok) return invalidQuery(c, query.errors);
    const own = c.env.person;
    if (query.value.team !== undefined && query.value.team !== own.team) {
      return c.json(apiError("forbidden", "A person token reads only its own team's policy"), 403);
    }
    const policy = await teams.getPolicy(own.team);
    if (!policy) return noPolicy(c, own.team);
    const { person: who = own.id, agent } = query.value;
    return c.json(policyResponse(policy, { team: own.team, person: who, agent }));
  });

  person.put("/v1/policy", limit(POLICY_BODY_BYTES), async (c) => {
    const own = c.env.person;
    const team = c.req.query("team") ?? own.team;
    if (team !== own.team || !OWNER_ROLES.has(own.role)) {
      return c.json(
        apiError("forbidden", "Only the team's owners and admins can change its policy"),
        403,
      );
    }
    return setPolicy(c, team);
  });

  app.use("*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    const bearer = bearerToken(c.req.header("authorization"));
    if (bearer === undefined || isAdminToken(bearer)) return next();
    const found = await teams.personForToken(bearer);
    // An unknown token goes on to the admin check, which answers 401.
    if (!found) return next();
    return person.fetch(c.req.raw, { person: found });
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
    const created = await teams.createTeam({ id, name }, { ttlSeconds: body.invite_ttl_seconds });
    if (!created) {
      return c.json(apiError("team_exists", `A team with id ${id} already exists`), 409);
    }
    return c.json(created satisfies CreateTeamResponse, 201);
  });

  app.post("/v1/teams/:team/invites", adminOnly, limit(SMALL_BODY_BYTES), async (c) => {
    const body = await readBody(c, createInviteBody);
    if (body instanceof Response) return body;
    const team = c.req.param("team");
    const invite = await teams.createInvite(team, {
      ttlSeconds: body.ttl_seconds,
      email: body.email?.trim(),
    });
    if (!invite) return c.json(apiError("not_found", `No team ${team}`), 404);
    return c.json(invite satisfies CreateInviteResponse, 201);
  });

  app.delete("/v1/invites/:id", adminOnly, async (c) => {
    const id = c.req.param("id");
    const revoked = await teams.revokeInvite(id);
    if (!revoked) return c.json(apiError("not_found", `No invite ${id}`), 404);
    return c.json(revoked satisfies Invite);
  });

  app.delete("/v1/teams/:team/people/:person/tokens", adminOnly, async (c) => {
    const team = c.req.param("team");
    const who = c.req.param("person");
    const revoked = await teams.revokePerson(team, who);
    if (!revoked) return c.json(apiError("not_found", `No person ${who} in team ${team}`), 404);
    return c.json(revoked satisfies RevokeTokensResponse);
  });

  app.get("/v1/me", adminOnly, (c) => c.json({ kind: "admin" } satisfies MeResponse));

  app.delete("/v1/me/token", adminOnly, (c) =>
    c.json(
      apiError(
        "forbidden",
        "The admin token is set on the server (SELFHOST_TOKEN or the token file in its data dir) and cannot be revoked here",
      ),
      403,
    ),
  );

  app.get("/v1/policy", adminOnly, async (c) => {
    const query = policyQuery.validate(c.req.query());
    if (!query.ok) return invalidQuery(c, query.errors);
    const { team, person: who, agent } = query.value;
    if (team === undefined) {
      return c.json(apiError("invalid_query", "team: Required with the admin token"), 400);
    }
    const policy = await teams.getPolicy(team);
    if (!policy) return noPolicy(c, team);
    return c.json(policyResponse(policy, { team, person: who, agent }));
  });

  app.put("/v1/policy", adminOnly, limit(POLICY_BODY_BYTES), async (c) => {
    const team = c.req.query("team");
    if (team === undefined) {
      return c.json(apiError("invalid_query", "team: Required with the admin token"), 400);
    }
    return setPolicy(c, team);
  });

  async function setPolicy(c: Context, team: string) {
    const unexpected = Object.keys(c.req.query()).find((key) => key !== "team");
    if (unexpected) {
      return c.json(apiError("invalid_query", `${unexpected}: Unknown query parameter`), 400);
    }
    const body = await readBody(c, setPolicyBody);
    if (body instanceof Response) return body;
    const parsed = parseConfig(body.text);
    if (!parsed.ok) {
      const error: InvalidPolicyError = {
        error: { code: "invalid_policy", message: "selfhost.toml is invalid, nothing was stored" },
        errors: parsed.errors,
      };
      return c.json(error, 400);
    }
    if (!(await teams.getTeam(team))) {
      return c.json(apiError("not_found", `No team ${team}`), 404);
    }
    const policy = await teams.setPolicy(team, body.text);
    return c.json(policyResponse(policy, { team }));
  }

  async function noPolicy(c: Context, team: string) {
    if (!(await teams.getTeam(team))) return c.json(apiError("not_found", `No team ${team}`), 404);
    return c.json(
      apiError("no_policy", `Team ${team} has no selfhost.toml yet. Set one with PUT /v1/policy.`),
      404,
    );
  }
}

/**
 * Checks a person token's events before they are written: an event with no actor is filled in
 * as the person, a person actor must be that person, system actors are refused, and team is
 * set to the person's team. A body that is not a JSON object with an events array is passed on
 * as it is, for the events route to report.
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
  const stamped = body.events.map((event: unknown, index) => {
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

/** Lets errors in a nested app reach the outer app's error handler, so every 500 looks the same. */
function rethrow(error: Error): never {
  throw error;
}

async function readBody<T>(
  c: Context,
  validator: { validate(value: unknown): ValidationResult<T> },
): Promise<T | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(apiError("invalid_request", "Expected a JSON body"), 400);
  }
  const result = validator.validate(body);
  if (result.ok) return result.value;
  const [first] = result.errors;
  return c.json(apiError("invalid_request", `${first?.field}: ${first?.message}`), 400);
}

function invalidQuery(c: Context, errors: { field: string; message: string }[]) {
  const [first] = errors;
  return c.json(apiError("invalid_query", `${first?.field}: ${first?.message}`), 400);
}
