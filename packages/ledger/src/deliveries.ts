import type { Database } from "./db.js";

/** How long a delivery id is remembered. GitHub redelivers deliveries from the past 3 days. */
export const DELIVERY_RETENTION_DAYS = 7;

const DAY_MS = 86_400_000;

export interface ClaimOptions {
  /** The X-GitHub-Event header, kept for debugging. */
  event: string;
  /** Default: now. */
  now?: Date;
  /** Ids older than this are forgotten. Default DELIVERY_RETENTION_DAYS. */
  retentionDays?: number;
}

/** GitHub webhook deliveries already handled, by X-GitHub-Delivery id. */
export interface DeliveryStore {
  /**
   * Records a delivery before it is handled. false when the id is already recorded: the same
   * delivery arrived again and must change nothing. Two requests with one id racing get one true.
   * Also forgets ids older than the retention window.
   */
  claim(id: string, options: ClaimOptions): Promise<boolean>;
  /** Forgets a delivery whose handling failed, so GitHub's redelivery is handled again. */
  release(id: string): Promise<void>;
}

export function createDeliveryStore(db: Database): DeliveryStore {
  return {
    async claim(id, { event, now = new Date(), retentionDays = DELIVERY_RETENTION_DAYS }) {
      return db.transaction(async (tx) => {
        await tx.query("DELETE FROM github_deliveries WHERE received_at < $1", [
          new Date(now.getTime() - retentionDays * DAY_MS).toISOString(),
        ]);
        const rows = await tx.query<{ id: string }>(
          `INSERT INTO github_deliveries (id, event, received_at) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO NOTHING RETURNING id`,
          [id, event, now.toISOString()],
        );
        return rows.length === 1;
      });
    },
    async release(id) {
      await db.query("DELETE FROM github_deliveries WHERE id = $1", [id]);
    },
  };
}

/** Review requests GitHub accepted but did not keep: logins and team slugs. */
export interface DroppedReviewers {
  users: string[];
  teams: string[];
}

/** How many pull requests the dropped review requests are kept for, the least recent forgotten. */
export const DROPPED_REVIEWERS_KEPT = 5000;

/**
 * The review requests GitHub did not keep, by pull request (owner/repo#number), so the pull
 * request sync does not ask for them again, before or after a restart.
 */
export interface DroppedReviewerStore {
  /** What was dropped on the pull request; empty lists when nothing was. */
  get(pull: string): Promise<DroppedReviewers>;
  /**
   * Adds what GitHub dropped this time to what it dropped before, and forgets the least recent
   * pull requests beyond `keep` (default DROPPED_REVIEWERS_KEPT).
   */
  add(pull: string, dropped: DroppedReviewers, keep?: number): Promise<DroppedReviewers>;
}

const listOf = (value: unknown): string[] => {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
};

export function createDroppedReviewerStore(db: Database): DroppedReviewerStore {
  return {
    async get(pull) {
      const [row] = await db.query<{ users: unknown; teams: unknown }>(
        "SELECT users, teams FROM github_dropped_reviewers WHERE pull = $1",
        [pull],
      );
      return { users: listOf(row?.users), teams: listOf(row?.teams) };
    },
    async add(pull, dropped, keep = DROPPED_REVIEWERS_KEPT) {
      return db.transaction(async (tx) => {
        const [row] = await tx.query<{ users: unknown; teams: unknown }>(
          "SELECT users, teams FROM github_dropped_reviewers WHERE pull = $1 FOR UPDATE",
          [pull],
        );
        const merged = {
          users: [...new Set([...listOf(row?.users), ...dropped.users])],
          teams: [...new Set([...listOf(row?.teams), ...dropped.teams])],
        };
        if (merged.users.length === 0 && merged.teams.length === 0) return merged;
        await tx.query(
          `INSERT INTO github_dropped_reviewers (pull, users, teams, updated_at)
           VALUES ($1, $2::text::jsonb, $3::text::jsonb, now())
           ON CONFLICT (pull) DO UPDATE
             SET users = excluded.users, teams = excluded.teams, updated_at = excluded.updated_at`,
          [pull, JSON.stringify(merged.users), JSON.stringify(merged.teams)],
        );
        await tx.query(
          `DELETE FROM github_dropped_reviewers WHERE pull IN (
             SELECT pull FROM github_dropped_reviewers ORDER BY updated_at DESC, pull OFFSET $1)`,
          [keep],
        );
        return merged;
      });
    },
  };
}
