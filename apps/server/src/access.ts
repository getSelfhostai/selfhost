import type { TeamStore } from "@selfhost/ledger";
import {
  type ApiError,
  type Membership,
  type Person,
  type PersonRole,
  roleAllows,
  rolesFor,
  type TeamAction,
} from "@selfhost/schema";
import type { Context, MiddlewareHandler } from "hono";

/**
 * Who makes a request: the server's admin token, which can do everything, or a person token.
 * A person acts in every team of their org they belong to, under their role in each.
 */
export type Caller = { kind: "admin" } | PersonCaller;

export interface PersonCaller {
  kind: "person";
  /** The person, in the team their token was issued for. */
  person: Person;
  /** Their org and every team of it they are in, read once per request. */
  scope(): Promise<{ org: string; memberships: Membership[] }>;
}

export function personCaller(teams: TeamStore, person: Person): PersonCaller {
  let loaded: Promise<{ org: string; memberships: Membership[] }> | undefined;
  return {
    kind: "person",
    person,
    scope: () => {
      loaded ??= (async () => {
        const org = (await teams.getTeam(person.team))?.org ?? "";
        return { org, memberships: await teams.memberships(org, person.id) };
      })();
      return loaded;
    },
  };
}

/** The caller's role in a team, or undefined when they are not in it. Admin token: owner. */
export async function roleIn(caller: Caller, team: string): Promise<PersonRole | undefined> {
  if (caller.kind === "admin") return "owner";
  if (team === caller.person.team) return caller.person.role;
  const { memberships } = await caller.scope();
  return memberships.find((m) => m.team === team)?.role;
}

const DOING: Record<TeamAction, string> = {
  read: "Reading this team",
  work: "Working in this team",
  "policy.write": "Changing the team's rules",
  "settings.write": "Changing team settings",
  invites: "Creating and revoking invites",
  people: "Adding people and revoking their access",
  roles: "Changing roles",
  "org.overview": "The cross-team view",
};

export const apiError = (code: string, message: string): ApiError => ({ error: { code, message } });

const A_ROLE: Record<PersonRole, string> = {
  owner: "an owner",
  admin: "an admin",
  member: "a member",
};

/** 403 naming what was refused, the roles that may do it and the caller's own. */
export function forbidden(c: Context, action: TeamAction, team: string, role?: PersonRole) {
  const needs = rolesFor(action).join(" or ");
  const message =
    role === undefined
      ? `You are not in team ${team}.`
      : `${DOING[action]} needs the ${needs} role in team ${team}; you are ${A_ROLE[role]} there.`;
  return c.json(apiError("forbidden", message), 403);
}

/** What shared routes are registered on: the person token's routes or the admin token's. */
export interface Router {
  on(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    handler: (c: Context, caller: Caller) => Promise<Response>,
    limit?: MiddlewareHandler,
  ): void;
}

/**
 * undefined when the caller may take `action` in `team`, else the 403 to answer with. A team
 * the caller is not in answers 403 whether or not it exists, so it reveals nothing.
 */
export async function authorize(
  c: Context,
  caller: Caller,
  team: string,
  action: TeamAction,
): Promise<Response | undefined> {
  const role = await roleIn(caller, team);
  if (role === undefined) return forbidden(c, action, team);
  return roleAllows(role, action) ? undefined : forbidden(c, action, team, role);
}

/** The org a person token belongs to; undefined for the admin token. */
export async function orgOf(caller: Caller): Promise<string | undefined> {
  return caller.kind === "admin" ? undefined : (await caller.scope()).org;
}
