import { createHash, randomBytes } from "node:crypto";
import {
  type CreateInviteResponse,
  type CreateTeamResponse,
  DEFAULT_ORG_ID,
  INVITE_TTL_DEFAULT_SECONDS,
  type Invite,
  type Membership,
  type Person,
  type PersonRole,
  type RevokeTokensResponse,
  type TeamInfo,
} from "@selfhost/schema";
import type { Database, Queryable } from "./db.js";

export interface TeamPolicy {
  team: string;
  /** The selfhost.toml text as it was set. */
  text: string;
  updatedAt: string;
}

export interface JoinResult {
  team: TeamInfo;
  person: Person;
  /** The new person token. Only its sha256 is stored, so this is the one chance to read it. */
  token: string;
}

/**
 * Why an invite was refused: no such invite, past its expiry, revoked, for another person, or
 * a team-wide invite used for a person who is already in the team.
 */
export type JoinRefusal =
  | "unknown"
  | "expired"
  | "revoked"
  | "wrong_person"
  | "existing_person"
  | "seat_limit";

export interface JoinOptions {
  /**
   * The most people an org may have (revoked ones not counted), unless the org sets its own
   * (orgs.seats): someone new to the org is refused with seat_limit once it is full. Without it
   * there is no limit, as on a self-hosted server.
   */
  seats?: number;
}

/**
 * Why a role change was refused: no such person in the team, or it would leave the team
 * with no owner.
 */
export type RoleRefusal = "not_found" | "last_owner";

/**
 * Why adding someone to a team was refused: no such team, they are in no other team of its
 * org (new people join with an invite), or they are in the team already.
 */
export type AddPersonRefusal = "no_team" | "not_in_org" | "existing_person";

export interface InviteOptions {
  /** Seconds the invite works for. Default 7 days. */
  ttlSeconds?: number;
  /** The one person the invite is for; joining with it makes this email the person id. */
  email?: string;
}

