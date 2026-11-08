import { basename } from "node:path";
import { CCUSAGE_VERSION } from "@selfhost/importers";
import type { LedgerEvent, ProvenanceReport } from "@selfhost/schema";
import {
  costPerMergedPr,
  groupSpend,
  oneSourcePerSession,
  type RoiPullEvent,
  type RoiReport,
  type SpendTotals,
  totalSpend,
  utcDay,
  type WasteFlag,
} from "@selfhost/spend";
import { percent, usd } from "../format.js";
import type { AgentRef, AgentVendor, AttributionResult } from "./attribution.js";
import { type ContextSection, contextSection, type ScannedContext } from "./context/index.js";
import { findLeaks, type LeakFinding, sessionKey } from "./leaks.js";
import { type SessionStats, summarizeSessions } from "./sessions.js";

export const SCAN_SCHEMA = "selfhost.scan/v1";

export const VENDOR_NAMES: Record<AgentVendor, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  goose: "Goose",
  cursor: "Cursor",
  copilot: "Copilot",
  other: "Other agent",
};

export const CCUSAGE_CREDIT = `Token counts and prices follow ccusage ${CCUSAGE_VERSION} by ryoppippi (MIT), https://github.com/ccusage/ccusage.`;

export const NEXT_STEP = "Run selfhost init to keep watching, or start a team to see everyone.";

/** How many sessions the most-expensive list holds. */
export const TOP_SESSIONS = 5;

/** The plan-limit forecast, once that feature ships. */
export interface PlanForecast {
  /** Plan name, for example "Claude Max 5x". */
  plan: string;
  /** Share of the plan's limit used so far in the current period, 0 to 1. */
  used_share: number;
  /** When the limit runs out at the current pace, or null when it lasts the period. */
  runs_out_at: string | null;
  period_end: string;
}

export interface ScanInput {
  /** cost.recorded and session events (session.started, tool.called, commit.created). */
  events: LedgerEvent[];
  /** detectWaste flags over the same cost events, grouped by request type. */
  waste: WasteFlag[];
  attribution?: AttributionResult;
  forecast?: PlanForecast;
  /** The git repository the scan tried to join, when there was one. */
  repoDir?: string;
  /** Context files found in the repository and the home config, with token counts. */
  context?: ScannedContext;
  from: Date;
  to: Date;
}

export interface CommitShare {
  vendor: AgentVendor | "unattributed";
  /** "Claude Code", "Codex (gpt-5.5)" or "unattributed". */
  agent: string;
  model: string | null;
  commits: number;
  share: number;
}

export interface GitNumbers {
  /** joined: the numbers are here. needs_repo: no git repo given or found. not_joined: a repo
   * was found but could not be joined with the sessions. */
  status: "joined" | "needs_repo" | "not_joined";
  /** owner/name, else the folder, else null. */
  repo: string | null;
  commit_share: CommitShare[] | null;
  unreviewed_merges: {
    count: number;
    /** Agent PRs that merged. */
    merged: number;
    prs: { number: number; url: string; agent: string }[];
  } | null;
  no_commit_spend: { usd: number; share: number; sessions: number } | null;
}

export interface CostRow extends SpendTotals {
  vendor: string;
  agent: string;
  model?: string;
  share: number;
}

export interface TopSession {
  vendor: AgentVendor;
  agent: string;
  session_id: string;
  /** Folder name of the session's cwd. */
  project: string | null;
  cwd: string | null;
  start: string;
  end: string;
  model: string | null;
  requests: number;
  tokens: number;
  usd: number;
  share: number;
  /** null without a git join. */
  no_commit: boolean | null;
  reason: string;
}

export interface ScanReport {
  schema: typeof SCAN_SCHEMA;
  from: string;
  to: string;
  totals: {
    usd: number;
    tokens: number;
    requests: number;
    sessions: number;
    agents: number;
    /** Spend on requests a leak rule picked out, each counted once. */
    leak_usd: number;
    leak_share: number;
  };
  agents: { vendor: AgentVendor; agent: string; sessions: number; usd: number }[];
  git: GitNumbers;
  /**
   * Lines merged to the main branch in the window by agent, model, person and module, and how
   * many were reverted or reworked; null without a git join. `selfhost provenance` prints it all.
   */
  provenance: ProvenanceReport | null;
  /**
   * Cost per merged agent pull request in the window, from this repo's sessions; null without a
   * git join or pull requests. No baseline: the scan keeps nothing. `selfhost roi` has one.
   */
  roi: RoiReport | null;
  cost: { by_agent: CostRow[]; by_model: CostRow[] };
  leaks: LeakFinding[];
  waste: WasteFlag[];
  top_sessions: TopSession[];
  forecast: PlanForecast | null;
  /** Context files: who reads each, duplicates, conflicts and what always-loaded context costs. */
  context: ContextSection;
  credit: string;
  next: string;
}

