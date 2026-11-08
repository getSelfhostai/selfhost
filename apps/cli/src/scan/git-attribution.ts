import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  attributionStats,
  ghCliSource,
  readCommits,
  readPulls,
  sessionsWithoutCommits,
} from "@selfhost/attribution";
import { DEFAULT_SETTINGS, readProvenance, settingsFromConfig } from "@selfhost/provenance";
import { CONFIG_FILE_NAME, type ProvenanceReport, parseConfig } from "@selfhost/schema";
import type { AttributionResult, CollectAttribution, SessionHint } from "./attribution.js";

const run = promisify(execFile);
const DAY_MS = 86_400_000;

/** owner/name from a GitHub remote url (https or ssh), else undefined. */
export function githubRepoFromRemote(url: string): string | undefined {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

async function originUrl(repoDir: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-C", repoDir, "remote", "get-url", "origin"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function ghSignedIn(): Promise<boolean> {
  try {
    await run("gh", ["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}

function within(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  return rel.startsWith("..") || rel.startsWith("/") ? undefined : rel;
}

/**
 * The session as seen from the repository: its edited files made repo-relative. A session counts
 * when it ran inside the repo or edited files in it by absolute path from a parent folder.
 */
export function sessionInRepo(session: SessionHint, repoDir: string): SessionHint | undefined {
  const root = resolve(repoDir);
  const cwdInside = session.cwd !== undefined && within(root, resolve(session.cwd)) !== undefined;
  const files = session.files
    .map((file) => within(root, resolve(session.cwd ?? root, file)))
    .filter((file): file is string => file !== undefined && file !== "");
  if (!cwdInside && files.length === 0) return undefined;
  return { ...session, cwd: root, files };
}

/** `[review]` provenance settings from the repository's own selfhost.toml, else the defaults. */
function repoSettings(repoDir: string) {
  const path = join(repoDir, CONFIG_FILE_NAME);
  if (!existsSync(path)) return DEFAULT_SETTINGS;
  const parsed = parseConfig(readFileSync(path, "utf8"));
  return parsed.ok ? settingsFromConfig(parsed.config) : DEFAULT_SETTINGS;
}

/**
 * Joins local sessions with the repository's git history, and with its pull requests when the
 * remote is on GitHub and the developer's own gh login works. Nothing else leaves the machine.
 */
export function gitAttribution(opts: { github?: boolean } = {}): CollectAttribution {
  return async (repoDir, sessions, window): Promise<AttributionResult> => {
    const local = sessions
      .map((session) => sessionInRepo(session, repoDir))
      .filter((session): session is SessionHint => session !== undefined);
    const earliest = Math.min(...sessions.map((s) => Date.parse(s.start)).filter(Number.isFinite));
    const since = new Date(
      Number.isFinite(earliest) ? earliest - DAY_MS : Date.now() - 30 * DAY_MS,
    );

    const commits = await readCommits(repoDir, { since, sessions: local });
    const remote = await originUrl(repoDir);
    const repo = remote ? githubRepoFromRemote(remote) : undefined;

    let pulls: Awaited<ReturnType<typeof readPulls>> = [];
    if (repo && opts.github !== false && (await ghSignedIn())) {
      try {
        pulls = await readPulls(repo, { since, commits, source: ghCliSource() });
      } catch {
        pulls = [];
      }
    }

    let provenance: ProvenanceReport | undefined;
    if (window) {
      try {
        provenance = await readProvenance(repoDir, {
          since: window.since,
          until: window.until,
          settings: repoSettings(repoDir),
          sessions: local,
          pulls: pulls
            .filter((pull) => pull.state === "merged")
            .map((pull) => ({ number: pull.number, ...(pull.agent ? { agent: pull.agent } : {}) })),
          ...(repo ? { repo } : {}),
        });
      } catch {
        provenance = undefined;
      }
    }

    return {
      repo,
      ...(provenance ? { provenance } : {}),
      commits: commits.map(({ sha, agent, signal, additions, deletions }) => ({
        sha,
        agent,
        signal,
        additions,
        deletions,
      })),
      pulls: pulls.map(({ number, url, agent, unreviewedMerge, additions, deletions }) => ({
        number,
        url,
        agent,
        unreviewedMerge,
        additions,
        deletions,
      })),
      stats: attributionStats(commits, pulls),
      sessionsWithoutCommits: sessionsWithoutCommits(local, commits),
    };
  };
}
