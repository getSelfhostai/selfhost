import type { ContextFile, ContextProposal, ContextProposalState } from "@selfhost/schema";
import type { Database } from "./db.js";

/** An org's or a team's context files as stored. */
export interface StoredContext {
  files: ContextFile[];
  updatedAt: string;
}

/** A proposal with the files of the item it adds. */
export interface StoredProposal extends ContextProposal {
  files: ContextFile[];
}

/** What becomes of an open proposal. */
export type Settlement =
  | { state: "applied"; by: string; files: ContextFile[] }
  | { state: "refused"; by?: string; note: string };

/** The org and team context layers and the proposals to add items to a team's. */
export interface ContextStore {
  getOrgContext(org: string): Promise<StoredContext | undefined>;
  setOrgContext(org: string, files: ContextFile[]): Promise<StoredContext>;
  getTeamContext(team: string): Promise<StoredContext | undefined>;
  setTeamContext(team: string, files: ContextFile[]): Promise<StoredContext>;
  addProposal(proposal: {
    id: string;
    team: string;
    person: string;
    item: string;
    files: ContextFile[];
  }): Promise<ContextProposal>;
  getProposal(id: string): Promise<StoredProposal | undefined>;
  /** A team's proposals, newest first. */
  listProposals(
    team: string,
    options?: { state?: ContextProposalState; limit?: number },
  ): Promise<StoredProposal[]>;
  /**
   * Settles an open proposal in one transaction: `decide` gets the team's current files (read
   * under a lock on the team row) and says whether the proposal is applied, with the team's new
   * files, or refused. undefined when the proposal is not open any more, and nothing changes.
   */
  settle(
    id: string,
    decide: (current: ContextFile[], proposal: StoredProposal) => Settlement,
  ): Promise<ContextProposal | undefined>;
}

const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const json = <T>(value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as T;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProposalRow {
  id: string;
  team_id: string;
  person: string;
  item: string;
  files: unknown;
  state: ContextProposalState;
  created_at: unknown;
  decided_at: unknown;
  decided_by: string | null;
  note: string | null;
}

const PROPOSAL_COLUMNS =
  "id::text AS id, team_id, person, item, files, state, created_at, decided_at, decided_by, note";

function toProposal(row: ProposalRow): StoredProposal {
  return {
    id: row.id,
    team: row.team_id,
    person: row.person,
    item: row.item,
    state: row.state,
    created_at: iso(row.created_at),
    ...(row.decided_at ? { decided_at: iso(row.decided_at) } : {}),
    ...(row.decided_by ? { decided_by: row.decided_by } : {}),
    ...(row.note ? { note: row.note } : {}),
    files: json<ContextFile[]>(row.files),
  };
}

/** The proposal as the API shows it, without its files. */
export function proposalInfo({ files: _files, ...proposal }: StoredProposal): ContextProposal {
  return proposal;
}

type Owner = "orgs" | "teams";

export function createContextStore(db: Database): ContextStore {
  async function get(table: Owner, id: string): Promise<StoredContext | undefined> {
    const [row] = await db.query<{ context_files: unknown; context_updated_at: unknown }>(
      `SELECT context_files, context_updated_at FROM ${table} WHERE id = $1`,
      [id],
    );
    if (row?.context_files == null) return undefined;
    return { files: json(row.context_files), updatedAt: iso(row.context_updated_at) };
  }

  async function set(table: Owner, id: string, files: ContextFile[]): Promise<StoredContext> {
    const [row] = await db.query<{ context_updated_at: unknown }>(
      `UPDATE ${table} SET context_files = $2::text::jsonb, context_updated_at = now()
       WHERE id = $1 RETURNING context_updated_at`,
      [id, JSON.stringify(files)],
    );
    if (!row) throw new Error(`no ${table === "orgs" ? "org" : "team"} ${id}`);
    return { files, updatedAt: iso(row.context_updated_at) };
  }

  return {
    getOrgContext: (org) => get("orgs", org),
    setOrgContext: (org, files) => set("orgs", org, files),
    getTeamContext: (team) => get("teams", team),
    setTeamContext: (team, files) => set("teams", team, files),

    async addProposal({ id, team, person, item, files }) {
      const [row] = await db.query<ProposalRow>(
        `INSERT INTO context_proposals (id, team_id, person, item, files, state)
         VALUES ($1, $2, $3, $4, $5::text::jsonb, 'open') RETURNING ${PROPOSAL_COLUMNS}`,
        [id, team, person, item, JSON.stringify(files)],
      );
      if (!row) throw new Error("The proposal was not stored");
      return proposalInfo(toProposal(row));
    },

    async getProposal(id) {
      if (!UUID.test(id)) return undefined;
      const [row] = await db.query<ProposalRow>(
        `SELECT ${PROPOSAL_COLUMNS} FROM context_proposals WHERE id = $1`,
        [id],
      );
      return row ? toProposal(row) : undefined;
    },

    async listProposals(team, { state, limit = 50 } = {}) {
      const rows = await db.query<ProposalRow>(
        `SELECT ${PROPOSAL_COLUMNS} FROM context_proposals
         WHERE team_id = $1 AND ($2::text IS NULL OR state = $2)
         ORDER BY created_at DESC, id DESC LIMIT $3`,
        [team, state ?? null, limit],
      );
      return rows.map(toProposal);
    },

    async settle(id, decide) {
      if (!UUID.test(id)) return undefined;
      return db.transaction(async (tx) => {
        const [found] = await tx.query<ProposalRow>(
          `SELECT ${PROPOSAL_COLUMNS} FROM context_proposals WHERE id = $1 AND state = 'open'
           FOR UPDATE`,
          [id],
        );
        if (!found) return undefined;
        const proposal = toProposal(found);
        const [team] = await tx.query<{ context_files: unknown }>(
          "SELECT context_files FROM teams WHERE id = $1 FOR UPDATE",
          [proposal.team],
        );
        const outcome = decide(json<ContextFile[] | null>(team?.context_files) ?? [], proposal);
        if (outcome.state === "applied") {
          await tx.query(
            `UPDATE teams SET context_files = $2::text::jsonb, context_updated_at = now()
             WHERE id = $1`,
            [proposal.team, JSON.stringify(outcome.files)],
          );
        }
        const [row] = await tx.query<ProposalRow>(
          `UPDATE context_proposals SET state = $2, decided_at = now(), decided_by = $3, note = $4
           WHERE id = $1 RETURNING ${PROPOSAL_COLUMNS}`,
          [
            id,
            outcome.state,
            outcome.by ?? null,
            outcome.state === "refused" ? outcome.note : null,
          ],
        );
        return row ? proposalInfo(toProposal(row)) : undefined;
      });
    },
  };
}
