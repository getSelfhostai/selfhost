import type { Queryable } from "@selfhost/ledger";
import type { NotifyCadence, NotifyKind, NotifySend, NotifyTarget } from "@selfhost/schema";
import { maskUrl, serviceOf } from "./mask.js";

/** A target as the store holds it. Only delivery reads `url`; nothing returns it. */
export interface StoredTarget {
  person: string;
  name: string;
  url: string;
  created_at: string;
}

/** How many failed sends of one thing to one target before it is given up. */
export const MAX_ATTEMPTS = 3;
/** Send records are kept this long. */
export const SEND_RETENTION_DAYS = 90;

const iso = (value: unknown) => new Date(value as string | Date).toISOString();

/** What the API shows of a target: its name, service and masked URL, never the URL. */
export function publicTarget(target: StoredTarget): NotifyTarget {
  return {
    name: target.name,
    service: serviceOf(target.url),
    masked: maskUrl(target.url),
    created_at: target.created_at,
  };
}

/**
 * Notification targets, digest settings and the send record, in the ledger's database
 * (migration 0011). Person ids compare without case, as the review list's owners do.
 */
export function notifyStore(db: Queryable) {
  return {
    async targets(person: string): Promise<StoredTarget[]> {
      const rows = await db.query<{
        person: string;
        name: string;
        url: string;
        created_at: unknown;
      }>(
        "SELECT person, name, url, created_at FROM notify_targets WHERE lower(person) = lower($1) ORDER BY created_at, name",
        [person],
      );
      return rows.map((row) => ({ ...row, created_at: iso(row.created_at) }));
    },

    /** Everyone with at least one target. */
    async people(): Promise<string[]> {
      const rows = await db.query<{ person: string }>(
        "SELECT DISTINCT person FROM notify_targets ORDER BY person",
      );
      return rows.map((row) => row.person);
    },

    /**
     * undefined when the person already has a target with this name. `at` is when it was added
     * (default: the database's clock): it gets nothing raised before then.
     */
    async addTarget(
      person: string,
      name: string,
      url: string,
      at?: Date,
    ): Promise<StoredTarget | undefined> {
      const [row] = await db.query<{ created_at: unknown }>(
        `INSERT INTO notify_targets (person, name, url, created_at)
         VALUES ($1, $2, $3, coalesce($4::timestamptz, now()))
         ON CONFLICT DO NOTHING RETURNING created_at`,
        [person, name, url, at?.toISOString() ?? null],
      );
      return row ? { person, name, url, created_at: iso(row.created_at) } : undefined;
    },

    async removeTarget(person: string, name: string): Promise<boolean> {
      const rows = await db.query<{ name: string }>(
        "DELETE FROM notify_targets WHERE lower(person) = lower($1) AND name = $2 RETURNING name",
        [person, name],
      );
      return rows.length > 0;
    },

    /** The person's own cadence, or undefined when they never picked one. */
    async digest(person: string): Promise<NotifyCadence | undefined> {
      const [row] = await db.query<{ digest: NotifyCadence | null }>(
        "SELECT digest FROM notify_settings WHERE lower(person) = lower($1)",
        [person],
      );
      return row?.digest ?? undefined;
    },

    async setDigest(person: string, digest: NotifyCadence): Promise<void> {
      await db.query(
        `INSERT INTO notify_settings (person, digest) VALUES ($1, $2)
         ON CONFLICT (person) DO UPDATE SET digest = excluded.digest, updated_at = now()`,
        [person, digest],
      );
    },

    async record(person: string, send: NotifySend): Promise<void> {
      await db.query(
        `INSERT INTO notify_sends (person, target, kind, subject, ok, error, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
        [
          person,
          send.target,
          send.kind,
          send.subject ?? null,
          send.ok,
          send.error ?? null,
          send.at,
        ],
      );
    },

    /**
     * Whether `kind` about `subject` is done for each of the person's targets: sent, or failed
     * MAX_ATTEMPTS times. Keyed by target name.
     */
    async done(person: string, kind: NotifyKind, subject: string): Promise<Set<string>> {
      const rows = await db.query<{ target: string; sent: boolean; failures: number }>(
        `SELECT target, bool_or(ok) AS sent, count(*) FILTER (WHERE NOT ok)::int AS failures
         FROM notify_sends WHERE lower(person) = lower($1) AND kind = $2 AND subject = $3
         GROUP BY target`,
        [person, kind, subject],
      );
      return new Set(
        rows
          .filter((row) => row.sent || Number(row.failures) >= MAX_ATTEMPTS)
          .map((row) => row.target),
      );
    },

    /** The person's sends, newest first. */
    async sends(person: string, limit = 50): Promise<NotifySend[]> {
      const rows = await db.query<{
        target: string;
        kind: NotifyKind;
        subject: string | null;
        ok: boolean;
        error: string | null;
        sent_at: unknown;
      }>(
        `SELECT target, kind, subject, ok, error, sent_at FROM notify_sends
         WHERE lower(person) = lower($1) ORDER BY sent_at DESC, id DESC LIMIT $2`,
        [person, limit],
      );
      return rows.map((row) => ({
        at: iso(row.sent_at),
        target: row.target,
        kind: row.kind,
        ...(row.subject === null ? {} : { subject: row.subject }),
        ok: row.ok,
        ...(row.error === null ? {} : { error: row.error }),
      }));
    },

    /** Deletes send records older than the retention. */
    async prune(now: Date): Promise<void> {
      const before = new Date(now.getTime() - SEND_RETENTION_DAYS * 86_400_000);
      await db.query("DELETE FROM notify_sends WHERE sent_at < $1::timestamptz", [
        before.toISOString(),
      ]);
    },
  };
}

export type NotifyStore = ReturnType<typeof notifyStore>;
