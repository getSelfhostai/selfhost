import { realpathSync } from "node:fs";
import { sep } from "node:path";
import {
  type AgentRef,
  type CommitRecord,
  FILE_TIME_SLACK_MS,
  type GitHubCommit,
  type GitHubPull,
  type GitHubSource,
  ghCliSource,
  readCommits,
  readPulls,
  type SessionHint,
} from "@selfhost/attribution";
import type { EventFilter, Ledger } from "@selfhost/ledger";
import { type ToolCall, toolCallFromEvent } from "@selfhost/policy";
import { AGENT_VENDORS, type AgentVendor, type LedgerEvent } from "@selfhost/schema";
import { compare, isManifest, type ManifestChange, newDependencies } from "./dependencies.js";
import { ghCli, githubRepo, gitIn, parseNumstat, type Runner } from "./git.js";
import { REVERT_WINDOW_DAYS, revertedShas, revertHistory } from "./reverts.js";
import type {
  ChangedFile,
  GuardrailHit,
  RiskInput,
  RiskInputs,
  RunInput,
  TestStatus,
} from "./types.js";

const DAY_MS = 86_400_000;
const PAGE = 1000;

/** Tools that write or patch files, across Claude Code and Codex. */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
]);

export type RiskTarget = { pr: number } | { base: string; head?: string };

export interface GatherOptions {
  /** Any folder inside the repository. */
  repoDir: string;
  /** A pull request on GitHub, read with gh, or local commits from the merge base of `base`. */
  target: RiskTarget;
  /** owner/name. Default: the origin remote. */
  repo?: string;
  /** Where the agent runs are. Without it, the run inputs are missing. */
  ledger?: Pick<Ledger, "query">;
  /** From the sandbox or CI; undefined until sandbox runs exist. */
  tests?: TestStatus;
  now?: Date;
  /** Runs gh. Default: the developer's own gh login. */
  gh?: Runner;
  /** Where gh responses are cached. Default: ~/.selfhost/cache/github. */
  ghCacheDir?: string;
}

/** What was scored. */
export interface GatheredTarget {
  /** The repository root. */
  root: string;
  pr?: { repo: string; number: number; url: string };
  base: string;
  head: string;
  /** Commit SHAs in the change, oldest first. */
  commits: string[];
}

export interface Gathered {
  target: GatheredTarget;
  inputs: RiskInputs;
}

interface Change {
  target: GatheredTarget;
  files: ChangedFile[];
  /** Commit times, ISO 8601. */
  times: string[];
  manifests: ManifestChange[];
  /** Why manifests could not be read, when one could not. */
  manifestProblem?: string;
  /** The agent attribution found on GitHub. */
  pullAgent?: AgentRef;
}

async function* ledgerEvents(
  ledger: Pick<Ledger, "query">,
  filter: EventFilter,
): AsyncGenerator<LedgerEvent> {
  let cursor: string | undefined;
  do {
    const page = await ledger.query({ ...filter, limit: PAGE, cursor });
    yield* page.events;
    cursor = page.nextCursor;
  } while (cursor);
}

async function show(git: Runner, ref: string, path: string): Promise<string | undefined> {
  try {
    return await git(["show", `${ref}:${path}`]);
  } catch {
    return undefined;
  }
}

/** Local commits from the merge base of `base` up to `head`, diffed like a pull request. */
async function localChange(root: string, base: string, head: string): Promise<Change> {
  const git = gitIn(root);
  const mergeBase = (await git(["merge-base", base, head])).trim();
  const log = (await git(["log", "--reverse", "--format=%H%x1f%aI", `${mergeBase}..${head}`]))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\x1f"));
  if (log.length === 0) throw new Error(`No commits on ${head} since ${base}`);
  const files = parseNumstat(
    await git(["diff", "-z", "-M", "--numstat", "--no-ext-diff", "--no-textconv", mergeBase, head]),
  );
  const manifests: ManifestChange[] = [];
  let manifestProblem: string | undefined;
  for (const file of files.filter((f) => isManifest(f.path))) {
    const [before, after] = await Promise.all([
      show(git, mergeBase, file.previousPath ?? file.path),
      show(git, head, file.path),
    ]);
    if (after === undefined && before === undefined) {
      manifestProblem = `could not read ${file.path}`;
    }
    manifests.push({
      path: file.path,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    });
  }
  return {
    target: {
      root,
      base: mergeBase,
      head: (await git(["rev-parse", head])).trim(),
      commits: log.map(([sha]) => sha ?? ""),
    },
    files,
    times: log.map(([, time]) => time ?? ""),
    manifests,
    ...(manifestProblem ? { manifestProblem } : {}),
  };
}

