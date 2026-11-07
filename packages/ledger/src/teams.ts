import { createHash, randomBytes } from "node:crypto";
import {
  type CreateInviteResponse,
  type CreateTeamResponse,
  INVITE_TTL_DEFAULT_SECONDS,
  type Invite,
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
export type JoinRefusal = "unknown" | "expired" | "revoked" | "wrong_person" | "existing_person";

export interface InviteOptions {
  /** Seconds the invite works for. Default 7 days. */
  ttlSeconds?: number;
  /** The one person the invite is for; joining with it makes this email the person id. */
  email?: string;
}

/** Teams, people and tokens on a team server, in the same database as the events. */
export interface TeamStore {
  /** Creates a team and an invite for it. undefined when the id is taken. */
  createTeam(
    team: { id: string; name: string },
    invite?: Omit<InviteOptions, "email">,
  ): Promise<CreateTeamResponse | undefined>;
  getTeam(id: string): Promise<TeamInfo | undefined>;
  /** Another invite for a team. undefined when there is no such team. */
  createInvite(team: string, options?: InviteOptions): Promise<CreateInviteResponse | undefined>;
  /** Revokes an invite by its id, the sha256 of the code. undefined when there is no such invite. */
  revokeInvite(id: string): Promise<Invite | undefined>;
  /**
   * Exchanges an invite for a person token. The first person in a team becomes its owner,
   * everyone after a member. A team-wide invite only adds new people: it is refused for a
   * person id already in the team, so holding it never gives someone else's identity or role.
   * An invite for an email joins only that person, under that email, and also works for a
   * person already in the team, adding another token. Refused too when the invite is unknown,
   * expired or revoked, or names someone else.
   */
  join(
    invite: string,
    person: { id: string; name?: string },
  ): Promise<JoinResult | { refused: JoinRefusal }>;
  /** The person a person token belongs to, or undefined for an unknown or revoked token. */
  personForToken(token: string): Promise<Person | undefined>;
  /**
   * Revokes every token a person holds, and the open invites for their email, so they cannot
   * join again with one. undefined when the team has no such person.
   */
  revokePerson(team: string, person: string): Promise<RevokeTokensResponse | undefined>;
  /** Revokes one person token, as leaving a team does. undefined for an unknown or revoked token. */
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

const iso = (value: unknown) => new Date(value as string | Date).toISOString();

interface TeamRow {
  id: string;
  name: string;
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
  created_at: iso(row.created_at),
});

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

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function createTeamStore(db: Database): TeamStore {
  return {
    async createTeam({ id, name }, options = {}) {
      return db.transaction(async (tx) => {
        const [row] = await tx.query<TeamRow>(
          `INSERT INTO teams (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING
           RETURNING id, name, created_at`,
          [id, name],
        );
        if (!row) return undefined;
        const invite = await insertInvite(tx, id, { ttlSeconds: options.ttlSeconds });
        if (!invite) throw new Error(`team ${id} missing right after insert`);
        return { team: toTeam(row), invite: invite.invite, invite_expires_at: invite.expires_at };
      });
    },

    async getTeam(id) {
      const [row] = await db.query<TeamRow>(
        "SELECT id, name, created_at FROM teams WHERE id = $1",
        [id],
      );
      return row ? toTeam(row) : undefined;
    },

    async createInvite(team, options = {}) {
      return insertInvite(db, team, options);
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

    async join(invite, joining) {
      return db.transaction(async (tx) => {
        // Locking the team row serializes joins, so exactly one person becomes the owner.
        const [team] = await tx.query<
          TeamRow & { email: string | null; revoked: boolean; expired: boolean }
        >(
          `SELECT t.id, t.name, t.created_at, k.email, k.revoked_at IS NOT NULL AS revoked,
             k.expires_at <= now() AS expired
           FROM tokens k JOIN teams t ON t.id = k.team_id
           WHERE k.hash = $1 AND k.kind = 'invite'
           FOR UPDATE OF t`,
          [hashToken(invite)],
        );
        if (!team) return { refused: "unknown" };
        if (team.revoked) return { refused: "revoked" };
        if (team.expired) return { refused: "expired" };
        if (team.email !== null && !sameEmail(joining.id, team.email)) {
          return { refused: "wrong_person" };
        }
        const person = { ...joining, id: team.email ?? joining.id };
        if (team.email === null) {
          // Ids that differ only in case count as the same person, as emails do.
          const [existing] = await tx.query(
            "SELECT 1 FROM people WHERE team_id = $1 AND lower(id) = lower($2::text)",
            [team.id, person.id],
          );
          if (existing) return { refused: "existing_person" };
        }
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
      const [row] = await db.query<{ team_id: string; person_id: string }>(
        `UPDATE tokens SET revoked_at = now()
         WHERE hash = $1 AND kind = 'person' AND revoked_at IS NULL
         RETURNING team_id, person_id`,
        [hashToken(token)],
      );
      return row ? { team: row.team_id, person: row.person_id, revoked: 1 } : undefined;
    },

    async personForToken(token) {
      const [row] = await db.query<PersonRow>(
        `SELECT ${PERSON_COLUMNS} FROM tokens k
         JOIN people p ON p.team_id = k.team_id AND p.id = k.person_id
         WHERE k.hash = $1 AND k.kind = 'person' AND k.revoked_at IS NULL`,
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
