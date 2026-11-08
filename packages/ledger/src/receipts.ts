import { randomUUID } from "node:crypto";
import type { Receipt } from "@selfhost/schema";
import type { Database } from "./db.js";

/** A receipt as stored, with its id and the comment it was posted as. */
export interface StoredReceipt {
  id: string;
  /** owner/name in lower case. */
  repo: string;
  pull: number;
  /** In lower case. */
  head_sha: string;
  created_at: string;
  comment_url?: string;
  receipt: Receipt;
}

/** Proof receipts of pull requests, one per CI run. */
export interface ReceiptStore {
  /** Stores a receipt the server has validated and returns it with its new id. */
  add(receipt: Receipt, options?: { now?: Date }): Promise<StoredReceipt>;
  get(id: string): Promise<StoredReceipt | undefined>;
  /**
   * The newest receipt for a pull request: for `headSha` when given, else for any commit.
   * `repo` is compared ignoring case.
   */
  latest(repo: string, pull: number, headSha?: string): Promise<StoredReceipt | undefined>;
  /** Records the pull request comment the receipt was posted as. */
  setComment(id: string, url: string): Promise<void>;
}

interface Row {
  id: string;
  repo: string;
  pull: number;
  head_sha: string;
  created_at: unknown;
  comment_url: string | null;
  body: unknown;
}

const COLUMNS = "id::text AS id, repo, pull, head_sha, created_at, comment_url, body";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stored(row: Row): StoredReceipt {
  return {
    id: row.id,
    repo: row.repo,
    pull: Number(row.pull),
    head_sha: row.head_sha,
    created_at: new Date(row.created_at as string | Date).toISOString(),
    ...(row.comment_url ? { comment_url: row.comment_url } : {}),
    receipt: (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as Receipt,
  };
}

export function createReceiptStore(db: Database): ReceiptStore {
  return {
    async add(receipt, { now = new Date() } = {}) {
      const [row] = await db.query<Row>(
        `INSERT INTO receipts (id, repo, pull, head_sha, verdict, created_at, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb) RETURNING ${COLUMNS}`,
        [
          randomUUID(),
          receipt.repo.toLowerCase(),
          receipt.pull.number,
          receipt.pull.head_sha.toLowerCase(),
          receipt.verdict,
          now.toISOString(),
          JSON.stringify(receipt),
        ],
      );
      if (!row) throw new Error("The receipt was not stored");
      return stored(row);
    },
    async get(id) {
      if (!UUID.test(id)) return undefined;
      const [row] = await db.query<Row>(`SELECT ${COLUMNS} FROM receipts WHERE id = $1`, [id]);
      return row ? stored(row) : undefined;
    },
    async latest(repo, pull, headSha) {
      const params: unknown[] = [repo.toLowerCase(), pull];
      if (headSha) params.push(headSha.toLowerCase());
      const [row] = await db.query<Row>(
        `SELECT ${COLUMNS} FROM receipts WHERE repo = $1 AND pull = $2
         ${headSha ? "AND head_sha = $3" : ""}
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        params,
      );
      return row ? stored(row) : undefined;
    },
    async setComment(id, url) {
      await db.query("UPDATE receipts SET comment_url = $2 WHERE id = $1", [id, url]);
    },
  };
}