interface PullDetail extends GitHubPull {
  base: { sha: string };
  head: { ref: string; sha: string };
}

interface PullFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
}

const commitTimes = (commits: GitHubCommit[]) =>
  commits
    .map((commit) => commit.commit.author?.date)
    .filter((time): time is string => typeof time === "string");

const api = (gh: Runner, path: string, accept = "application/vnd.github+json") =>
  gh(["api", "-H", `Accept: ${accept}`, "-H", "X-GitHub-Api-Version: 2022-11-28", path]);

/** A pull request through gh (read-only GET requests), with its manifests at base and head. */
async function pullChange(
  root: string,
  repo: string,
  pull: PullDetail,
  apiCommits: GitHubCommit[],
  gh: Runner,
  source: GitHubSource,
  local: () => Promise<CommitRecord[]>,
): Promise<Change> {
  const number = pull.number;
  const listed: PullFile[] = [];
  // GitHub lists at most 3000 files.
  for (let page = 1; page <= 30; page++) {
    const batch = JSON.parse(
      await api(gh, `repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`),
    ) as PullFile[];
    listed.push(...batch);
    if (batch.length < 100) break;
  }
  const files: ChangedFile[] = listed.map((file) => ({
    path: file.filename,
    ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
    additions: file.additions,
    deletions: file.deletions,
  }));
  const contents = async (path: string, ref: string) => {
    try {
      return await api(
        gh,
        `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`,
        "application/vnd.github.raw+json",
      );
    } catch {
      return undefined;
    }
  };
  const manifests: ManifestChange[] = [];
  let manifestProblem: string | undefined;
  for (const file of listed.filter((f) => isManifest(f.filename))) {
    const before =
      file.status === "added"
        ? undefined
        : await contents(file.previous_filename ?? file.filename, pull.base.sha);
    const after =
      file.status === "removed" ? undefined : await contents(file.filename, pull.head.sha);
    if (
      (file.status !== "added" && before === undefined) ||
      (file.status !== "removed" && after === undefined)
    ) {
      manifestProblem = `could not read ${file.filename} from GitHub`;
    }
    manifests.push({
      path: file.filename,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    });
  }

  // Attribution as readPulls does it, for this one pull request.
  const [record] = await readPulls(repo, {
    since: new Date(0),
    commits: await local(),
    source: { ...source, pulls: async () => [pull] },
  });
  return {
    target: {
      root,
      pr: { repo, number, url: pull.html_url },
      base: pull.base.sha,
      head: pull.head.sha,
      commits: apiCommits.map((commit) => commit.sha),
    },
    files,
    times: commitTimes(apiCommits),
    manifests,
    ...(manifestProblem ? { manifestProblem } : {}),
    ...(record?.agent ? { pullAgent: record.agent } : {}),
  };
}

function isVendor(value: unknown): value is AgentVendor {
  return typeof value === "string" && (AGENT_VENDORS as readonly string[]).includes(value);
}

/** Working folder of each session, from its session.started event. */
async function sessionCwd(
  ledger: Pick<Ledger, "query">,
  session: string,
  known: Map<string, string | undefined>,
): Promise<string | undefined> {
  if (known.has(session)) return known.get(session);
  const { events } = await ledger.query({ kind: "session.started", session, limit: 1 });
  const cwd = events[0]?.data?.cwd;
  const value = typeof cwd === "string" && cwd !== "" ? cwd : undefined;
  known.set(session, value);
  return value;
}

/**
 * Sessions that edited files between `from` and `to`, as readCommits matches them to commits by
 * file and time.
 */
async function sessionHints(
  ledger: Pick<Ledger, "query">,
  from: Date,
  to: Date,
  cwds: Map<string, string | undefined>,
): Promise<SessionHint[]> {
  const sessions = new Map<string, SessionHint>();
  for await (const event of ledgerEvents(ledger, {
    kind: "tool.called",
    from: from.toISOString(),
    to: to.toISOString(),
  })) {
    if (!event.session_id || !isVendor(event.agent?.vendor)) continue;
    let hint = sessions.get(event.session_id);
    if (!hint) {
      hint = {
        sessionId: event.session_id,
        vendor: event.agent.vendor,
        ...(event.model ? { model: event.model } : {}),
        start: event.ts,
        end: event.ts,
        files: [],
      };
      sessions.set(event.session_id, hint);
    }
    if (event.ts < hint.start) hint.start = event.ts;
    if (event.ts > hint.end) hint.end = event.ts;
    if (event.tool && EDIT_TOOLS.has(event.tool.name) && event.target?.type === "file") {
      hint.files.push(event.target.value);
    }
  }
  const hints: SessionHint[] = [];
  for (const hint of sessions.values()) {
    const cwd = await sessionCwd(ledger, hint.sessionId, cwds);
    if (cwd && hint.files.length > 0) hints.push({ ...hint, cwd });
  }
  return hints;
}