export const agentName = (vendor: string) =>
  VENDOR_NAMES[vendor as AgentVendor] ?? (vendor === "unknown" ? "unknown agent" : vendor);

function refName(agent: AgentRef | "unattributed"): string {
  if (agent === "unattributed") return "unattributed";
  return agent.model ? `${agentName(agent.vendor)} (${agent.model})` : agentName(agent.vendor);
}

function gitNumbers(input: ScanInput, sessions: SessionStats[], totalUsd: number): GitNumbers {
  const attribution = input.attribution;
  const repo = attribution?.repo ?? input.repoDir ?? null;
  if (!attribution) {
    return {
      status: input.repoDir ? "not_joined" : "needs_repo",
      repo,
      commit_share: null,
      unreviewed_merges: null,
      no_commit_spend: null,
    };
  }
  const commitShare = attribution.stats.byAgent
    .map(
      (stats): CommitShare => ({
        vendor: stats.agent === "unattributed" ? "unattributed" : stats.agent.vendor,
        agent: refName(stats.agent),
        model: stats.agent === "unattributed" ? null : (stats.agent.model ?? null),
        commits: stats.commits,
        share: stats.commitShare,
      }),
    )
    .sort((a, b) => b.commits - a.commits || a.agent.localeCompare(b.agent));
  const agentPulls = attribution.pulls.filter((pull) => pull.agent);
  const unreviewed = agentPulls.filter((pull) => pull.unreviewedMerge);
  const merged = attribution.stats.byAgent
    .filter((stats) => stats.agent !== "unattributed")
    .reduce((total, stats) => total + stats.merged, 0);
  const without = new Set(attribution.sessionsWithoutCommits);
  const idle = sessions.filter((session) => without.has(session.sessionId));
  const idleUsd = idle.reduce((total, session) => total + session.usd, 0);
  return {
    status: "joined",
    repo,
    commit_share: commitShare,
    unreviewed_merges: {
      count: unreviewed.length,
      merged: Math.max(merged, unreviewed.length),
      prs: unreviewed
        .map((pull) => ({
          number: pull.number,
          url: pull.url,
          agent: refName(pull.agent ?? "unattributed"),
        }))
        .sort((a, b) => a.number - b.number),
    },
    no_commit_spend: {
      usd: idleUsd,
      share: totalUsd > 0 ? idleUsd / totalUsd : 0,
      sessions: idle.length,
    },
  };
}

/**
 * Cost per merged agent PR from the repo's sessions, joined to pull requests by their commits;
 * null without a git join or with no pull requests read (no GitHub remote or gh login).
 */
function roiOf(input: ScanInput, costs: LedgerEvent[]): RoiReport | null {
  const attribution = input.attribution;
  if (!attribution || attribution.pulls.length === 0) return null;
  const repo = attribution.repo?.toLowerCase();
  const inRepo = new Set(attribution.sessions ?? []);
  const prOf = new Map<string, string>();
  for (const pull of attribution.pulls)
    for (const sha of pull.commits ?? []) prOf.set(sha, pull.url);
  const links = new Map<string, { session: string; pr: string }>();
  for (const commit of attribution.commits) {
    const pr = prOf.get(commit.sha);
    if (commit.sessionId && pr)
      links.set(`${commit.sessionId}\n${pr}`, { session: commit.sessionId, pr });
  }
  const pulls = attribution.pulls.flatMap((pull): RoiPullEvent[] => {
    const at =
      pull.state === "merged" ? pull.mergedAt : pull.state === "closed" ? pull.closedAt : undefined;
    if (!at) return [];
    return [
      {
        url: pull.url,
        kind: pull.state === "merged" ? "pr.merged" : "pr.closed",
        ts: at,
        ...(repo ? { repo } : {}),
        ...(pull.agent ? { agent: pull.agent.vendor } : {}),
        ...(pull.agent?.model ? { model: pull.agent.model } : {}),
      },
    ];
  });
  const from = input.from.getTime();
  const to = input.to.getTime();
  return costPerMergedPr({
    team: null,
    from: input.from,
    to: input.to,
    links: [...links.values()],
    pulls,
    costs: costs
      .filter((event) => event.session_id && inRepo.has(event.session_id))
      .map((event) => {
        const at = Date.parse(event.ts);
        return {
          session: event.session_id as string,
          ...(event.agent ? { agent: event.agent.vendor } : {}),
          ...(event.model ? { model: event.model } : {}),
          source: event.source,
          ...(repo ? { repo } : {}),
          usd: event.cost?.usd ?? 0,
          in_window: at >= from && at < to,
        };
      }),
  });
}

