import { type AgentRef, webhookPullAgent } from "@selfhost/attribution";
import type { Octokit } from "@selfhost/github";
import { databaseOf, type Ledger, stableEventId } from "@selfhost/ledger";
import { type ChangedFile, GITHUB_APP_ACTOR, readPullFiles } from "@selfhost/pr";
import { settingsFromConfig, touchedModules } from "@selfhost/provenance";
import {
  type Actor,
  EVENT_SCHEMA,
  type LedgerEvent,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import { loadRisk } from "./ee.js";

type RiskModule = NonNullable<Awaited<ReturnType<typeof loadRisk>>>;
type LineRanges = ReturnType<RiskModule["addedLines"]>;
type LearnedRevertRisk = NonNullable<Parameters<RiskModule["scoreRisk"]>[0]["learned"]>[number];

const DAY_MS = 86_400_000;

/** How far back merges count towards a learned rate, as the risk score's revert rates. */
const LEARNING_DAYS = 90;

/** Most reverts and reworks a risk.learned event lists as evidence. */
const MAX_EVIDENCE = 50;

/** A merged pull request as the pull_request webhook carries it. */
export interface MergedPullPayload {
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string; type?: string } | null;
    head: { sha: string; ref: string };
    base?: { sha: string };
    merged?: boolean;
    merged_at?: string | null;
    merge_commit_sha?: string | null;
    merged_by?: { login: string; type?: string } | null;
  };
  repository?: { name: string; owner: { login: string } };
  installation?: { id?: number };
}

/** A push as the push webhook carries it: the commits that reached a branch. */
export interface PushPayload {
  ref?: string;
  repository?: { name: string; owner: { login?: string; name?: string }; default_branch?: string };
  pusher?: { name?: string };
  commits?: {
    id: string;
    message: string;
    timestamp?: string;
    author?: { username?: string; name?: string };
  }[];
}

/** A merged agent pull request as its pr.merged event recorded it. */
interface MergedAgentPull {
  event: LedgerEvent;
  url: string;
  number?: number;
  title?: string;
  mergedAt: string;
  commit?: string;
  lines?: LineRanges;
}

const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

const repoUrl = (repo: string) => `https://github.com/${repo}`;

function linesOf(event: LedgerEvent): LineRanges | undefined {
  const lines = event.data?.lines;
  return lines !== null && typeof lines === "object" ? (lines as LineRanges) : undefined;
}

function mergedPull(event: LedgerEvent): MergedAgentPull | undefined {
  const url = event.links?.pr_url;
  if (!url) return undefined;
  const lines = linesOf(event);
  return {
    event,
    url,
    ...(typeof event.data?.number === "number" ? { number: event.data.number } : {}),
    ...(typeof event.data?.title === "string" ? { title: event.data.title } : {}),
    mergedAt: event.ts,
    ...(event.links?.commit_sha ? { commit: event.links.commit_sha } : {}),
    ...(lines ? { lines } : {}),
  };
}

/** Who merged or pushed a revert: a person by GitHub login, or a bot as a system actor. */
function actorOf(user: { login?: string; type?: string } | null | undefined): Actor {
  if (!user?.login) return { kind: "system", id: GITHUB_APP_ACTOR };
  return user.type === "Bot"
    ? { kind: "system", id: user.login }
    : { kind: "person", id: user.login };
}

const daysBetween = (from: string, to: string) =>
  Math.round(((Date.parse(to) - Date.parse(from)) / DAY_MS) * 10) / 10;

/**
 * Learning from reverts on the GitHub App's deliveries (F12): merged pull requests and pushes on
 * claimed repositories are checked for reverts of agent pull requests and for later changes to
 * the lines they wrote, each recorded once as pr.reverted or pr.reworked on the original pull
 * request (its agent, model and run), within `[review] revert_window_days` of its merge only.
 * The rates per agent, model and module are then read again, and each crossing of `[review]
 * revert_rate_threshold` is recorded as risk.learned with the events behind it. A proposed signal
 * opens a review item; only once a person approves it does the risk score count it.
 */