const shaMatches = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

/**
 * The run behind the change: sessions whose commits are in it (commit.created events, or the
 * sessions readCommits matched by session link, file and time), with their tool calls and the
 * guardrail hits recorded on them.
 */
async function ledgerRun(
  ledger: Pick<Ledger, "query">,
  root: string,
  change: Change,
  matched: CommitRecord[],
  window: { from: Date; to: Date },
  cwds: Map<string, string | undefined>,
): Promise<RunInput | undefined> {
  const sessions = new Set(
    matched.flatMap((commit) => (commit.sessionId ? [commit.sessionId] : [])),
  );
  for await (const event of ledgerEvents(ledger, {
    kind: "commit.created",
    from: window.from.toISOString(),
    to: window.to.toISOString(),
  })) {
    const sha = event.links?.commit_sha;
    if (event.session_id && sha && change.target.commits.some((c) => shaMatches(c, sha))) {
      sessions.add(event.session_id);
    }
  }
  if (sessions.size === 0) return undefined;
  const ids = [...sessions].sort(compare);
  const toolCalls: ToolCall[] = [];
  const guardrails = new Map<string, GuardrailHit>();
  for (const session of ids) {
    const cwd = await sessionCwd(ledger, session, cwds);
    const events: LedgerEvent[] = [];
    for await (const event of ledgerEvents(ledger, { kind: "tool.called", session })) {
      events.push(event);
    }
    events.sort((a, b) => compare(a.ts, b.ts) || compare(a.id, b.id));
    for (const event of events) {
      // Calls outside the repository count too: an outside effect rarely touches it.
      const call =
        toolCallFromEvent(event, rootAsSeenFrom(root, cwd), cwd) ?? toolCallFromEvent(event);
      if (call) toolCalls.push(call);
    }
    for await (const event of ledgerEvents(ledger, { kind: "policy.evaluated", session })) {
      const decision = event.decision;
      if (!decision?.rule_id || (decision.verdict !== "block" && decision.verdict !== "ask")) {
        continue;
      }
      const toolEvent = event.data?.tool_event_id;
      // A policy file that changed records the same hit again under a new id.
      const key = `${typeof toolEvent === "string" ? toolEvent : event.id}\n${decision.rule_id}`;
      if (guardrails.has(key)) continue;
      guardrails.set(key, {
        rule_id: decision.rule_id,
        verdict: decision.verdict,
        mode: decision.mode === "enforce" ? "enforce" : "observe",
        // Paths count through the diff only, as in scoreRisk.
        irreversible: event.data?.irreversible === true && event.target?.type !== "file",
      });
    }
  }
  return {
    sessions: ids,
    toolCalls,
    guardrails: [...guardrails.values()],
  };
}

/**
 * The repository root spelled the way the session spelled its folder, so a session that ran in
 * /tmp/repo still matches a root git reports as /private/tmp/repo.
 */
function rootAsSeenFrom(root: string, cwd: string | undefined): string {
  if (cwd === undefined) return root;
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return root;
  }
  if (real === cwd || !(real === root || real.startsWith(`${root}${sep}`))) return root;
  const inside = real.slice(root.length);
  return cwd.endsWith(inside) ? cwd.slice(0, cwd.length - inside.length) : root;
}