/** Why a session cost what it did, from its leaks first, then its shape. */
function sessionReason(session: SessionStats, leaks: string[], noCommit: boolean | null): string {
  const reasons = leaks.slice(0, 2);
  if (reasons.length === 0) {
    const requests = session.costs.length;
    const context = requests > 0 ? session.costs.reduce((t, c) => t + c.context, 0) / requests : 0;
    const subagent = session.costs
      .filter((cost) => cost.requestType === "subagent")
      .reduce((total, cost) => total + cost.usd, 0);
    const hours = (Date.parse(session.end) - Date.parse(session.start)) / 3_600_000;
    if (session.usd > 0 && subagent / session.usd >= 0.4) {
      reasons.push(`subagents were ${percent(subagent / session.usd)} of its spend`);
    } else if (context >= 80_000) {
      reasons.push(`large context, ${Math.round(context / 1000)}k tokens per request on average`);
    } else if (requests >= 50) {
      reasons.push(`long session, ${requests} requests over ${hours.toFixed(1)} hours`);
    } else {
      const each = requests > 0 ? session.usd / requests : 0;
      reasons.push(
        `${requests} requests on ${session.model ?? "an unknown model"}, ${usd(each)} each`,
      );
    }
  }
  if (noCommit) reasons.push("no commit");
  return reasons.join("; ");
}

function costRows(costs: LedgerEvent[], input: ScanInput, by: ("agent" | "model")[]): CostRow[] {
  const { groups } = totalSpend(groupSpend(costs, { by, from: input.from, to: input.to }));
  return groups.map(({ group, share, ...totals }) => ({
    vendor: group.agent ?? "unknown",
    agent: agentName(group.agent ?? "unknown"),
    ...(group.model ? { model: group.model } : {}),
    ...totals,
    share,
  }));
}

/**
 * The scan report: cost by agent and model, leak findings, the most expensive sessions, the
 * context files and their drift and, with a git join, who wrote the commits, what merged with no
 * review and what spend left no commit. Pure: the same input gives the same report.
 */
export function buildScanReport(input: ScanInput): ScanReport {
  const costs = oneSourcePerSession(input.events.filter((e) => e.kind === "cost.recorded"));
  const costIds = new Set(costs.map((event) => event.id));
  const sessions = summarizeSessions(
    input.events.filter((event) => event.kind !== "cost.recorded" || costIds.has(event.id)),
  ).filter((session) => session.costs.length > 0 || session.tools.length > 0);
  const { total } = totalSpend(
    groupSpend(costs, { by: ["agent"], from: input.from, to: input.to }),
  );
  const leaks = findLeaks(sessions, input.waste, total.usd);
  const git = gitNumbers(input, sessions, total.usd);
  const without = new Set(input.attribution?.sessionsWithoutCommits ?? []);

  const agents = new Map<AgentVendor, { sessions: number; usd: number }>();
  for (const session of sessions) {
    const entry = agents.get(session.vendor) ?? { sessions: 0, usd: 0 };
    entry.sessions++;
    entry.usd += session.usd;
    agents.set(session.vendor, entry);
  }

  const top = [...sessions]
    .filter((session) => session.usd > 0)
    .sort((a, b) => b.usd - a.usd || a.sessionId.localeCompare(b.sessionId))
    .slice(0, TOP_SESSIONS)
    .map((session): TopSession => {
      const noCommit = input.attribution ? without.has(session.sessionId) : null;
      const leakReasons = leaks.reasons.get(sessionKey(session.vendor, session.sessionId)) ?? [];
      return {
        vendor: session.vendor,
        agent: agentName(session.vendor),
        session_id: session.sessionId,
        project: session.cwd ? basename(session.cwd) : null,
        cwd: session.cwd ?? null,
        start: session.start,
        end: session.end,
        model: session.model ?? null,
        requests: session.costs.length,
        tokens: session.tokens,
        usd: session.usd,
        share: total.usd > 0 ? session.usd / total.usd : 0,
        no_commit: noCommit,
        reason: sessionReason(session, leakReasons, noCommit),
      };
    });

  return {
    schema: SCAN_SCHEMA,
    from: utcDay(input.from) ?? "",
    to: utcDay(input.to) ?? "",
    totals: {
      usd: total.usd,
      tokens: total.tokens,
      requests: total.requests,
      sessions: sessions.length,
      agents: agents.size,
      leak_usd: leaks.usd,
      leak_share: total.usd > 0 ? leaks.usd / total.usd : 0,
    },
    agents: [...agents]
      .map(([vendor, entry]) => ({ vendor, agent: agentName(vendor), ...entry }))
      .sort((a, b) => b.usd - a.usd || a.vendor.localeCompare(b.vendor)),
    git,
    provenance: input.attribution?.provenance ?? null,
    roi: roiOf(input, costs),
    cost: {
      by_agent: costRows(costs, input, ["agent"]),
      by_model: costRows(costs, input, ["agent", "model"]),
    },
    leaks: leaks.findings,
    waste: input.waste,
    top_sessions: top,
    forecast: input.forecast ?? null,
    context: contextSection(input.context, sessions, { from: input.from, to: input.to }),
    credit: CCUSAGE_CREDIT,
    next: NEXT_STEP,
  };
}
