import { createHash } from "node:crypto";
import {
  type ComposedPolicy,
  composePolicy,
  type LedgerEvent,
  type OrgInfo,
  type PolicyLayer,
  type TeamRepo,
} from "@selfhost/schema";
import type { Database, Queryable } from "./db.js";

export interface OrgPolicy {
  org: string;
  text: string;
  updatedAt: string;
}

/** The policy in use for a team or a repo: its layers composed (see composePolicy). */
export interface EffectivePolicy extends ComposedPolicy {
  team: string;
  repo?: string;
  /** sha256 of text. */
  hash: string;
  /** When the newest of its layers was set. */
  updatedAt: string;
  layers: PolicyLayer[];
}

/** A stored team or repo policy of an org, for checking them against a new org floor. */
export interface StoredLayer {
  team: string;
  repo?: string;
  text: string;
}

/** A cost.recorded event and the team its run is assigned to. */
export interface TeamCost {
  team: string;
  event: LedgerEvent;
}

export interface ReviewCounts {
  open: number;
  blocking: number;
  unowned: number;
}

/** Orgs, the repos each team owns and the runs assigned to them, in the ledger's database. */
export interface OrgStore {
  /** undefined when the id is taken. */
  createOrg(org: { id: string; name: string }): Promise<OrgInfo | undefined>;
  getOrg(id: string): Promise<OrgInfo | undefined>;
  getOrgPolicy(org: string): Promise<OrgPolicy | undefined>;
  setOrgPolicy(org: string, text: string): Promise<OrgPolicy>;
  /** Every stored team and repo policy in the org. */
  storedLayers(org: string): Promise<StoredLayer[]>;
  /**
   * Gives a repo to a team. Refused with the owning team when another team of the org has it;
   * undefined when there is no such team.
   */
  addRepo(
    team: string,
    repo: { repo: string; remote: string },
  ): Promise<TeamRepo | { taken: string } | undefined>;
  /** false when the team does not own the repo. */
  removeRepo(team: string, repo: string): Promise<boolean>;
  listRepos(team: string): Promise<TeamRepo[]>;
  /** The team that owns a repo in an org. */
  repoOwner(org: string, repo: string): Promise<TeamRepo | undefined>;
  getRepoPolicy(org: string, repo: string): Promise<string | undefined>;
  setRepoPolicy(org: string, repo: string, text: string): Promise<void>;
  /**
   * The policy in use for a team, or one of its repos: the org floor, the team's file and the
   * repo's, composed. undefined when none of them has a policy.
   */
  effectivePolicy(team: string, repo?: string): Promise<EffectivePolicy | undefined>;
  /**
   * The team each event belongs to: the team that owns the event's repo, else the team that
   * owns its run's repo (from earlier events of the session that named one), else `writer`,
   * the team of the person token that wrote it. With a writer only teams of its org count;
   * without one (the admin token) a repo counts when exactly one org maps it. With `person`,
   * the person who wrote the batch, an event moves to the repo's team only when that person is
   * an active member of it (not revoked): naming another team's repo must not write into that
   * team.
   */
  assignTeams(
    tx: Queryable,
    events: LedgerEvent[],
    writer?: string,
    person?: string,
  ): Promise<(string | null)[]>;
  /** Remembers the repo of each run (session) the events name one for. */
  recordRuns(tx: Queryable, events: LedgerEvent[]): Promise<void>;
  /**
   * cost.recorded events from `from` (inclusive) to `to` stored with these teams of the org. An
   * event stored with no team (the admin token) goes to the team that owns its repo, or its run's
   * repo, read now; a stored team is never moved by repo ownership, so naming another team's or
   * org's repo cannot charge spend to it.
   */
  teamCosts(org: string, teams: string[], from: string, to: string): Promise<TeamCost[]>;
  /** People in each of these teams, not counting those revoked from it. */
  peopleCounts(teams: string[]): Promise<Map<string, number>>;
  /** Open review items of each of these teams. */
  reviewCounts(teams: string[]): Promise<Map<string, ReviewCounts>>;
}

