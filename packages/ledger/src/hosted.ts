import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Person, PersonRole } from "@selfhost/schema";
import type { Database, Queryable } from "./db.js";
import { hashToken, newPersonToken } from "./teams.js";

/**
 * What a hosted server (SELFHOST_MODE=hosted) needs beyond a self-hosted one: who an email signed
 * in with GitHub or Google already is, new person tokens for them, and each org's seats.
 */
export interface HostedStore {
  /**
   * The person with this id (compared ignoring case) in every team where their membership is
   * active, with the team's org, oldest first.
   */
  memberships(person: string): Promise<{ person: Person; org: string }[]>;
  /**
   * A new person token for someone already in the team; undefined when their membership there
   * is not active. Only its sha256 is stored.
   */
  issueToken(team: string, person: string): Promise<string | undefined>;
  /** People in the org (revoked ones not counted) and its own seat limit, null for the default. */
  seats(org: string): Promise<{ used: number; limit: number | null }>;
  /** Sets the org's own seat limit; null goes back to the server's default. false: no such org. */
  setSeats(org: string, seats: number | null): Promise<boolean>;
}

const iso = (value: unknown) => new Date(value as string | Date).toISOString();

export function createHostedStore(db: Database): HostedStore {
  return {
    async memberships(person) {
      const rows = await db.query<{
        team_id: string;
        id: string;
        name: string | null;
        role: PersonRole;
        created_at: unknown;
        org_id: string;
      }>(
        `SELECT p.team_id, p.id, p.name, p.role, p.created_at, t.org_id
         FROM people p JOIN teams t ON t.id = p.team_id
         WHERE lower(p.id) = lower($1::text) AND p.revoked_at IS NULL
         ORDER BY p.created_at, p.team_id`,
        [person],
      );
      return rows.map((row) => ({
        person: {
          id: row.id,
          ...(row.name === null ? {} : { name: row.name }),
          team: row.team_id,
          role: row.role,
          created_at: iso(row.created_at),
        },
        org: row.org_id,
      }));
    },

    async issueToken(team, person) {
      const token = newPersonToken();
      const rows = await db.query(
        `INSERT INTO tokens (hash, kind, team_id, person_id)
         SELECT $1::text, 'person', p.team_id, p.id FROM people p
         WHERE p.team_id = $2 AND p.id = $3 AND p.revoked_at IS NULL
         RETURNING hash`,
        [hashToken(token), team, person],
      );
      return rows.length > 0 ? token : undefined;
    },

    async seats(org) {
      const [row] = await db.query<{ used: number; seats: number | null }>(
        `SELECT (SELECT count(DISTINCT lower(p.id))::int FROM people p
           JOIN teams t ON t.id = p.team_id
           WHERE t.org_id = $1 AND p.revoked_at IS NULL) AS used,
         (SELECT seats FROM orgs WHERE id = $1) AS seats`,
        [org],
      );
      return { used: Number(row?.used ?? 0), limit: row?.seats ?? null };
    },

    async setSeats(org, seats) {
      const rows = await db.query("UPDATE orgs SET seats = $2 WHERE id = $1 RETURNING id", [
        org,
        seats,
      ]);
      return rows.length > 0;
    },
  };
}

/**
 * Whether row-level security binds the role the server connects as. Superusers and roles with
 * BYPASSRLS skip every policy, so on them one org's request could read another's rows. The
 * message says what to do; undefined when the role is bound.
 */
export async function rowSecurityProblem(db: Database): Promise<string | undefined> {
  if (db.kind !== "postgres") {
    return "Hosted mode needs Postgres (DATABASE_URL=postgres://...): the embedded database runs as a superuser, which row-level security does not bind.";
  }
  const [role] = await db.query<{ name: string; bypass: boolean }>(
    "SELECT rolname AS name, rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user",
  );
  if (!role?.bypass) return undefined;
  return `Hosted mode needs a database role that row-level security binds, and ${role.name} is a superuser or has BYPASSRLS. Connect as a role made with CREATE ROLE ... LOGIN NOSUPERUSER NOBYPASSRLS that owns the selfhost tables.`;
}