export function revertLearning(
  ledger: Ledger,
  options: { team?: string; load?: () => Promise<RiskModule | undefined>; now?: () => Date },
) {
  const db = databaseOf(ledger);
  const load = options.load ?? loadRisk;
  const now = options.now ?? (() => new Date());
  let loaded: Promise<RiskModule | undefined> | undefined;
  const risk = () => {
    loaded ??= load();
    return loaded;
  };
  const append = (events: LedgerEvent[]) =>
    ledger.append(events, options.team === undefined ? {} : { team: options.team });

  /** Agent pull requests merged in `repo` from `since` up to `until`, newest first. */
  async function mergedAgentPulls(
    repo: string,
    since: Date,
    until: Date,
  ): Promise<MergedAgentPull[]> {
    const rows = await db.query<{ body: unknown }>(
      `SELECT body FROM events
       WHERE kind = 'pr.merged' AND body->>'repo' = $1 AND ts >= $2::timestamptz
         AND ts <= $3::timestamptz AND body->'agent' IS NOT NULL
       ORDER BY ts DESC, id DESC`,
      [repo, since.toISOString(), until.toISOString()],
    );
    const seen = new Set<string>();
    const pulls: MergedAgentPull[] = [];
    for (const row of rows) {
      const pull = mergedPull(json<LedgerEvent>(row.body));
      if (!pull || seen.has(pull.url)) continue;
      seen.add(pull.url);
      pulls.push(pull);
    }
    return pulls;
  }

  const exists = async (id: string) =>
    (await db.query("SELECT 1 FROM events WHERE id = $1::uuid", [id])).length > 0;

  /** The agent pull requests a revert names, merged within the window before it. */
  async function revertTargets(
    repo: string,
    claims: ReturnType<RiskModule["revertClaims"]>,
    at: string,
    days: number,
  ): Promise<MergedAgentPull[]> {
    const recent = await mergedAgentPulls(
      repo,
      new Date(Date.parse(at) - days * DAY_MS),
      new Date(at),
    );
    const urls = new Set(
      claims.pulls
        .filter((pull) => (pull.repo ?? repo) === repo)
        .map((pull) => `${repoUrl(repo)}/pull/${pull.number}`.toLowerCase()),
    );
    const found = recent.filter(
      (pull) =>
        urls.has(pull.url.toLowerCase()) ||
        claims.shas.some((sha) => pull.commit?.toLowerCase().startsWith(sha)),
    );
    if (found.length > 0 || claims.title === undefined) return found;
    // A revert that names neither: the newest agent pull request with the title it quotes.
    const titled = recent.find((pull) => pull.title === claims.title);
    return titled ? [titled] : [];
  }

  function outcomeEvent(
    kind: "pr.reverted" | "pr.reworked",
    target: MergedAgentPull,
    at: string,
    actor: Actor,
    repo: string,
    key: string,
    data: Record<string, unknown>,
    commit?: string,
  ): LedgerEvent {
    const original = target.event;
    return {
      id: stableEventId(target.mergedAt, `${kind}\nserver\n${target.url}${key}`),
      schema: EVENT_SCHEMA,
      ts: new Date(at).toISOString(),
      source: "server",
      kind,
      actor,
      ...(original.agent ? { agent: original.agent } : {}),
      ...(original.model ? { model: original.model } : {}),
      ...(original.session_id ? { session_id: original.session_id } : {}),
      ...(original.run_id ? { run_id: original.run_id } : {}),
      repo,
      target: { type: "pr", value: target.url },
      links: {
        pr_url: target.url,
        ...(commit && /^[0-9a-f]{7,64}$/i.test(commit) ? { commit_sha: commit.toLowerCase() } : {}),
      },
      data: {
        ...(target.number !== undefined ? { number: target.number } : {}),
        merged_at: target.mergedAt,
        days_after_merge: daysBetween(target.mergedAt, at),
        ...data,
      },
    };
  }

  /** Writes the events not stored yet; returns those it wrote. */
  async function record(events: LedgerEvent[]): Promise<LedgerEvent[]> {
    const fresh: LedgerEvent[] = [];
    for (const event of events) {
      if (!(await exists(event.id)) && !fresh.some((e) => e.id === event.id)) fresh.push(event);
    }
    if (fresh.length > 0) await append(fresh);
    return fresh;
  }

  /**
   * Reads the rates of `repo` again and records risk.learned for each agent, model and module
   * whose rate crossed `[review] revert_rate_threshold` since its last record.
   */
  async function relearn(repo: string, config: ResolvedSelfhostConfig): Promise<LedgerEvent[]> {
    const ee = await risk();
    if (!ee) return [];
    const at = now();
    const settings = settingsFromConfig(config);
    const since = new Date(at.getTime() - LEARNING_DAYS * DAY_MS);
    const merged = (await mergedAgentPulls(repo, since, at)).filter((pull) => pull.lines);
    const outcomeRows = await db.query<{ body: unknown }>(
      `SELECT body FROM events
       WHERE kind IN ('pr.reverted', 'pr.reworked') AND body->>'repo' = $1
         AND ts >= $2::timestamptz
       ORDER BY ts, id`,
      [repo, since.toISOString()],
    );
    const outcomes = outcomeRows.map((row) => json<LedgerEvent>(row.body));
    const byId = new Map(outcomes.map((event) => [event.id, event] as const));
    const mergedByUrl = new Map(merged.map((pull) => [pull.url, pull] as const));
    const rates = ee.learnedRates(
      merged.map((pull) => ({
        url: pull.url,
        vendor: pull.event.agent?.vendor ?? "other",
        ...(pull.event.model ? { model: pull.event.model } : {}),
        modules: touchedModules(
          Object.keys(pull.lines ?? {}).map((path) => ({ path })),
          settings,
        ),
      })),
      outcomes.flatMap((event) =>
        event.links?.pr_url
          ? [
              {
                url: event.links.pr_url,
                kind: event.kind === "pr.reverted" ? ("revert" as const) : ("rework" as const),
                event: event.id,
              },
            ]
          : [],
      ),
      { threshold: settings.threshold },
    );
    const learnedRows = await db.query<{ body: unknown }>(
      `SELECT body FROM events WHERE kind = 'risk.learned' AND body->>'repo' = $1
       ORDER BY ts DESC, ingested_at DESC, id DESC`,
      [repo],
    );
    const newest = new Map<string, "proposed" | "cleared">();
    for (const row of learnedRows) {
      const event = json<LedgerEvent>(row.body);
      const key = ee.learnedKey({
        vendor: event.agent?.vendor ?? "other",
        ...(event.model ? { model: event.model } : {}),
        module: String(event.data?.module ?? ""),
      });
      const state = event.data?.state;
      if (!newest.has(key) && (state === "proposed" || state === "cleared")) {
        newest.set(key, state);
      }
    }
    const events: LedgerEvent[] = [];
    for (const rate of rates) {
      const key = ee.learnedKey(rate);
      const state = ee.learnedChange(rate, newest.get(key));
      if (!state) continue;
      const behind = rate.evidence.flatMap((id) => {
        const event = byId.get(id);
        return event ? [event] : [];
      });
      const newestInput = [
        ...behind.map((event) => event.ts),
        ...merged
          .filter((pull) => pull.event.agent?.vendor === rate.vendor)
          .map((pull) => pull.mergedAt),
      ].sort();
      const basis = newestInput[newestInput.length - 1] ?? at.toISOString();
      const idKey = `risk.learned\n${repo}\n${key}\n${state}\n${rate.pulls}\n${rate.evidence.join(",")}`;
      const files = new Set<string>();
      for (const event of behind) {
        const pull = event.links?.pr_url ? mergedByUrl.get(event.links.pr_url) : undefined;
        for (const path of Object.keys(pull?.lines ?? {})) files.add(path);
      }
      events.push({
        id: stableEventId(basis, idKey),
        schema: EVENT_SCHEMA,
        ts: at.toISOString(),
        source: "server",
        kind: "risk.learned",
        actor: { kind: "system", id: GITHUB_APP_ACTOR },
        agent: { vendor: rate.vendor as AgentRef["vendor"] },
        ...(rate.model ? { model: rate.model } : {}),
        repo,
        target: { type: "repo", value: repo },
        ...(state === "proposed"
          ? { links: { item_id: stableEventId(basis, `${idKey}\nitem`) } }
          : {}),
        data: {
          state,
          module: rate.module,
          pulls: rate.pulls,
          reverted: rate.reverted,
          reworked: rate.reworked,
          rate: Math.round(rate.rate * 1000) / 1000,
          threshold: settings.threshold,
          days: settings.windowDays,
          window_days: LEARNING_DAYS,
          files: [...files].sort().slice(0, 100),
          evidence: behind.slice(-MAX_EVIDENCE).map((event) => ({
            event_id: event.id,
            kind: event.kind === "pr.reverted" ? "revert" : "rework",
            pr_url: event.links?.pr_url,
            ...(typeof event.data?.by_pr === "string" ? { by_pr: event.data.by_pr } : {}),
            ...(event.kind === "pr.reverted" && event.links?.commit_sha && !event.data?.by_pr
              ? { by_commit: event.links.commit_sha }
              : {}),
            ...(event.session_id ? { session: event.session_id } : {}),
            ...(typeof event.data?.days_after_merge === "number"
              ? { days_after_merge: event.data.days_after_merge }
              : {}),
            ...(typeof event.data?.reason === "string" ? { reason: event.data.reason } : {}),
          })),
          ...(state === "proposed"
            ? {
                suggestion: ee.learnedSuggestion(rate.module, config.review.modules?.[rate.module]),
              }
            : {}),
        },
      });
    }
    return record(events);
  }

  return {
    /**
     * A merged pull request on a claimed repository, by anyone. Records pr.reverted when it
     * reverts agent pull requests merged within the window, else pr.reworked for each one whose
     * lines it changed. Returns the lines it added when it is an agent's own, for its pr.merged
     * event. Reads the pull request's files from GitHub only when a line record needs them, and
     * its commits only when its title says Revert and its description names nothing.
     */
    async merged(
      octokit: Octokit | undefined,
      payload: unknown,
      config: ResolvedSelfhostConfig,
    ): Promise<{ lines?: LineRanges; recorded: LedgerEvent[] }> {
      const ee = await risk();
      const body = payload as MergedPullPayload;
      const pr = body.pull_request;
      if (!ee || !pr?.merged || !body.repository) return { recorded: [] };
      const owner = body.repository.owner.login;
      const name = body.repository.name;
      const repo = `${owner}/${name}`.toLowerCase();
      const at = new Date(pr.merged_at ?? now()).toISOString();
      const days = settingsFromConfig(config).windowDays;
      const where = { owner, repo: name, pull_number: pr.number };
      let files: Promise<ChangedFile[]> | undefined;
      const readFiles = () => {
        files ??= octokit
          ? readPullFiles(
              {
                files: () =>
                  octokit.paginate(octokit.rest.pulls.listFiles, { ...where, per_page: 100 }),
                // Manifests are not needed here; the risk score reads them.
                contents: async () => undefined,
              },
              pr.base?.sha ?? "",
              pr.head.sha,
            ).then((read) => read.files)
          : Promise.resolve([]);
        return files;
      };
      const actor = actorOf(pr.merged_by ?? pr.user);
      const events: LedgerEvent[] = [];

      let claims = ee.revertClaims({ title: pr.title, body: pr.body });
      if (
        octokit &&
        claims.title !== undefined &&
        claims.pulls.length === 0 &&
        claims.shas.length === 0
      ) {
        const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
          ...where,
          per_page: 100,
        });
        claims = ee.revertClaims({
          title: pr.title,
          body: pr.body,
          messages: commits.map((commit) => commit.commit.message),
        });
      }
      const isRevert = ee.looksLikeRevert(claims);
      if (isRevert) {
        const reason = ee.revertReason(pr.body);
        for (const target of await revertTargets(repo, claims, at, days)) {
          if (target.url === pr.html_url) continue;
          events.push(
            outcomeEvent(
              "pr.reverted",
              target,
              at,
              actor,
              repo,
              "",
              {
                via: "revert_pr",
                by_pr: pr.html_url,
                by_number: pr.number,
                ...(reason ? { reason } : {}),
              },
              pr.merge_commit_sha ?? undefined,
            ),
          );
        }
      } else {
        const candidates = (
          await mergedAgentPulls(repo, new Date(Date.parse(at) - days * DAY_MS), new Date(at))
        ).filter((pull) => pull.url !== pr.html_url && pull.lines && pull.mergedAt < at);
        if (candidates.length > 0) {
          const changed = ee.removedLines(await readFiles());
          for (const target of candidates) {
            const overlap = ee.overlappingLines(target.lines ?? {}, changed);
            if (overlap.lines === 0) continue;
            events.push(
              outcomeEvent(
                "pr.reworked",
                target,
                at,
                actor,
                repo,
                `\n${pr.html_url}`,
                {
                  via: "later_pr",
                  by_pr: pr.html_url,
                  by_number: pr.number,
                  files: overlap.files,
                  lines: overlap.lines,
                },
                pr.merge_commit_sha ?? undefined,
              ),
            );
          }
        }
      }
      const recorded = await record(events);
      const agent = webhookPullAgent({ user: pr.user, body: pr.body, head: { ref: pr.head.ref } });
      const lines = agent && octokit ? ee.addedLines(await readFiles()) : undefined;
      return { ...(lines ? { lines } : {}), recorded };
    },

    /**
     * A push to the default branch: each commit whose message reverts an agent pull request
     * merged within the window (`git revert` of its merge commit, or GitHub's revert button
     * squashed) records pr.reverted. Nothing is read from GitHub.
     */
    async pushed(payload: unknown, config: ResolvedSelfhostConfig): Promise<LedgerEvent[]> {
      const ee = await risk();
      const body = payload as PushPayload;
      const repository = body.repository;
      if (!ee || !repository || !body.ref) return [];
      if (repository.default_branch && body.ref !== `refs/heads/${repository.default_branch}`) {
        return [];
      }
      const owner = repository.owner.login ?? repository.owner.name ?? "";
      const repo = `${owner}/${repository.name}`.toLowerCase();
      const days = settingsFromConfig(config).windowDays;
      const events: LedgerEvent[] = [];
      for (const commit of body.commits ?? []) {
        const claims = ee.revertClaims({ messages: [commit.message] });
        if (claims.pulls.length === 0 && claims.shas.length === 0) continue;
        const at = new Date(commit.timestamp ?? now()).toISOString();
        const [subject = "", ...rest] = commit.message.split("\n");
        const reason = ee.revertReason(rest.join("\n"));
        const login = commit.author?.username ?? body.pusher?.name;
        for (const target of await revertTargets(repo, claims, at, days)) {
          events.push(
            outcomeEvent(
              "pr.reverted",
              target,
              at,
              actorOf(login ? { login } : undefined),
              repo,
              "",
              {
                via: "revert_commit",
                subject: subject.slice(0, 200),
                ...(reason ? { reason } : {}),
              },
              commit.id,
            ),
          );
        }
      }
      return record(events);
    },

    relearn,
  };
}