const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const json = <T>(value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as T;
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");
const IN_LIST = "IN (SELECT jsonb_array_elements_text($1::text::jsonb))";

interface OrgRow {
  id: string;
  name: string;
  created_at: unknown;
}

interface RepoRow {
  org_id: string;
  repo: string;
  remote: string;
  team_id: string;
  has_policy: boolean;
  created_at: unknown;
}

const toOrg = (row: OrgRow): OrgInfo => ({
  id: row.id,
  name: row.name,
  created_at: iso(row.created_at),
});

const toRepo = (row: RepoRow): TeamRepo => ({
  repo: row.repo,
  remote: row.remote,
  team: row.team_id,
  org: row.org_id,
  has_policy: row.has_policy,
  created_at: iso(row.created_at),
});

const REPO_COLUMNS =
  "org_id, repo, remote, team_id, policy_text IS NOT NULL AS has_policy, created_at";

/** Session id to repo, from events that carry both. The first event of a session wins. */
function runsOf(events: LedgerEvent[]): Map<string, string> {
  const runs = new Map<string, string>();
  for (const event of events) {
    if (event.session_id && event.repo && !runs.has(event.session_id)) {
      runs.set(event.session_id, event.repo.toLowerCase());
    }
  }
  return runs;
}

export function createOrgStore(db: Database): OrgStore {
  const store: OrgStore = {
    async createOrg({ id, name }) {
      const [row] = await db.query<OrgRow>(
        `INSERT INTO orgs (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING
         RETURNING id, name, created_at`,
        [id, name],
      );
      return row ? toOrg(row) : undefined;
    },

    async getOrg(id) {
      const [row] = await db.query<OrgRow>("SELECT id, name, created_at FROM orgs WHERE id = $1", [
        id,
      ]);
      return row ? toOrg(row) : undefined;
    },

    async getOrgPolicy(org) {
      const [row] = await db.query<{ policy_text: string | null; policy_updated_at: unknown }>(
        "SELECT policy_text, policy_updated_at FROM orgs WHERE id = $1",
        [org],
      );
      if (row?.policy_text == null) return undefined;
      return { org, text: row.policy_text, updatedAt: iso(row.policy_updated_at) };
    },

    async setOrgPolicy(org, text) {
      const [row] = await db.query<{ policy_updated_at: unknown }>(
        `UPDATE orgs SET policy_text = $2, policy_updated_at = now() WHERE id = $1
         RETURNING policy_updated_at`,
        [org, text],
      );
      if (!row) throw new Error(`no org ${org}`);
      return { org, text, updatedAt: iso(row.policy_updated_at) };
    },

    async storedLayers(org) {
      const rows = await db.query<{ team: string; repo: string | null; text: string }>(
        `SELECT id AS team, NULL AS repo, policy_text AS text FROM teams
         WHERE org_id = $1 AND policy_text IS NOT NULL
         UNION ALL
         SELECT team_id, repo, policy_text FROM team_repos
         WHERE org_id = $1 AND policy_text IS NOT NULL
         ORDER BY team, repo NULLS FIRST`,
        [org],
      );
      return rows.map(({ team, repo, text }) => ({ team, ...(repo ? { repo } : {}), text }));
    },

    async addRepo(team, { repo, remote }) {
      return db.transaction(async (tx) => {
        const [found] = await tx.query<{ org_id: string }>(
          "SELECT org_id FROM teams WHERE id = $1",
          [team],
        );
        if (!found) return undefined;
        const [row] = await tx.query<RepoRow>(
          `INSERT INTO team_repos (org_id, repo, remote, team_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (org_id, repo) DO UPDATE SET remote = EXCLUDED.remote
             WHERE team_repos.team_id = EXCLUDED.team_id
           RETURNING ${REPO_COLUMNS}`,
          [found.org_id, repo, remote, team],
        );
        if (row) return toRepo(row);
        const [owner] = await tx.query<{ team_id: string }>(
          "SELECT team_id FROM team_repos WHERE org_id = $1 AND repo = $2",
          [found.org_id, repo],
        );
        return { taken: owner?.team_id ?? "" };
      });
    },

    async removeRepo(team, repo) {
      const rows = await db.query(
        "DELETE FROM team_repos WHERE team_id = $1 AND repo = $2 RETURNING repo",
        [team, repo],
      );
      return rows.length > 0;
    },

    async listRepos(team) {
      const rows = await db.query<RepoRow>(
        `SELECT ${REPO_COLUMNS} FROM team_repos WHERE team_id = $1 ORDER BY repo`,
        [team],
      );
      return rows.map(toRepo);
    },

    async repoOwner(org, repo) {
      const [row] = await db.query<RepoRow>(
        `SELECT ${REPO_COLUMNS} FROM team_repos WHERE org_id = $1 AND repo = $2`,
        [org, repo],
      );
      return row ? toRepo(row) : undefined;
    },

    async getRepoPolicy(org, repo) {
      const [row] = await db.query<{ policy_text: string | null }>(
        "SELECT policy_text FROM team_repos WHERE org_id = $1 AND repo = $2",
        [org, repo],
      );
      return row?.policy_text ?? undefined;
    },

    async setRepoPolicy(org, repo, text) {
      const rows = await db.query(
        `UPDATE team_repos SET policy_text = $3, policy_updated_at = now()
         WHERE org_id = $1 AND repo = $2 RETURNING repo`,
        [org, repo, text],
      );
      if (rows.length === 0) throw new Error(`no repo ${repo} in org ${org}`);
    },

    async effectivePolicy(team, repo) {
      const [row] = await db.query<{
        org_id: string;
        org_text: string | null;
        org_at: unknown;
        team_text: string | null;
        team_at: unknown;
        repo_text: string | null;
        repo_at: unknown;
      }>(
        `SELECT t.org_id, o.policy_text AS org_text, o.policy_updated_at AS org_at,
           t.policy_text AS team_text, t.policy_updated_at AS team_at,
           r.policy_text AS repo_text, r.policy_updated_at AS repo_at
         FROM teams t JOIN orgs o ON o.id = t.org_id
         LEFT JOIN team_repos r ON r.org_id = t.org_id AND r.repo = $2 AND r.team_id = t.id
         WHERE t.id = $1`,
        [team, repo ?? null],
      );
      if (!row) return undefined;
      const layers: PolicyLayer[] = [];
      const times: unknown[] = [];
      if (row.org_text !== null) {
        layers.push({ kind: "org", name: row.org_id, text: row.org_text });
        times.push(row.org_at);
      }
      if (row.team_text !== null) {
        layers.push({ kind: "team", name: team, text: row.team_text });
        times.push(row.team_at);
      }
      if (row.repo_text !== null && repo !== undefined) {
        layers.push({ kind: "repo", name: repo, text: row.repo_text });
        times.push(row.repo_at);
      }
      if (layers.length === 0) return undefined;
      const composed = composePolicy(layers);
      const updatedAt = times.map(iso).sort().at(-1) ?? new Date(0).toISOString();
      return {
        ...composed,
        team,
        ...(repo !== undefined ? { repo } : {}),
        hash: hashOf(composed.text),
        updatedAt,
        layers,
      };
    },

    async assignTeams(tx, events, writer, person) {
      const sessions = [...new Set(events.flatMap((e) => (e.session_id ? [e.session_id] : [])))];
      const repos = new Map<string, string>();
      if (sessions.length > 0) {
        const known = await tx.query<{ session_id: string; repo: string }>(
          `SELECT session_id, repo FROM run_repos WHERE session_id ${IN_LIST}`,
          [JSON.stringify(sessions)],
        );
        for (const row of known) repos.set(row.session_id, row.repo);
      }
      for (const [session, repo] of runsOf(events))
        if (!repos.has(session)) repos.set(session, repo);
      const repoOf = (event: LedgerEvent) =>
        event.repo?.toLowerCase() ?? (event.session_id ? repos.get(event.session_id) : undefined);
      const named = [...new Set(events.flatMap((e) => repoOf(e) ?? []))];
      if (named.length === 0) return events.map(() => writer ?? null);
      const owners = await tx.query<{ repo: string; org_id: string; team_id: string }>(
        `SELECT repo, org_id, team_id FROM team_repos WHERE repo ${IN_LIST}`,
        [JSON.stringify(named)],
      );
      let org: string | undefined;
      if (writer !== undefined) {
        const [row] = await tx.query<{ org_id: string }>("SELECT org_id FROM teams WHERE id = $1", [
          writer,
        ]);
        org = row?.org_id;
      }
      let member: Set<string> | undefined;
      if (writer !== undefined && person !== undefined) {
        const rows = await tx.query<{ team_id: string }>(
          `SELECT p.team_id FROM people p JOIN teams t ON t.id = p.team_id
           WHERE t.org_id = $1 AND lower(p.id) = lower($2::text) AND p.revoked_at IS NULL`,
          [org ?? null, person],
        );
        member = new Set([writer, ...rows.map((row) => row.team_id)]);
      }
      const teamOf = new Map<string, string>();
      for (const repo of named) {
        const candidates = owners.filter(
          (row) => row.repo === repo && (org === undefined || row.org_id === org),
        );
        const [only] = candidates;
        if (!only || (member && !member.has(only.team_id))) continue;
        if (writer !== undefined || candidates.length === 1) teamOf.set(repo, only.team_id);
      }
      return events.map((event) => {
        const repo = repoOf(event);
        return (repo ? teamOf.get(repo) : undefined) ?? writer ?? null;
      });
    },

    async recordRuns(tx, events) {
      const runs = runsOf(events);
      if (runs.size === 0) return;
      await tx.query(
        `INSERT INTO run_repos (session_id, repo)
         SELECT key, value FROM jsonb_each_text($1::text::jsonb)
         ON CONFLICT (session_id) DO NOTHING`,
        [JSON.stringify(Object.fromEntries(runs))],
      );
    },

    async teamCosts(org, teams, from, to) {
      if (teams.length === 0) return [];
      const rows = await db.query<{ team: string; body: unknown }>(
        `SELECT coalesce(e.team, tr.team_id) AS team, e.body
         FROM events e
         LEFT JOIN run_repos rr ON rr.session_id = e.session_id
         LEFT JOIN team_repos tr
           ON tr.org_id = $2 AND tr.repo = coalesce(lower(e.body->>'repo'), rr.repo)
         WHERE e.kind = 'cost.recorded' AND e.ts >= $3::timestamptz AND e.ts < $4::timestamptz
           AND coalesce(e.team, tr.team_id) ${IN_LIST}
         ORDER BY e.ts, e.id`,
        [JSON.stringify(teams), org, from, to],
      );
      return rows.map((row) => ({ team: row.team, event: json<LedgerEvent>(row.body) }));
    },

    async peopleCounts(teams) {
      const rows = await db.query<{ team_id: string; people: number }>(
        `SELECT team_id, count(*)::int AS people FROM people
         WHERE team_id ${IN_LIST} AND revoked_at IS NULL
         GROUP BY team_id`,
        [JSON.stringify(teams)],
      );
      return new Map(rows.map((row) => [row.team_id, Number(row.people)]));
    },

    async reviewCounts(teams) {
      const rows = await db.query<{
        team: string;
        open: number;
        blocking: number;
        unowned: number;
      }>(
        `SELECT team, count(*)::int AS open,
           count(*) FILTER (WHERE blocking)::int AS blocking,
           count(*) FILTER (WHERE coalesce(jsonb_array_length(body->'owners'), 0) = 0)::int
             AS unowned
         FROM review_items WHERE state = 'open' AND team ${IN_LIST}
         GROUP BY team`,
        [JSON.stringify(teams)],
      );
      return new Map(
        rows.map((row) => [
          row.team,
          { open: Number(row.open), blocking: Number(row.blocking), unowned: Number(row.unowned) },
        ]),
      );
    },
  };
  return store;
}