/**
 * Makes row-level security bind the server's own role on a hosted server: checks it is no
 * superuser and has no BYPASSRLS (rowSecurityProblem), then turns on FORCE ROW LEVEL SECURITY
 * on every table of the schema that has policies, so they bind the tables' owner, which the
 * server is. Migration 0019 leaves FORCE off, so a self-hosted install does not change. The
 * message says what to do; undefined when it is done.
 */
export async function enforceRowSecurity(db: Database): Promise<string | undefined> {
  const problem = await rowSecurityProblem(db);
  if (problem) return problem;
  const tables = await db.query<{ name: string; owned: boolean }>(
    `SELECT c.relname AS name, pg_has_role(c.relowner, 'USAGE') AS owned
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relrowsecurity
       AND NOT c.relforcerowsecurity
     ORDER BY c.relname`,
  );
  const foreign = tables.filter((table) => !table.owned).map((table) => table.name);
  if (foreign.length > 0) {
    return `Hosted mode turns on FORCE ROW LEVEL SECURITY, which needs the server's role to own ${foreign.join(", ")}. Run the hosted server as the role that ran the migrations.`;
  }
  for (const { name } of tables) {
    await db.exec(`ALTER TABLE "${name.replaceAll('"', '""')}" FORCE ROW LEVEL SECURITY`);
  }
  return undefined;
}

/**
 * Seals and opens the secrets the server keeps at rest (notification target URLs) with a key of
 * the org they belong to, on a hosted server. Each org's key is made on first use, wrapped with
 * the server's key and stored in org_keys. A value written before sealing was on reads as it is.
 */
export interface SecretBox {
  seal(org: string, plain: string): Promise<string>;
  open(org: string, stored: string): Promise<string>;
}

const SEALED = "sealed:v1:";
const KEY_BYTES = 32;

function encrypt(key: Buffer, plain: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
}

function decrypt(key: Buffer, sealed: string): Buffer {
  const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !body) throw new Error("A sealed value is damaged");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** A box over org_keys, with `serverKey` (32 bytes) wrapping every org's key. */
export function createSecretBox(db: Queryable, serverKey: Buffer): SecretBox {
  if (serverKey.length !== KEY_BYTES) {
    throw new Error(`The server key must be ${KEY_BYTES} bytes, got ${serverKey.length}`);
  }
  const keys = new Map<string, Promise<Buffer>>();
  const load = async (org: string): Promise<Buffer> => {
    const read = async () =>
      (
        await db.query<{ wrapped_key: string }>(
          "SELECT wrapped_key FROM org_keys WHERE org_id = $1",
          [org],
        )
      )[0]?.wrapped_key;
    let wrapped = await read();
    if (wrapped === undefined) {
      await db.query(
        `INSERT INTO org_keys (org_id, wrapped_key) SELECT id, $2 FROM orgs WHERE id = $1
         ON CONFLICT (org_id) DO NOTHING`,
        [org, encrypt(serverKey, randomBytes(KEY_BYTES))],
      );
      // Another server may have made it first: read whichever was kept.
      wrapped = await read();
    }
    if (wrapped === undefined) throw new Error(`No org ${org}`);
    return decrypt(serverKey, wrapped);
  };
  const keyOf = (org: string) => {
    let key = keys.get(org);
    if (!key) {
      key = load(org);
      keys.set(org, key);
      key.catch(() => keys.delete(org));
    }
    return key;
  };
  return {
    async seal(org, plain) {
      return `${SEALED}${encrypt(await keyOf(org), Buffer.from(plain, "utf8"))}`;
    },
    async open(org, stored) {
      if (!stored.startsWith(SEALED)) return stored;
      return decrypt(await keyOf(org), stored.slice(SEALED.length)).toString("utf8");
    },
  };
}