/** The agent and model behind most of the attributed commits; ties go to the first by name. */
function mainAgent(commits: CommitRecord[]): AgentRef | undefined {
  const counts = new Map<string, { agent: AgentRef; count: number }>();
  for (const commit of commits) {
    if (!commit.agent) continue;
    const key = `${commit.agent.vendor}\n${commit.agent.model ?? ""}`;
    const entry = counts.get(key) ?? { agent: commit.agent, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const [best] = [...counts.entries()].sort(([a, x], [b, y]) => y.count - x.count || compare(a, b));
  return best?.[1].agent;
}

/** The agent and model of the run's tool calls, when its commits carry no attribution. */
function runAgent(run: RunInput | undefined): AgentRef | undefined {
  const call = run?.toolCalls.find((c) => c.agent !== undefined);
  if (!call?.agent) return undefined;
  const model = run?.toolCalls.find((c) => c.agent === call.agent && c.model)?.model;
  return { vendor: call.agent, ...(model ? { model } : {}) };
}

async function originRepo(root: string): Promise<string | undefined> {
  try {
    return githubRepo(await gitIn(root)(["remote", "get-url", "origin"]));
  } catch {
    return undefined;
  }
}

/**
 * Reads everything the score needs, locally: the diff and manifests from git (or from GitHub
 * through gh for a pull request number), attribution and revert history from git, and the
 * agent run from the ledger. Never writes to GitHub. Inputs it cannot find are left undefined
 * with the reason in `unavailable`.
 */
export async function gatherRiskInputs(opts: GatherOptions): Promise<Gathered> {
  const now = opts.now ?? new Date();
  const root = (await gitIn(opts.repoDir)(["rev-parse", "--show-toplevel"])).trim();
  const git = gitIn(root);
  const since = new Date(now.getTime() - REVERT_WINDOW_DAYS * DAY_MS);
  const cwds = new Map<string, string | undefined>();
  const unavailable: Partial<Record<RiskInput, string>> = {};

  // Commits are read once the change's time window is known, for attribution and reverts.
  let window: { from: Date; to: Date } | undefined;
  let commits: CommitRecord[] | undefined;
  const readLocal = async () => {
    if (commits) return commits;
    const sessions =
      opts.ledger && window ? await sessionHints(opts.ledger, window.from, window.to, cwds) : [];
    const from = window && window.from < since ? window.from : since;
    commits = await readCommits(root, { since: from, sessions });
    return commits;
  };
  const windowOf = (times: string[]) => {
    const stamps = times.map((time) => Date.parse(time)).filter(Number.isFinite);
    if (stamps.length === 0) return undefined;
    return {
      from: new Date(Math.min(...stamps) - DAY_MS),
      to: new Date(Math.max(...stamps) + FILE_TIME_SLACK_MS),
    };
  };

  let change: Change;
  if ("pr" in opts.target) {
    const repo = opts.repo ?? (await originRepo(root));
    if (!repo) {
      throw new Error(
        "No GitHub repository: the origin remote is not on github.com. Pass --base <ref> to score local commits.",
      );
    }
    const gh = opts.gh ?? ghCli;
    const source = ghCliSource({
      run: gh,
      ...(opts.ghCacheDir ? { cacheDir: opts.ghCacheDir } : {}),
    });
    const number = opts.target.pr;
    // The window needs the commit times, so read them before the local commits.
    const pull = JSON.parse(await api(gh, `repos/${repo}/pulls/${number}`)) as PullDetail;
    const apiCommits = await source.commits(repo, { number, updatedAt: pull.updated_at });
    window = windowOf(commitTimes(apiCommits));
    change = await pullChange(root, repo, pull, apiCommits, gh, source, readLocal);
  } else {
    change = await localChange(root, opts.target.base, opts.target.head ?? "HEAD");
    window = windowOf(change.times);
  }

  const local = await readLocal();
  const inChange = new Set(change.target.commits.map((sha) => sha.toLowerCase()));
  const matched = local.filter((commit) => inChange.has(commit.sha.toLowerCase()));

  let run: RunInput | undefined;
  if (!opts.ledger) {
    unavailable.outside_effects = unavailable.guardrails = "no ledger";
  } else if (window) {
    run = await ledgerRun(opts.ledger, root, change, matched, window, cwds);
    if (!run) {
      unavailable.outside_effects = unavailable.guardrails =
        "no session in the ledger made or edited these commits";
    }
  }

  const agent = change.pullAgent ?? mainAgent(matched) ?? runAgent(run);
  let reverts: RiskInputs["reverts"];
  if (agent) {
    const messages = (
      await git([
        "log",
        "--branches",
        "--remotes",
        `--since=${since.toISOString()}`,
        "--grep=This reverts commit",
        "--format=%x1e%B",
      ])
    ).split("\x1e");
    reverts = revertHistory(
      local.filter((commit) => Date.parse(commit.authoredAt) >= since.getTime()),
      revertedShas(messages),
      agent,
      { exclude: inChange, days: REVERT_WINDOW_DAYS },
    );
  } else {
    unavailable.reverts = "no agent attributed to these commits";
  }

  let dependencies: RiskInputs["dependencies"];
  if (change.manifestProblem) unavailable.dependencies = change.manifestProblem;
  else dependencies = newDependencies(change.manifests);

  if (opts.tests === undefined) unavailable.tests = "no sandbox run yet";

  return {
    target: change.target,
    inputs: {
      files: change.files,
      ...(dependencies ? { dependencies } : {}),
      ...(opts.tests ? { tests: opts.tests } : {}),
      ...(run ? { run } : {}),
      ...(reverts ? { reverts } : {}),
      ...(agent ? { agent } : {}),
      unavailable,
    },
  };
}
