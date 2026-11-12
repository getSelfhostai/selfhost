import { databaseOf, isPostgresUrl, openLedger, readPresence } from "@selfhost/ledger";
import { type PresenceResponse, type PresenceRun, presenceIdleMinutes } from "@selfhost/schema";
import type { Command } from "commander";
import { plural } from "./format.js";
import { loadConfig } from "./review.js";
import { type Fetch, serverUrl, TeamClient } from "./team/client.js";
import { readMembership } from "./team/config.js";

export interface WhoOptions {
  team?: string;
  repo?: string;
  idle?: string;
  config?: string;
  database?: string;
  dataDir?: string;
  json?: boolean;
}

export interface WhoIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  configPath: string;
  fetch: Fetch;
  now?: Date;
}

const AGENT_NAMES: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  goose: "Goose",
  cursor: "Cursor",
  copilot: "Copilot",
  other: "an agent",
};

/** Files listed per run before "and N more". */
const FILES_SHOWN = 4;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function idleOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error(`--idle: expected minutes from 1 to 1440, got "${value}"`);
  }
  return minutes;
}

const ago = (from: string, now: Date) => {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 1) return "just now";
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h${minutes % 60}m ago`;
};

const short = (id: string) => (id.length > 12 ? id.slice(0, 8) : id);

/** Who is in the run: the named agent, else the person, else the agent session. */
export function workerOf(run: PresenceRun): string {
  if (run.named_agent) return `agent ${run.named_agent}`;
  return run.person ?? run.actor.name ?? run.actor.id;
}

const OWNER_VIA: Record<string, string> = {
  handoff: "handed over",
  named_agent: "owns the agent",
  trigger: "started it",
  schedule: "owns the schedule",
  fallback: "[review] fallback",
};

/** The lines `selfhost who` prints: runs by repo and branch, then the overlaps. */
export function presenceLines(presence: PresenceResponse, now: Date): string[] {
  const lines: string[] = [];
  if (presence.runs.length === 0) {
    lines.push(
      `Nobody is working right now (no run active in the last ${presence.idle_minutes} minutes).`,
    );
  } else {
    lines.push(
      `${plural(presence.runs.length, "active run")} (active in the last ${presence.idle_minutes} minutes)`,
    );
  }
  let repo: string | null | undefined;
  let branch: string | null | undefined;
  for (const run of presence.runs) {
    if (run.repo !== repo) {
      repo = run.repo;
      branch = undefined;
      lines.push("", repo ?? "(no repo)");
    }
    if (run.branch !== branch) {
      branch = run.branch;
      lines.push(`  ${branch ?? "(branch not known)"}`);
    }
    const agent = run.agent ? AGENT_NAMES[run.agent.vendor] : "an agent";
    const owner =
      run.owner === null
        ? "no owner"
        : run.owner === workerOf(run)
          ? `owner ${run.owner}`
          : `owner ${run.owner}${run.owner_via && OWNER_VIA[run.owner_via] ? ` (${OWNER_VIA[run.owner_via]})` : ""}`;
    lines.push(
      `    ${workerOf(run)} with ${agent}, ${run.kind === "background" ? "background run" : "session"} ${short(run.id)}: started ${ago(run.started_at, now)}, last ${ago(run.last_event_at, now)}; ${owner}`,
    );
    if (run.files.length > 0) {
      const more = run.files.length - FILES_SHOWN;
      lines.push(
        `      editing ${run.files.slice(0, FILES_SHOWN).join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
      );
    }
    if (run.pr_url) lines.push(`      pull request ${run.pr_url}`);
  }
  if (presence.overlaps.length > 0) {
    lines.push("", "Overlaps: two runs editing the same file");
    for (const overlap of presence.overlaps) {
      lines.push(
        `  ${overlap.repo} ${overlap.file}: runs ${overlap.runs.map(short).join(", ")} (${overlap.owners.join(", ") || "no owner"}), since ${ago(overlap.since, now)}`,
      );
    }
  }
  return lines;
}

/**
 * `selfhost who`: in a team, the team server's answer for the teams this person can read; on a
 * laptop that joined no team, the local ledger's.
 */
export async function runWho(options: WhoOptions, io: WhoIo): Promise<PresenceResponse> {
  const idle = idleOf(options.idle);
  if (options.repo !== undefined && !REPO.test(options.repo)) {
    throw new Error(`--repo: expected owner/name, got "${options.repo}"`);
  }
  const now = io.now ?? new Date();
  const membership = readMembership(io.configPath);
  let presence: PresenceResponse;
  if (membership && !options.database && !options.dataDir) {
    const client = new TeamClient(serverUrl(membership.server), membership.token, io.fetch);
    presence = await client.presence({
      ...(options.team ? { team: options.team } : {}),
      ...(options.repo ? { repo: options.repo } : {}),
      ...(idle !== undefined ? { idle_minutes: idle } : {}),
    });
  } else {
    if (options.team) throw new Error("--team needs a team: join one with selfhost join");
    const { config } = loadConfig(io.cwd, options.config, io);
    const url = options.database ?? io.env.DATABASE_URL;
    const ledger = await openLedger(
      url !== undefined && isPostgresUrl(url) ? { url } : { dataDir: options.dataDir },
    );
    try {
      presence = await readPresence(databaseOf(ledger), {
        now,
        idleMinutes: idle ?? presenceIdleMinutes(config),
        teams: null,
        ...(options.repo ? { repo: options.repo } : {}),
        configFor: async () => config,
      });
    } finally {
      await ledger.close();
    }
  }
  if (options.json) io.write(JSON.stringify(presence, null, 2));
  else for (const line of presenceLines(presence, now)) io.write(line);
  return presence;
}

export function registerWho(
  program: Command,
  io: () => WhoIo,
  fail: (error: unknown, json?: boolean) => void,
): void {
  program
    .command("who")
    .description(
      "who (people and named agents) is working right now on which repo, branch and files, who owns each run, and files two runs are both editing",
    )
    .option("--team <team>", "only this team (default: every team you can read)")
    .option("--repo <owner/name>", "only runs in this repository")
    .option("--idle <minutes>", "a run with no event for this long is not active (default: 30)")
    .option("-c, --config <path>", "path to selfhost.toml, on a laptop with no team")
    .option("--database <url>", "read this Postgres ledger instead of the team server")
    .option("--data-dir <path>", "read this embedded ledger folder instead of the team server")
    .option("--json", "print the answer as JSON")
    .action(async (options: WhoOptions) => {
      try {
        await runWho(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
