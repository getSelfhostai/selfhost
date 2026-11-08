import type { AgentRef, CommitRecord } from "@selfhost/attribution";
import type { VendorLineStat } from "@selfhost/schema";
import type {
  CommitAuthor,
  MainlineCommit,
  MergedPull,
  RunCommit,
  TrackedLanding,
} from "./types.js";

/**
 * A commit's own stats from a vendor name its agent when the agent wrote at least this share of
 * the lines the commit added, and nothing else in git or the ledger named one.
 */
export const VENDOR_COMMIT_SHARE = 0.5;

export interface AuthorInputs {
  /** Commits read with `readCommits`, attributed by trailers, links, bots, branches and sessions. */
  commits: CommitRecord[];
  /** Commits agent sessions recorded in the ledger. */
  runs?: RunCommit[];
  /** Merged pull requests with their agent. */
  pulls?: MergedPull[];
  /** Vendor-reported lines per commit or per day; only per-commit stats can name a commit's agent. */
  vendorStats?: VendorLineStat[];
}

const shaMatches = (full: string, short: string) => {
  const a = full.toLowerCase();
  const b = short.toLowerCase();
  return b.length >= 7 && a.startsWith(b);
};

const ref = (agent: AgentRef): AgentRef => ({
  vendor: agent.vendor,
  ...(agent.model ? { model: agent.model } : {}),
});

/**
 * Who wrote the lines a landing brought, line by line through the commit each came from. The
 * strongest evidence wins:
 *
 * 1. a ledger session that recorded the commit (`commit.created` with a session),
 * 2. the commit's own attribution (trailers, session links, bot authors, agent branches, a
 *    session that edited its files just before),
 * 3. for a squash or direct commit, the pull request it merged, when GitHub or the ledger
 *    attribute that,
 * 4. the vendor's per-commit stats, when its agent wrote at least VENDOR_COMMIT_SHARE of it.
 *
 * Lines a merge commit itself introduced (conflict resolutions) go to the pull request's agent,
 * else to the agent behind most of the landing's other lines. The person is the commit's
 * author email.
 */
export function lineAuthors(
  inputs: AuthorInputs,
): (origin: string, landing: TrackedLanding) => CommitAuthor {
  const records = new Map(inputs.commits.map((commit) => [commit.sha.toLowerCase(), commit]));
  const pulls = new Map((inputs.pulls ?? []).map((pull) => [pull.number, pull]));
  const runs = inputs.runs ?? [];
  const perCommit = (inputs.vendorStats ?? []).filter((stat) => stat.commit !== undefined);
  const cache = new Map<string, CommitAuthor>();

  const own = (origin: string, landing: TrackedLanding, mainline?: MainlineCommit) => {
    const record = records.get(origin.toLowerCase());
    const person = (record?.authorEmail ?? mainline?.authorEmail ?? "unknown").toLowerCase();
    const run = runs.find((r) => shaMatches(origin, r.sha));
    if (run) {
      return { agent: ref(run.agent), person, sessionId: run.sessionId, signal: "run" };
    }
    if (record?.agent) {
      return {
        agent: ref(record.agent),
        person,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        ...(record.signal ? { signal: record.signal } : {}),
      };
    }
    // A squash or direct commit is the pull request's own; a branch commit speaks for itself.
    const pull =
      mainline && landing.landing.pr !== undefined ? pulls.get(landing.landing.pr) : undefined;
    if (pull?.agent) return { agent: ref(pull.agent), person, signal: "pull_request" };
    const stat = perCommit.find((s) => shaMatches(origin, s.commit as string));
    const added = record?.additions ?? mainline?.files.reduce((n, f) => n + f.additions, 0) ?? 0;
    if (stat && stat.lines_added > 0 && stat.lines_added >= added * VENDOR_COMMIT_SHARE) {
      return {
        agent: { vendor: stat.vendor, ...(stat.model ? { model: stat.model } : {}) },
        person,
        signal: "vendor_stats",
      };
    }
    return { person };
  };

  return (origin, landing) => {
    const key = `${origin}\n${landing.landing.commits[0]?.sha ?? ""}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const mainline = landing.landing.commits.find((commit) => commit.sha === origin);
    let author: CommitAuthor;
    if (mainline && mainline.parents.length > 1) {
      const pull = landing.landing.pr === undefined ? undefined : pulls.get(landing.landing.pr);
      const person = mainline.authorEmail || "unknown";
      if (pull?.agent) {
        author = { agent: ref(pull.agent), person, signal: "pull_request" };
      } else {
        const counts = new Map<string, { agent: AgentRef; lines: number }>();
        for (const line of landing.lines) {
          if (line.origin === origin) continue;
          const other = own(line.origin, landing, undefined);
          if (!other.agent) continue;
          const k = `${other.agent.vendor}\n${other.agent.model ?? ""}`;
          const entry = counts.get(k) ?? { agent: other.agent, lines: 0 };
          entry.lines++;
          counts.set(k, entry);
        }
        const [best] = [...counts.entries()].sort(
          ([a, x], [b, y]) => y.lines - x.lines || (a < b ? -1 : a > b ? 1 : 0),
        );
        author = best ? { agent: best[1].agent, person, signal: "merge" } : { person };
      }
    } else {
      author = own(origin, landing, mainline);
    }
    cache.set(key, author);
    return author;
  };
}
