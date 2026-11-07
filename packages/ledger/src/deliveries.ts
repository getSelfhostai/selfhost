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
