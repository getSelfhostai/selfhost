import { createHash, randomBytes } from "node:crypto";
import type { Person, PersonRole, TeamInfo } from "@selfhost/schema";
import type { Database } from "./db.js";

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

/** Teams, people and tokens on a team server, in the same database as the events. */
export interface TeamStore {
  /** Creates a team and an invite for it. undefined when the id is taken. */
  createTeam(team: {
    id: string;
    name: string;
  }): Promise<{ team: TeamInfo; invite: string } | undefined>;
  getTeam(id: string): Promise<TeamInfo | undefined>;
  /**
   * Exchanges an invite for a person token. The first person in a team becomes its owner,
   * everyone after a member; joining again with the same id adds a token for the same person.
   * undefined when the invite is unknown or revoked.
   */
  join(invite: string, person: { id: string; name?: string }): Promise<JoinResult | undefined>;
  /** The person a person token belongs to, or undefined for an unknown or revoked token. */
  personForToken(token: string): Promise<Person | undefined>;
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

const PERSON_COLUMNS = "p.team_id, p.id, p.name, p.role, p.created_at";

export function createTeamStore(db: Database): TeamStore {
  return {
    async createTeam({ id, name }) {
      return db.transaction(async (tx) => {
        const [row] = await tx.query<TeamRow>(
          `INSERT INTO teams (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING
           RETURNING id, name, created_at`,
          [id, name],
        );
        if (!row) return undefined;
        const invite = newToken(INVITE_PREFIX);
        await tx.query("INSERT INTO tokens (hash, kind, team_id) VALUES ($1, 'invite', $2)", [
          hashToken(invite),
          id,
        ]);
        return { team: toTeam(row), invite };
      });
    },

    async getTeam(id) {
      const [row] = await db.query<TeamRow>(
        "SELECT id, name, created_at FROM teams WHERE id = $1",
        [id],
      );
      return row ? toTeam(row) : undefined;
    },

    async join(invite, person) {
      return db.transaction(async (tx) => {
        // Locking the team row serializes joins, so exactly one person becomes the owner.
        const [team] = await tx.query<TeamRow>(
          `SELECT t.id, t.name, t.created_at FROM tokens k JOIN teams t ON t.id = k.team_id
           WHERE k.hash = $1 AND k.kind = 'invite' AND k.revoked_at IS NULL
           FOR UPDATE OF t`,
          [hashToken(invite)],
        );
        if (!team) return undefined;
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
