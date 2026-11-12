import { type AgentRef, webhookPullAgent } from "@selfhost/attribution";
import { databaseOf, type Ledger, stableEventId } from "@selfhost/ledger";
import { GITHUB_APP_ACTOR } from "@selfhost/pr";
import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import type { AgentPull, RiskAssessment } from "./github-pull.js";
import type { PullReads } from "./github-reads.js";

type PullKind = "pr.opened" | "pr.merged" | "pr.closed";

/** Most changed files a pr.opened event lists, for the review item's routing. */
const MAX_FILES = 1000;

/** The kind of the newest pr.opened, pr.merged or pr.closed event for a pull request. */
async function newestPullKind(ledger: Ledger, url: string): Promise<PullKind | undefined> {
  const [row] = await databaseOf(ledger).query<{ kind: PullKind }>(
    `SELECT kind FROM events
     WHERE kind IN ('pr.opened', 'pr.merged', 'pr.closed')
       AND coalesce(body#>>'{links,pr_url}', body#>>'{target,value}') = $1
     ORDER BY ts DESC, id DESC LIMIT 1`,
    [url],
  );
  return row?.kind;
}

/**
 * The run (session) behind an agent pull request: the first of the sessions that made its
 * commits, as the brief and the labels join them, else the newest session that linked the pull
 * request itself, such as the hook's record of the `gh pr create` that opened it.
 */
export async function pullRun(
  ledger: Ledger,
  url: string,
  sessions: readonly string[] = [],
): Promise<string | undefined> {
  const [first] = [...sessions].sort();
  if (first) return first;
  const [row] = await databaseOf(ledger).query<{ session_id: string }>(
    `SELECT session_id FROM events
     WHERE body#>>'{links,pr_url}' = $1 AND coalesce(session_id, '') <> ''
       AND kind NOT IN ('pr.merged', 'pr.closed', 'review.submitted')
     ORDER BY ts DESC, id DESC LIMIT 1`,
    [url],
  );
  return row?.session_id;
}

function pullEvent(
  kind: PullKind,
  pull: Pick<AgentPull, "owner" | "repo" | "url">,
  agent: AgentRef,
  at: string,
  fields: { session?: string; commit?: string; data: Record<string, unknown> },
): LedgerEvent {
  return {
    id: stableEventId(at, `${kind}\nserver\n${pull.url}`),
    schema: EVENT_SCHEMA,
    ts: at,
    source: "server",
    kind,
    // A system actor: the person behind the pull request is its run's, through the session.
    actor: { kind: "system", id: GITHUB_APP_ACTOR },
    agent: { vendor: agent.vendor },
    ...(agent.model ? { model: agent.model } : {}),
    ...(fields.session ? { session_id: fields.session } : {}),
    repo: `${pull.owner}/${pull.repo}`.toLowerCase(),
    target: { type: "pr", value: pull.url },
    links: {
      pr_url: pull.url,
      ...(fields.commit && /^[0-9a-f]{7,64}$/i.test(fields.commit)
        ? { commit_sha: fields.commit.toLowerCase() }
        : {}),
    },
    data: fields.data,
  };
}

const append = (ledger: Ledger, team: string | undefined, events: LedgerEvent[]) =>
  ledger.append(events, team === undefined ? {} : { team });

/**
 * Records pr.opened for an agent pull request the App synced, unless its newest pull request
 * event already is one (a background run's, or an earlier delivery's): the review list opens its
 * `pr` item from it, the run view lists it, and its second opinions and escalation attach. A
 * pull request reopened after a pr.closed gets a new one. The event names the run behind the
 * pull request, the risk the sync scored and the changed files. true when one was written.
 */
export async function recordPullOpened(
  ledger: Ledger,
  team: string | undefined,
  synced: { pull: AgentPull; agent: AgentRef; reads: PullReads; risk?: RiskAssessment },
  times: { createdAt?: string; now: Date },
): Promise<boolean> {
  const { pull, agent, reads, risk } = synced;
  const newest = await newestPullKind(ledger, pull.url);
  if (newest === "pr.opened") return false;
  const change = await reads.change();
  const session = await pullRun(ledger, pull.url, change.run?.sessions);
  // The first opening keeps GitHub's time, so two deliveries racing write one event; a reopening
  // is now.
  const at = (
    newest === undefined && times.createdAt ? new Date(times.createdAt) : times.now
  ).toISOString();
  const files = change.files
    .flatMap((file) => (file.previousPath ? [file.path, file.previousPath] : [file.path]))
    .slice(0, MAX_FILES);
  const event = pullEvent("pr.opened", pull, agent, at, {
    ...(session ? { session } : {}),
    commit: pull.headSha,
    data: {
      number: pull.number,
      title: pull.title,
      signal: "selfhost GitHub App",
      files,
      ...(risk?.score !== undefined
        ? { risk: { score: risk.score, reasons: risk.title ? [risk.title] : [] } }
        : {}),
    },
  });
  await append(ledger, team, [event]);
  return true;
}

/** A closed pull request as the pull_request webhook carries it. */
interface ClosedPayload {
  action?: string;
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string; type?: string } | null;
    head: { sha: string; ref: string };
    merged?: boolean;
    merged_at?: string | null;
    closed_at?: string | null;
    merge_commit_sha?: string | null;
    additions?: number;
    deletions?: number;
  };
  repository?: { name: string; owner: { login: string } };
}

/**
 * pr.merged or pr.closed for an agent pull request GitHub closed, so the review list closes its
 * item and the run view shows it merged or closed. Nothing is read from GitHub here; `lines`, the
 * lines a merge added by file (read by learning from reverts), go in pr.merged's data. Written
 * once: not again when the newest pull request event already says so.
 */