export type RevertLearning = ReturnType<typeof revertLearning>;

/**
 * The approved revert signals that apply to a pull request: per touched module, the newest
 * risk.learned for the repository, agent and model, when it is proposed (not cleared since) and
 * a person approved its review item. Denied, unanswered or cleared signals add nothing.
 */
export function learnedRisk(ledger: Ledger) {
  const db = databaseOf(ledger);
  return async (repo: string, agent: AgentRef, modules: string[]): Promise<LearnedRevertRisk[]> => {
    if (modules.length === 0) return [];
    const rows = await db.query<{ body: unknown }>(
      `SELECT body FROM events
       WHERE kind = 'risk.learned' AND body->>'repo' = $1 AND body#>>'{agent,vendor}' = $2
         AND coalesce(model, '') = $3
       ORDER BY ts DESC, ingested_at DESC, id DESC`,
      [repo.toLowerCase(), agent.vendor, agent.model ?? ""],
    );
    const newest = new Map<string, LedgerEvent>();
    for (const row of rows) {
      const event = json<LedgerEvent>(row.body);
      const module = event.data?.module;
      if (typeof module === "string" && !newest.has(module)) newest.set(module, event);
    }
    const out: LearnedRevertRisk[] = [];
    for (const module of modules) {
      const event = newest.get(module);
      const item = event?.links?.item_id;
      if (event?.data?.state !== "proposed" || !item) continue;
      const [answered] = await db.query<{ verdict: string | null }>(
        `SELECT body#>>'{answer,verdict}' AS verdict FROM review_items
         WHERE id = $1::uuid AND state = 'answered'`,
        [item],
      );
      if (answered?.verdict !== "approve" && answered?.verdict !== "override") continue;
      const data = event.data;
      const num = (value: unknown) => (typeof value === "number" ? value : 0);
      out.push({
        module,
        pulls: num(data.pulls),
        reverted: num(data.reverted),
        reworked: num(data.reworked),
        rate: num(data.rate),
        days: num(data.days),
      });
    }
    return out;
  };
}

export type LearnedLookup = ReturnType<typeof learnedRisk>;