/** Teams, people and tokens on a team server, in the same database as the events. */
export interface TeamStore {
  /**
   * Creates a team in an org (default: the default org) and an invite for it. undefined when
   * the id is taken or the org does not exist.
   */
  createTeam(
    team: { id: string; name: string; org?: string },
    invite?: Omit<InviteOptions, "email">,
  ): Promise<CreateTeamResponse | undefined>;
  getTeam(id: string): Promise<TeamInfo | undefined>;
  /** Renames a team; its id stays. undefined when there is no such team. */
  renameTeam(id: string, name: string): Promise<TeamInfo | undefined>;
  /** The teams of an org, by id. */
  listTeams(org: string): Promise<TeamInfo[]>;
  /**
   * Everyone in a team, owners first, then admins, then members, each by when they joined.
   * People revoked from it are not in it.
   */
  listPeople(team: string): Promise<Person[]>;
  /** A person in a team; undefined when they are not in it or were revoked from it. */
  getPerson(team: string, person: string): Promise<Person | undefined>;
  /**
   * Every team of `org` this person is in (ids compared ignoring case), with their role in
   * each, by team id. Teams they were revoked from are not in it: a person's token acts only
   * in teams where their membership is active.
   */
  memberships(org: string, person: string): Promise<Membership[]>;
  /**
   * Changes a person's role in a team, recording who changed it. Refused when it would leave
   * the team with no owner, or the person was revoked from it. Changes to the same team run one
   * at a time.
   */
  setRole(
    team: string,
    person: string,
    role: PersonRole,
    by: string,
  ): Promise<{ person: Person } | { refused: RoleRefusal }>;
  /**
   * Adds someone already in another team of the same org, under the id and name they have
   * there. They keep the tokens they hold; with one they can read and act in this team too.
   * Someone revoked from this team comes back with the given role.
   */
  addPerson(
    team: string,
    person: string,
    role: PersonRole,
    by: string,
  ): Promise<{ person: Person } | { refused: AddPersonRefusal }>;
  /** Another invite for a team. undefined when there is no such team. */
  createInvite(team: string, options?: InviteOptions): Promise<CreateInviteResponse | undefined>;
  /** An invite by its id, the sha256 of the code. */
  getInvite(id: string): Promise<Invite | undefined>;
  /** Revokes an invite by its id, the sha256 of the code. undefined when there is no such invite. */
  revokeInvite(id: string): Promise<Invite | undefined>;
  /** A team's invites that still work (not revoked, not expired), newest first. */
  listInvites(team: string): Promise<Invite[]>;
  /**
   * Exchanges an invite for a person token. The first person in a team becomes its owner,
   * everyone after a member. A team-wide invite only adds people new to the org: it is refused
   * for a person id already in any team of the team's org, so holding it never gives someone
   * else's identity or role, there or in another team of the org (a person's tokens act in
   * every team of the org they are in). An invite for an email joins only that person, under
   * that email, and also works for a person already in the team or the org, adding another
   * token. Refused too when the invite is unknown, expired or revoked, or names someone else,
   * unless `guessed` says the id was the client's own guess (no person was given): an invite
   * for an email then joins as that email. With options.seats, refused with seat_limit for
   * someone new to a full org.
   */
  join(
    invite: string,
    person: { id: string; name?: string; guessed?: boolean },
    options?: JoinOptions,
  ): Promise<JoinResult | { refused: JoinRefusal }>;
  /**
   * The person a person token belongs to, or undefined for an unknown or revoked token, or one
   * whose person was revoked from its team.
   */
  personForToken(token: string): Promise<Person | undefined>;
  /**
   * The person with this id (compared ignoring case) in each team where they still hold a
   * person token, with that team's org, oldest first: who a sign-in proxy's email stands for.
   * Someone whose tokens were all revoked, or who was revoked from the team, is not in it.
   */
  peopleWithAccess(person: string): Promise<{ person: Person; org: string }[]>;
  /**
   * Revokes a person's membership of a team, every token they hold for it, and the open invites
   * for their email, so they cannot join again with one. Their tokens from other teams of the org
   * no longer reach this team. undefined when the team has no such person.
   */
  revokePerson(team: string, person: string): Promise<RevokeTokensResponse | undefined>;
  /**
   * Revokes one person token, as leaving a team does. When it was the person's last live token
   * for that team, their membership there ends too. undefined for an unknown or revoked token.
   */
  revokeToken(token: string): Promise<RevokeTokensResponse | undefined>;
  getPolicy(team: string): Promise<TeamPolicy | undefined>;
  setPolicy(team: string, text: string): Promise<TeamPolicy>;
}

const INVITE_PREFIX = "selfhost_inv_";
const PERSON_TOKEN_PREFIX = "selfhost_pt_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/** A new person token, as joining hands out. */
export const newPersonToken = () => newToken(PERSON_TOKEN_PREFIX);

const iso = (value: unknown) => new Date(value as string | Date).toISOString();

interface TeamRow {
  id: string;
  name: string;
  org_id: string;
  created_at: unknown;
}

interface InviteRow {
  hash: string;
  team_id: string;
  email: string | null;
  created_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
}

interface PersonRow {
  team_id: string;
  id: string;
  name: string | null;
  role: PersonRole;
  created_at: unknown;
}

const toTeam = (row: TeamRow): TeamInfo => ({
  id: row.id,
  name: row.name,
  org: row.org_id,
  created_at: iso(row.created_at),
});

const TEAM_COLUMNS = "id, name, org_id, created_at";

const toPerson = (row: PersonRow): Person => ({
  id: row.id,
  ...(row.name === null ? {} : { name: row.name }),
  team: row.team_id,
  role: row.role,
  created_at: iso(row.created_at),
});

const toInvite = (row: InviteRow): Invite => ({
  id: row.hash,
  team: row.team_id,
  ...(row.email === null ? {} : { email: row.email }),
  created_at: iso(row.created_at),
  expires_at: iso(row.expires_at),
  ...(row.revoked_at === null ? {} : { revoked_at: iso(row.revoked_at) }),
});

