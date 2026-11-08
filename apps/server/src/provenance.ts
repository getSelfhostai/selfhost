import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "@selfhost/ledger";
import { ledgerEvents } from "@selfhost/pr";
import {
  DEFAULT_SETTINGS,
  ledgerOnlyReport,
  mergedPulls,
  type ProvenanceSettings,
  readProvenance,
  runCommits,
  settingsFromConfig,
} from "@selfhost/provenance";
import {
  createValidator,
  type LedgerEvent,
  ProvenanceQuerySchema,
  type ProvenanceReport,
  type ResolvedSelfhostConfig,
  type TeamProvenance,
  type TeamProvenanceModules,
} from "@selfhost/schema";
import type { Context } from "hono";
import { apiError, authorize, type Caller, type Router } from "./access.js";
import { invalidQuery } from "./http.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Default range: the last 30 days. */
const DEFAULT_DAYS = 30;
/** Commits authored this long before the range can still be merged in it. */
const BRANCH_AGE_DAYS = 90;
/** Reports kept in memory, newest first out. */
const CACHE_SIZE = 32;

/**
 * Where the server finds a clone of a repo, to read its history. The server never fetches or
 * clones: whoever runs it keeps the clones current (a `git fetch` on a timer is enough).
 */
export interface GitClones {
  /** The clone of owner/name, or undefined when there is none. */
  dir(repo: string): string | undefined;
}

/**
 * Clones under one folder as `<root>/<owner>/<name>` (lower case, with a work tree), from
 * SELFHOST_GIT_CLONES.
 */
export function clonesUnder(root: string): GitClones {
  return {
    dir(repo) {
      const [owner, name] = repo.toLowerCase().split("/");
      if (!owner || !name || owner.startsWith(".") || name.startsWith(".")) return undefined;
      const dir = join(root, owner, name);
      return existsSync(join(dir, ".git")) && statSync(dir).isDirectory() ? dir : undefined;
    },
  };
}

export interface ProvenanceRouteOptions {
  clones?: GitClones;
  /** selfhost.toml for teams with no policy of their own. */
  config?: ResolvedSelfhostConfig;
  now?: () => Date;
}

const query = createValidator(ProvenanceQuerySchema);

export const NO_CLONE = (repo: string) =>
  `The server has no clone of ${repo}, so lines come from the ledger's merged pull requests and there are no modules or revert and rework rates. Set SELFHOST_GIT_CLONES to a folder that holds <owner>/<name> clones.`;

/**
 * GET /v1/teams/{team}/provenance and /v1/teams/{team}/provenance/modules: lines merged by
 * agent, model, person and module in each repo the team owns, and how much was reverted or
 * reworked within `[review] revert_window_days`, computed on read from the server's clones and
 * the team's ledger events. A repo with no clone gets the ledger's numbers alone. Anyone in the
 * team can read them.
 */
