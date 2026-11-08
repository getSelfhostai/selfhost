import type { Ledger } from "@selfhost/ledger";
import {
  AddPersonRequestSchema,
  CreateInviteRequestSchema,
  type CreateInviteResponse,
  createValidator,
  type Invite,
  type Person,
  type RevokeTokensResponse,
  SetRoleRequestSchema,
  type TeamInfo,
  type TeamPeopleResponse,
  UpdateTeamRequestSchema,
} from "@selfhost/schema";
import { apiError, authorize, type Caller, type Router, roleIn } from "./access.js";
import { limit, readBody, SMALL_BODY_BYTES } from "./http.js";

const createInviteBody = createValidator(CreateInviteRequestSchema);
const setRoleBody = createValidator(SetRoleRequestSchema);
const addPersonBody = createValidator(AddPersonRequestSchema);
const updateTeamBody = createValidator(UpdateTeamRequestSchema);

/** Who made a change, for the record: the person, or "admin" for the admin token. */
const actorOf = (caller: Caller) => (caller.kind === "admin" ? "admin" : caller.person.id);

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Team settings and people, for both kinds of token: invites, revoking access, the people of a
 * team and their roles, adding someone from another team of the org, and renaming the team.
 * Each route checks the caller's role in the team against the permission table.
 */
export function peopleRoutes(router: Router, ledger: Ledger): void {
  const { teams } = ledger;
  const small = limit(SMALL_BODY_BYTES);

  router.on(
    "POST",
    "/v1/teams/:team/invites",
    async (c, caller) => {
      const team = c.req.param("team") ?? "";
      const refused = await authorize(c, caller, team, "invites");
      if (refused) return refused;
      const body = await readBody(c, createInviteBody);
      if (body instanceof Response) return body;
      const invite = await teams.createInvite(team, {
        ttlSeconds: body.ttl_seconds,
        email: body.email?.trim(),
      });
      if (!invite) return c.json(apiError("not_found", `No team ${team}`), 404);
      return c.json(invite satisfies CreateInviteResponse, 201);
    },
    small,
  );

  router.on("DELETE", "/v1/invites/:id", async (c, caller) => {
    const id = c.req.param("id") ?? "";
    const invite = await teams.getInvite(id);
    // A person token learns nothing about invites of teams it cannot manage.
    const refused = invite ? await authorize(c, caller, invite.team, "invites") : undefined;
    if (refused) return refused;
    if (!invite) return c.json(apiError("not_found", `No invite ${id}`), 404);
    const revoked = await teams.revokeInvite(id);
    if (!revoked) return c.json(apiError("not_found", `No invite ${id}`), 404);
    return c.json(revoked satisfies Invite);
  });

  router.on("DELETE", "/v1/teams/:team/people/:person/tokens", async (c, caller) => {
    const team = c.req.param("team") ?? "";
    const who = c.req.param("person") ?? "";
    const self = caller.kind === "person" && sameId(caller.person.id, who);
    if (!self) {
      const refused = await authorize(c, caller, team, "people");
      if (refused) return refused;
      // Admins manage members and admins; only owners can cut off an owner.
      const target = await teams.getPerson(team, who);
      if (target?.role === "owner") {
        const owner = await authorize(c, caller, team, "roles");
        if (owner) return owner;
      }
    } else if (!(await roleIn(caller, team))) {
      return c.json(apiError("forbidden", `You are not in team ${team}.`), 403);
    }
    const revoked = await teams.revokePerson(team, who);
    if (!revoked) return c.json(apiError("not_found", `No person ${who} in team ${team}`), 404);
    return c.json(revoked satisfies RevokeTokensResponse);
  });

  router.on("GET", "/v1/teams/:team/people", async (c, caller) => {
    const team = c.req.param("team") ?? "";
    const refused = await authorize(c, caller, team, "read");
    if (refused) return refused;
    if (!(await teams.getTeam(team))) return c.json(apiError("not_found", `No team ${team}`), 404);
    return c.json({ team, people: await teams.listPeople(team) } satisfies TeamPeopleResponse);
  });

  router.on(
    "POST",
    "/v1/teams/:team/people",
    async (c, caller) => {
      const team = c.req.param("team") ?? "";
      const refused = await authorize(c, caller, team, "people");
      if (refused) return refused;
      const body = await readBody(c, addPersonBody);
      if (body instanceof Response) return body;
      const role = body.role ?? "member";
      if (role !== "member") {
        const owner = await authorize(c, caller, team, "roles");
        if (owner) return owner;
      }
      const added = await teams.addPerson(team, body.person.trim(), role, actorOf(caller));
      if ("refused" in added) {
        if (added.refused === "no_team") {
          return c.json(apiError("not_found", `No team ${team}`), 404);
        }
        if (added.refused === "existing_person") {
          return c.json(
            apiError("person_exists", `${body.person} is in team ${team} already`),
            409,
          );
        }
        return c.json(
          apiError(
            "not_in_org",
            `${body.person} is in no other team of this org. Invite them instead: selfhost team invite --email ${body.person}`,
          ),
          404,
        );
      }
      return c.json(added.person satisfies Person, 201);
    },
    small,
  );

  router.on(
    "PUT",
    "/v1/teams/:team/people/:person/role",
    async (c, caller) => {
      const team = c.req.param("team") ?? "";
      const who = c.req.param("person") ?? "";
      const refused = await authorize(c, caller, team, "roles");
      if (refused) return refused;
      const body = await readBody(c, setRoleBody);
      if (body instanceof Response) return body;
      const changed = await teams.setRole(team, who, body.role, actorOf(caller));
      if ("refused" in changed) {
        if (changed.refused === "last_owner") {
          return c.json(
            apiError(
              "last_owner",
              `${who} is the last owner of team ${team}. Make someone else an owner first.`,
            ),
            409,
          );
        }
        return c.json(apiError("not_found", `No person ${who} in team ${team}`), 404);
      }
      return c.json(changed.person satisfies Person);
    },
    small,
  );

  router.on(
    "PATCH",
    "/v1/teams/:team",
    async (c, caller) => {
      const team = c.req.param("team") ?? "";
      const refused = await authorize(c, caller, team, "settings.write");
      if (refused) return refused;
      const body = await readBody(c, updateTeamBody);
      if (body instanceof Response) return body;
      const name = body.name.trim();
      if (name === "") return c.json(apiError("invalid_request", "name: Expected a name"), 400);
      const renamed = await teams.renameTeam(team, name);
      if (!renamed) return c.json(apiError("not_found", `No team ${team}`), 404);
      return c.json(renamed satisfies TeamInfo);
    },
    small,
  );
}