const PERSON_COLUMNS = "p.team_id, p.id, p.name, p.role, p.created_at";
/** A membership that was not revoked: the only kind that gives access to a team. */
const ACTIVE = "p.revoked_at IS NULL";
const ROLE_ORDER = "CASE p.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END";
const INVITE_COLUMNS = "hash, team_id, email, created_at, expires_at, revoked_at";

/** Adds an invite for a team that exists; undefined when it does not. */
async function insertInvite(
  tx: Queryable,
  team: string,
  { ttlSeconds = INVITE_TTL_DEFAULT_SECONDS, email }: InviteOptions,
): Promise<CreateInviteResponse | undefined> {
  const code = newToken(INVITE_PREFIX);
  const [row] = await tx.query<InviteRow>(
    `INSERT INTO tokens (hash, kind, team_id, email, expires_at)
     SELECT $1::text, 'invite', id, $3::text, now() + make_interval(secs => $4::double precision)
     FROM teams WHERE id = $2
     RETURNING ${INVITE_COLUMNS}`,
    [hashToken(code), team, email ?? null, ttlSeconds],
  );
  if (!row) return undefined;
  const { id, email: forEmail, expires_at } = toInvite(row);
  return {
    invite: code,
    id,
    team,
    ...(forEmail === undefined ? {} : { email: forEmail }),
    expires_at,
  };
}

/**
 * Whether adding `person` would take the org past its seats: they are in none of its teams yet
 * and it already has as many people as its limit (orgs.seats, else `seats`). Locks the org row,
 * so two joins in different teams of one org cannot both take the last seat.
 */
