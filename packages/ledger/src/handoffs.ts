import type { Handoff, HandoffState } from "@selfhost/schema";
import type { Database } from "./db.js";

export interface HandoffFilter {
  /** Handoffs of these teams; every team (and none) when absent. */
  teams?: readonly string[];
  run?: string;
  /** The new owner, compared ignoring case. */
  to?: string;
  state?: HandoffState;
  /** Default 50, at most 500. */
  limit?: number;
}

/** Run handoffs (see migrations/0013_handoffs.sql). */
export interface HandoffStore {
  /**
   * Stores a new handoff with its redacted transcript, if any, and marks the run's earlier
   * pending handoffs superseded, deleting their transcripts: only the newest owner takes over.
   */
  create(handoff: Handoff, transcript?: string): Promise<void>;
  get(id: string): Promise<Handoff | undefined>;
  /** Newest first. */
  list(filter?: HandoffFilter): Promise<Handoff[]>;
  /** The run's handoffs, oldest first. */
  ofRun(runId: string): Promise<Handoff[]>;
  /**
   * Marks a pending handoff taken and gives its transcript once: the stored copy is deleted in
   * the same write. undefined when the handoff is not pending, so two takeovers cannot both
   * get it.
   */
  take(id: string, at: Date): Promise<{ handoff: Handoff; transcript: string | null } | undefined>;
}

interface Row {
  body: unknown;
}

const parse = (row: Row): Handoff =>
  (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as Handoff;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createHandoffStore(db: Database): HandoffStore {
  return {
    async create(handoff, transcript) {
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE handoffs SET state = 'superseded', transcript = NULL,
             body = jsonb_set(body, '{state}', '"superseded"')
           WHERE run_id = $1 AND state = 'pending'`,
          [handoff.run_id],
        );
        await tx.query(
          `INSERT INTO handoffs (id, run_id, team, from_person, to_person, state, created_at,
             taken_at, body, transcript)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10)`,
          [
            handoff.id,
            handoff.run_id,
            handoff.team,
            handoff.from,
            handoff.to,
            handoff.state,
            handoff.created_at,
            handoff.taken_at,
            JSON.stringify(handoff),
            transcript ?? null,
          ],
        );
      });
    },
    async get(id) {
      if (!UUID.test(id)) return undefined;
      const [row] = await db.query<Row>("SELECT body FROM handoffs WHERE id = $1", [id]);
      return row ? parse(row) : undefined;
    },
    async list({ teams, run, to, state, limit = 50 } = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (teams) {
        params.push([...teams]);
        where.push(`team = ANY($${params.length}::text[])`);
      }
      if (run !== undefined) {
        params.push(run);
        where.push(`run_id = $${params.length}`);
      }
      if (to !== undefined) {
        params.push(to.toLowerCase());
        where.push(`lower(to_person) = $${params.length}`);
      }
      if (state !== undefined) {
        params.push(state);
        where.push(`state = $${params.length}`);
      }
      params.push(Math.min(Math.max(limit, 1), 500));
      const rows = await db.query<Row>(
        `SELECT body FROM handoffs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(parse);
    },
    async ofRun(runId) {
      const rows = await db.query<Row>(
        "SELECT body FROM handoffs WHERE run_id = $1 ORDER BY created_at, id",
        [runId],
      );
      return rows.map(parse);
    },
    async take(id, at) {
      if (!UUID.test(id)) return undefined;
      const takenAt = at.toISOString();
      // The transcript is read and cleared in one statement: the old value comes back from the
      // row as it was before the update.
      const [row] = await db.query<{ body: unknown; transcript: string | null }>(
        `WITH old AS (SELECT id, transcript FROM handoffs WHERE id = $1 AND state = 'pending'
                      FOR UPDATE)
         UPDATE handoffs h SET state = 'taken', taken_at = $2::timestamptz, transcript = NULL,
           body = jsonb_set(jsonb_set(h.body, '{state}', '"taken"'), '{taken_at}',
             to_jsonb($3::text))
         FROM old WHERE h.id = old.id
         RETURNING h.body, old.transcript`,
        [id, takenAt, takenAt],
      );
      if (!row) return undefined;
      return { handoff: parse(row), transcript: row.transcript };
    },
  };
}
