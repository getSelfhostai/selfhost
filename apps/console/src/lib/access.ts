import type { MeResponse, PersonRole, TeamAction } from "@selfhost/schema";

/**
 * What the caller may do in each team, so the console offers only those buttons. It mirrors
 * ROLE_PERMISSIONS in @selfhost/schema (a test keeps them equal) instead of importing it, which
 * would load every schema into the page. The server checks every request anyway.
 */
const MEMBER: readonly TeamAction[] = ["read", "work"];
const ADMIN: readonly TeamAction[] = [
  ...MEMBER,
  "policy.write",
  "settings.write",
  "invites",
  "people",
  "org.overview",
];

export const ROLE_ACTIONS: Readonly<Record<PersonRole, readonly TeamAction[]>> = {
  owner: [...ADMIN, "roles"],
  admin: ADMIN,
  member: MEMBER,
};

/** The caller's role in a team: the admin token counts as an owner everywhere. */
export function roleIn(me: MeResponse, team: string | undefined): PersonRole | undefined {
  if (me.kind === "admin") return "owner";
  if (team === undefined) return undefined;
  if (me.team?.id === team && me.role) return me.role;
  return me.memberships?.find((m) => m.team === team)?.role;
}

export function can(me: MeResponse, team: string | undefined, action: TeamAction): boolean {
  if (me.kind === "admin") return true;
  if (team !== undefined && me.team?.id === team && me.allowed) {
    return me.allowed.includes(action);
  }
  const role = roleIn(me, team);
  return role !== undefined && ROLE_ACTIONS[role].includes(action);
}

/** The team a person token is about when none is picked: their token's team. */
export function homeTeam(me: MeResponse): string | undefined {
  return me.team?.id ?? me.memberships?.[0]?.team;
}

/** Who acts on review items: a person token always acts as its person; the admin token as admin. */
export function actorName(me: MeResponse): string {
  if (me.kind === "admin") return "Admin token";
  const role = me.role ? ` (${me.role})` : "";
  return `${me.person?.name || me.person?.id || "Signed in"}${role}`;
}