async function orgFull(tx: Queryable, org: string, person: string, seats: number) {
  const [row] = await tx.query<{ seat_limit: number }>(
    "SELECT coalesce(seats, $2::int) AS seat_limit FROM orgs WHERE id = $1 FOR UPDATE",
    [org, seats],
  );
  const [counted] = await tx.query<{ used: number; member: boolean }>(
    `SELECT count(DISTINCT lower(p.id))::int AS used,
       coalesce(bool_or(lower(p.id) = lower($2::text)), false) AS member
     FROM people p JOIN teams t ON t.id = p.team_id
     WHERE t.org_id = $1 AND ${ACTIVE}`,
    [org, person],
  );
  if (!row || !counted || counted.member) return false;
  return Number(counted.used) >= Number(row.seat_limit);
}

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function createTeamStore(db: Database): TeamStore {
  return {
    async createTeam({ id, name, org = DEFAULT_ORG_ID }, options = {}) {
      return db.transaction(async (tx) => {
        const [row] = await tx.query<TeamRow>(
          `INSERT INTO teams (id, name, org_id) SELECT $1::text, $2::text, id FROM orgs WHERE id = $3
           ON CONFLICT (id) DO NOTHING
           RETURNING ${TEAM_COLUMNS}`,
          [id, name, org],
        );
        if (!row) return undefined;
        const invite = await insertInvite(tx, id, { ttlSeconds: options.ttlSeconds });
        if (!invite) throw new Error(`team ${id} missing right after insert`);
        return { team: toTeam(row), invite: invite.invite, invite_expires_at: invite.expires_at };
      });
    },

    async getTeam(id) {
      const [row] = await db.query<TeamRow>(`SELECT ${TEAM_COLUMNS} FROM teams WHERE id = $1`, [
        id,
      ]);
      return row ? toTeam(row) : undefined;
    },

    async renameTeam(id, name) {
      const [row] = await db.query<TeamRow>(
        `UPDATE teams SET name = $2 WHERE id = $1 RETURNING ${TEAM_COLUMNS}`,
        [id, name],
      );
      return row ? toTeam(row) : undefined;
    },

    async listTeams(org) {
      const rows = await db.query<TeamRow>(
        `SELECT ${TEAM_COLUMNS} FROM teams WHERE org_id = $1 ORDER BY id`,
        [org],
      );
      return rows.map(toTeam);
    },

    async listPeople(team) {
      const rows = await db.query<PersonRow>(
        `SELECT ${PERSON_COLUMNS} FROM people p WHERE p.team_id = $1 AND ${ACTIVE}
         ORDER BY ${ROLE_ORDER}, p.created_at, p.id`,
        [team],
      );
      return rows.map(toPerson);
    },

    async getPerson(team, person) {
      const [row] = await db.query<PersonRow>(
        `SELECT ${PERSON_COLUMNS} FROM people p WHERE p.team_id = $1 AND p.id = $2 AND ${ACTIVE}`,
        [team, person],
      );
      return row ? toPerson(row) : undefined;
    },

    async memberships(org, person) {
      return db.query<Membership>(
        `SELECT p.team_id AS team, p.role FROM people p JOIN teams t ON t.id = p.team_id
         WHERE t.org_id = $1 AND lower(p.id) = lower($2::text) AND ${ACTIVE}
         ORDER BY p.team_id`,
        [org, person],
      );
    },

    async setRole(team, person, role, by) {
      return db.transaction(async (tx) => {
        // Locking the team row serializes role changes, so two owners demoting each other at
        // the same time cannot leave the team with none.
        await tx.query("SELECT id FROM teams WHERE id = $1 FOR UPDATE", [team]);
        const [current] = await tx.query<PersonRow>(
          `SELECT ${PERSON_COLUMNS} FROM people p WHERE p.team_id = $1 AND p.id = $2 AND ${ACTIVE}`,
          [team, person],
        );
        if (!current) return { refused: "not_found" as const };
        if (current.role === "owner" && role !== "owner") {
          const owners = await tx.query(
            `SELECT 1 FROM people p WHERE p.team_id = $1 AND p.role = 'owner' AND ${ACTIVE}`,
            [team],
          );
          if (owners.length <= 1) return { refused: "last_owner" as const };
        }
        if (current.role === role) return { person: toPerson(current) };
        const [row] = await tx.query<PersonRow>(
          `UPDATE people p SET role = $3, role_changed_at = now(), role_changed_by = $4
           WHERE p.team_id = $1 AND p.id = $2
           RETURNING ${PERSON_COLUMNS}`,
          [team, person, role, by],
        );
        if (!row) throw new Error(`person ${person} missing right after the check`);
        return { person: toPerson(row) };
      });
    },

    async addPerson(team, person, role, by) {
      return db.transaction(async (tx) => {
        const [found] = await tx.query<{ org_id: string }>(
          "SELECT org_id FROM teams WHERE id = $1 FOR UPDATE",
          [team],
        );
        if (!found) return { refused: "no_team" as const };
        const [existing] = await tx.query<{ id: string; active: boolean }>(
          `SELECT p.id, ${ACTIVE} AS active FROM people p
           WHERE p.team_id = $1 AND lower(p.id) = lower($2::text)`,
          [team, person],
        );
        if (existing?.active) return { refused: "existing_person" as const };
        const [elsewhere] = await tx.query<{ id: string; name: string | null }>(
          `SELECT p.id, p.name FROM people p JOIN teams t ON t.id = p.team_id
           WHERE t.org_id = $1 AND lower(p.id) = lower($2::text) AND p.team_id <> $3 AND ${ACTIVE}
           ORDER BY p.created_at LIMIT 1`,
          [found.org_id, person, team],
        );
        if (!elsewhere) return { refused: "not_in_org" as const };
        if (existing) {
          // Revoked from this team before: the membership comes back with the role given now.
          const [row] = await tx.query<PersonRow>(
            `UPDATE people p SET revoked_at = NULL, role = $3, role_changed_at = now(),
               role_changed_by = $4
             WHERE p.team_id = $1 AND p.id = $2
             RETURNING ${PERSON_COLUMNS}`,
            [team, existing.id, role, by],
          );
          if (!row) throw new Error(`person ${person} missing right after the check`);
          return { person: toPerson(row) };
        }
        const [row] = await tx.query<PersonRow>(
          `INSERT INTO people AS p (team_id, id, name, role, role_changed_at, role_changed_by)
           VALUES ($1, $2, $3, $4, now(), $5)
           RETURNING ${PERSON_COLUMNS}`,
          [team, elsewhere.id, elsewhere.name, role, by],
        );
        if (!row) throw new Error(`person ${person} missing right after insert`);
        return { person: toPerson(row) };
      });
    },

    async createInvite(team, options = {}) {
      return insertInvite(db, team, options);
    },

    async getInvite(id) {
      const [row] = await db.query<InviteRow>(
        `SELECT ${INVITE_COLUMNS} FROM tokens WHERE hash = $1 AND kind = 'invite'`,
        [id],
      );
      return row ? toInvite(row) : undefined;
    },

    async listInvites(team) {
      const rows = await db.query<InviteRow>(
        `SELECT ${INVITE_COLUMNS} FROM tokens
         WHERE team_id = $1 AND kind = 'invite' AND revoked_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC, hash`,
        [team],
      );
      return rows.map(toInvite);
    },

    async revokeInvite(id) {
      const [row] = await db.query<InviteRow>(
        `UPDATE tokens SET revoked_at = coalesce(revoked_at, now())
         WHERE hash = $1 AND kind = 'invite'
         RETURNING ${INVITE_COLUMNS}`,
        [id],
      );
      return row ? toInvite(row) : undefined;
    },

    async join(invite, joining, options = {}) {
      return db.transaction(async (tx) => {
        // Locking the team row serializes joins, so exactly one person becomes the owner.
        const [team] = await tx.query<
          TeamRow & { email: string | null; revoked: boolean; expired: boolean }
        >(
          `SELECT t.id, t.name, t.org_id, t.created_at, k.email, k.revoked_at IS NOT NULL AS revoked,
             k.expires_at <= now() AS expired
           FROM tokens k JOIN teams t ON t.id = k.team_id
           WHERE k.hash = $1 AND k.kind = 'invite'
           FOR UPDATE OF t`,
          [hashToken(invite)],
        );
        if (!team) return { refused: "unknown" };
        if (team.revoked) return { refused: "revoked" };
        if (team.expired) return { refused: "expired" };
        if (team.email !== null && !joining.guessed && !sameEmail(joining.id, team.email)) {
          return { refused: "wrong_person" };
        }
        const { guessed: _guessed, ...given } = joining;
        const person = { ...given, id: team.email ?? joining.id };
        if (team.email === null) {
          // Ids that differ only in case count as the same person, as emails do.
          const [existing] = await tx.query(
            `SELECT 1 FROM people p JOIN teams t ON t.id = p.team_id
             WHERE t.org_id = $1 AND lower(p.id) = lower($2::text)`,
            [team.org_id, person.id],
          );
          if (existing) return { refused: "existing_person" };
        }
        if (options.seats !== undefined) {
          const full = await orgFull(tx, team.org_id, person.id, options.seats);
          if (full) return { refused: "seat_limit" };
        }
        // Someone revoked from the team comes back with the role an invite gives, not the one
        // they had: re-inviting a removed owner by email must not make them an owner again. A
        // team needs an owner, so the last one keeps the role.
        await tx.query(
          `UPDATE people p SET role = 'member', role_changed_at = now(), role_changed_by = 'invite'
           WHERE p.team_id = $1 AND p.id = $2 AND p.role <> 'member' AND p.revoked_at IS NOT NULL
             AND EXISTS (SELECT 1 FROM people o WHERE o.team_id = $1 AND o.id <> $2
               AND o.role = 'owner' AND o.revoked_at IS NULL)`,
          [team.id, person.id],
        );
        await tx.query(
          "UPDATE people SET revoked_at = NULL WHERE team_id = $1 AND id = $2 AND revoked_at IS NOT NULL",
          [team.id, person.id],
        );
        await tx.query(
          `INSERT INTO people (team_id, id, name, role)
           SELECT $1::text, $2::text, $3::text, CASE WHEN EXISTS (SELECT 1 FROM people WHERE team_id = $1)
             THEN 'member' ELSE 'owner' END
           ON CONFLICT (team_id, id) DO NOTHING`,
          [team.id, person.id, person.name ?? null],
        );
        const [row] = await tx.query<PersonRow>(
          `SELECT ${PERSON_COLUMNS} FROM people p WHERE p.team_id = $1 AND p.id = $2`,
          [team.id, person.id],
        );
        if (!row) throw new Error(`person ${person.id} missing right after insert`);
        const token = newToken(PERSON_TOKEN_PREFIX);
        await tx.query(
          "INSERT INTO tokens (hash, kind, team_id, person_id) VALUES ($1, 'person', $2, $3)",
          [hashToken(token), team.id, person.id],
        );
        return { team: toTeam(team), person: toPerson(row), token };
      });
    },

    async revokePerson(team, person) {
      return db.transaction(async (tx) => {
        const [found] = await tx.query("SELECT 1 FROM people WHERE team_id = $1 AND id = $2", [
          team,
          person,
        ]);
        if (!found) return undefined;
        await tx.query(
          `UPDATE people SET revoked_at = coalesce(revoked_at, now())
           WHERE team_id = $1 AND id = $2`,
          [team, person],
        );
        const tokens = await tx.query(
          `UPDATE tokens SET revoked_at = now()
           WHERE team_id = $1 AND revoked_at IS NULL
             AND (person_id = $2::text OR (kind = 'invite' AND lower(email) = lower($2::text)))
           RETURNING hash`,
          [team, person],
        );
        return { team, person, revoked: tokens.length };
      });
    },

    async revokeToken(token) {
      return db.transaction(async (tx) => {
        const [row] = await tx.query<{ team_id: string; person_id: string }>(
          `UPDATE tokens SET revoked_at = now()
           WHERE hash = $1 AND kind = 'person' AND revoked_at IS NULL
           RETURNING team_id, person_id`,
          [hashToken(token)],
        );
        if (!row) return undefined;
        // Their last token for the team: they left it, so other teams' tokens no longer reach it.
        await tx.query(
          `UPDATE people p SET revoked_at = now()
           WHERE p.team_id = $1 AND p.id = $2 AND p.revoked_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM tokens k WHERE k.team_id = $1 AND k.person_id = $2
               AND k.kind = 'person' AND k.revoked_at IS NULL)`,
          [row.team_id, row.person_id],
        );
        return { team: row.team_id, person: row.person_id, revoked: 1 };
      });
    },

    async peopleWithAccess(person) {
      const rows = await db.query<PersonRow & { org_id: string }>(
        `SELECT ${PERSON_COLUMNS}, t.org_id FROM people p JOIN teams t ON t.id = p.team_id
         WHERE lower(p.id) = lower($1::text) AND ${ACTIVE} AND EXISTS (
           SELECT 1 FROM tokens k
           WHERE k.team_id = p.team_id AND k.person_id = p.id AND k.kind = 'person'
             AND k.revoked_at IS NULL)
         ORDER BY p.created_at, p.team_id`,
        [person],
      );
      return rows.map((row) => ({ person: toPerson(row), org: row.org_id }));
    },

    async personForToken(token) {
      const [row] = await db.query<PersonRow>(
        `SELECT ${PERSON_COLUMNS} FROM tokens k
         JOIN people p ON p.team_id = k.team_id AND p.id = k.person_id
         WHERE k.hash = $1 AND k.kind = 'person' AND k.revoked_at IS NULL AND ${ACTIVE}`,
        [hashToken(token)],
      );
      return row ? toPerson(row) : undefined;
    },

    async getPolicy(team) {
      const [row] = await db.query<{ policy_text: string | null; policy_updated_at: unknown }>(
        "SELECT policy_text, policy_updated_at FROM teams WHERE id = $1",
        [team],
      );
      if (row?.policy_text == null) return undefined;
      return { team, text: row.policy_text, updatedAt: iso(row.policy_updated_at) };
    },

    async setPolicy(team, text) {
      const [row] = await db.query<{ policy_updated_at: unknown }>(
        `UPDATE teams SET policy_text = $2, policy_updated_at = now() WHERE id = $1
         RETURNING policy_updated_at`,
        [team, text],
      );
      if (!row) throw new Error(`no team ${team}`);
      return { team, text, updatedAt: iso(row.policy_updated_at) };
    },
  };
}