export function provenanceRoutes(
  router: Router,
  ledger: Ledger,
  options: ProvenanceRouteOptions = {},
): void {
  const { teams, orgs } = ledger;
  const now = options.now ?? (() => new Date());
  const cache = new Map<string, Promise<ProvenanceReport>>();

  function range(c: Context): { from: Date; to: Date; repo?: string } | Response {
    const parsed = query.validate(c.req.query());
    if (!parsed.ok) return invalidQuery(c, parsed.errors);
    // To the next full hour by default, so repeated reads share a cached report.
    const to = parsed.value.to
      ? new Date(parsed.value.to)
      : new Date(Math.ceil(now().getTime() / HOUR_MS) * HOUR_MS);
    const from = parsed.value.from
      ? new Date(parsed.value.from)
      : new Date(to.getTime() - DEFAULT_DAYS * DAY_MS);
    if (from >= to) {
      return c.json(apiError("invalid_query", "from: Expected a time before to"), 400);
    }
    return { from, to, ...(parsed.value.repo ? { repo: parsed.value.repo.toLowerCase() } : {}) };
  }

  async function settingsFor(team: string, repo?: string): Promise<ProvenanceSettings> {
    try {
      const policy = (await orgs.effectivePolicy(team, repo))?.config ?? options.config;
      return policy ? settingsFromConfig(policy) : DEFAULT_SETTINGS;
    } catch {
      return options.config ? settingsFromConfig(options.config) : DEFAULT_SETTINGS;
    }
  }

  async function teamEvents(team: string, from: Date, to: Date): Promise<LedgerEvent[]> {
    const events: LedgerEvent[] = [];
    for (const kind of ["commit.created", "pr.merged"]) {
      for await (const event of ledgerEvents(ledger, {
        kind,
        team,
        from: new Date(from.getTime() - BRANCH_AGE_DAYS * DAY_MS).toISOString(),
        to: to.toISOString(),
      })) {
        events.push(event);
      }
    }
    return events;
  }

  async function report(
    repo: string,
    settings: ProvenanceSettings,
    events: LedgerEvent[],
    from: Date,
    to: Date,
  ): Promise<ProvenanceReport> {
    const dir = options.clones?.dir(repo);
    if (!dir) {
      return ledgerOnlyReport({ repo, from, to, settings, events, note: NO_CLONE(repo) });
    }
    const runs = runCommits(events);
    const pulls = mergedPulls(events, repo);
    const key = createHash("sha256")
      .update(JSON.stringify([repo, dir, from, to, settings, runs, pulls]))
      .digest("hex");
    let cached = cache.get(key);
    if (!cached) {
      cached = readProvenance(dir, { since: from, until: to, settings, repo, runs, pulls });
      cache.set(key, cached);
      cached.catch(() => cache.delete(key));
      while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    }
    try {
      return await cached;
    } catch (error) {
      return ledgerOnlyReport({
        repo,
        from,
        to,
        settings,
        events,
        note: `Could not read the clone of ${repo}: ${(error as Error).message.split("\n")[0]}`,
      });
    }
  }

  async function reports(c: Context, caller: Caller) {
    const team = c.req.param("team") ?? "";
    const refused = await authorize(c, caller, team, "read");
    if (refused) return refused;
    const window = range(c);
    if (window instanceof Response) return window;
    if (!(await teams.getTeam(team))) return c.json(apiError("not_found", `No team ${team}`), 404);
    const owned = (await orgs.listRepos(team)).map((r) => r.repo);
    if (window.repo && !owned.includes(window.repo)) {
      return c.json(apiError("not_found", `Team ${team} does not own repo ${window.repo}`), 404);
    }
    const events = await teamEvents(team, window.from, window.to);
    const list: ProvenanceReport[] = [];
    for (const repo of (window.repo ? [window.repo] : owned).sort()) {
      list.push(await report(repo, await settingsFor(team, repo), events, window.from, window.to));
    }
    return { team, from: window.from.toISOString(), to: window.to.toISOString(), list };
  }

  router.on("GET", "/v1/teams/:team/provenance", async (c, caller) => {
    const found = await reports(c, caller);
    if (found instanceof Response) return found;
    return c.json({
      team: found.team,
      from: found.from,
      to: found.to,
      repos: found.list,
    } satisfies TeamProvenance);
  });

  router.on("GET", "/v1/teams/:team/provenance/modules", async (c, caller) => {
    const found = await reports(c, caller);
    if (found instanceof Response) return found;
    const threshold = (await settingsFor(found.team)).threshold;
    const modules = found.list
      .filter((r) => r.status === "computed")
      .flatMap((r) => r.modules.map(({ rank: _rank, ...row }) => ({ repo: r.repo ?? "", ...row })))
      .sort(
        (a, b) =>
          b.agent_lines - a.agent_lines ||
          b.lines - a.lines ||
          a.repo.localeCompare(b.repo) ||
          a.module.localeCompare(b.module),
      )
      .map((row, index) => ({ ...row, rank: index + 1 }));
    return c.json({
      team: found.team,
      from: found.from,
      to: found.to,
      threshold,
      modules,
    } satisfies TeamProvenanceModules);
  });
}