export async function recordPullClosed(
  ledger: Ledger,
  team: string | undefined,
  payload: unknown,
  now: Date,
  extra: { lines?: Record<string, [number, number][]> } = {},
): Promise<{ kind: PullKind; where: string } | { skip: string }> {
  const body = payload as ClosedPayload;
  const pr = body.pull_request;
  if (!pr?.head || !body.repository) return { skip: "no pull request in the payload" };
  const found = webhookPullAgent({ user: pr.user, body: pr.body, head: { ref: pr.head.ref } });
  if (!found) return { skip: "not an agent pull request" };
  const kind: PullKind = pr.merged ? "pr.merged" : "pr.closed";
  const pull = {
    owner: body.repository.owner.login,
    repo: body.repository.name,
    url: pr.html_url,
  };
  const where = `${pull.owner}/${pull.repo}#${pr.number}`;
  if ((await newestPullKind(ledger, pull.url)) === kind) return { kind, where };
  const session = await pullRun(ledger, pull.url);
  const at = new Date((pr.merged ? pr.merged_at : pr.closed_at) ?? now).toISOString();
  await append(ledger, team, [
    pullEvent(kind, pull, found.agent, at, {
      ...(session ? { session } : {}),
      commit: (pr.merged ? pr.merge_commit_sha : undefined) ?? pr.head.sha,
      data: {
        number: pr.number,
        title: pr.title,
        ...(typeof pr.additions === "number" ? { additions: pr.additions } : {}),
        ...(typeof pr.deletions === "number" ? { deletions: pr.deletions } : {}),
        ...(pr.merged && extra.lines ? { lines: extra.lines } : {}),
      },
    }),
  ]);
  return { kind, where };
}

const PULL_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;
const SHA = /^[0-9a-f]{7,64}$/;

/**
 * Links agent pull requests recorded before their session reached the server to that session,
 * from a batch of stored events: an event of a session that names the pull request
 * (links.pr_url, as the hook records the `gh pr create` that opened it) or its head commit
 * (links.commit_sha). Each such pr.opened with no session gets one pr.linked event naming the
 * session, under the pull request's team, which gives its review item the run; only a session of
 * the same team links. Returns the pull request URLs it linked, whose brief is then out of date.
 */
export async function linkPullSessions(
  ledger: Ledger,
  events: readonly unknown[],
  now: Date = new Date(),
): Promise<string[]> {
  const byUrl = new Map<string, LedgerEvent>();
  const bySha = new Map<string, LedgerEvent>();
  for (const raw of events) {
    const event = raw as LedgerEvent;
    if (typeof event?.session_id !== "string" || event.session_id === "") continue;
    if (event.kind === "pr.opened" || event.kind === "pr.linked") continue;
    const url = event.links?.pr_url;
    if (typeof url === "string" && PULL_URL.test(url) && !byUrl.has(url)) byUrl.set(url, event);
    const sha = event.links?.commit_sha?.toLowerCase();
    if (typeof sha === "string" && SHA.test(sha) && !bySha.has(sha)) bySha.set(sha, event);
  }
  if (byUrl.size === 0 && bySha.size === 0) return [];
  const db = databaseOf(ledger);
  const rows = await db.query<{ body: unknown; team: string | null }>(
    `SELECT o.body, o.team FROM events o
     WHERE o.kind = 'pr.opened' AND coalesce(o.session_id, '') = ''
       AND (o.body#>>'{links,pr_url}' IN (SELECT jsonb_array_elements_text($1::text::jsonb))
         OR lower(o.body#>>'{links,commit_sha}') IN (SELECT jsonb_array_elements_text($2::text::jsonb)))
       AND NOT EXISTS (SELECT 1 FROM events l WHERE l.kind = 'pr.linked'
         AND l.body#>>'{links,pr_url}' = o.body#>>'{links,pr_url}')
     ORDER BY o.ts DESC, o.id DESC`,
    [JSON.stringify([...byUrl.keys()]), JSON.stringify([...bySha.keys()])],
  );
  const linked: string[] = [];
  for (const row of rows) {
    const opened = (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as LedgerEvent;
    const url = opened.links?.pr_url;
    if (!url || linked.includes(url)) continue;
    const sha = opened.links?.commit_sha?.toLowerCase();
    const session = byUrl.get(url) ?? (sha ? bySha.get(sha) : undefined);
    if (!session?.session_id) continue;
    // The team the session's event was stored under, not what its body says.
    const [own] = await db.query<{ team: string | null }>(
      "SELECT team FROM events WHERE id = $1::uuid",
      [session.id],
    );
    if (!own || (own.team ?? null) !== (row.team ?? null)) continue;
    const team = row.team ?? undefined;
    const at = now.toISOString();
    const event: LedgerEvent = {
      id: stableEventId(opened.ts, `pr.linked\nserver\n${url}\n${session.session_id}`),
      schema: EVENT_SCHEMA,
      ts: at,
      source: "server",
      kind: "pr.linked",
      actor: { kind: "system", id: GITHUB_APP_ACTOR },
      ...(opened.agent ? { agent: opened.agent } : {}),
      ...(opened.model ? { model: opened.model } : {}),
      session_id: session.session_id,
      ...(session.run_id ? { run_id: session.run_id } : {}),
      ...(opened.repo ? { repo: opened.repo } : {}),
      target: { type: "pr", value: url },
      links: { pr_url: url, ...(sha && SHA.test(sha) ? { commit_sha: sha } : {}) },
      data: {
        ...(typeof opened.data?.number === "number" ? { number: opened.data.number } : {}),
        via: byUrl.has(url) ? "pr_url" : "commit",
      },
    };
    await append(ledger, team, [event]);
    linked.push(url);
  }
  return linked;
}
