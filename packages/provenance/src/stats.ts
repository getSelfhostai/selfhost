import type { AgentRef } from "@selfhost/attribution";
import {
  AGENT_VENDORS,
  type LedgerEvent,
  PROVENANCE_SCHEMA,
  type ProvenanceAgentRow,
  type ProvenanceAuthor,
  type ProvenanceModuleRow,
  type ProvenancePersonRow,
  type ProvenanceReport,
  type VendorLineStat,
  type VendorReportedRow,
} from "@selfhost/schema";
import { MIN_MODULE_LINES } from "./modules.js";
import type { CommitAuthor, ProvenanceSettings, TrackedLanding } from "./types.js";

export interface ReportInput {
  repo: string | null;
  from: Date;
  to: Date;
  branch: string | null;
  head: string | null;
  settings: ProvenanceSettings;
  landings: TrackedLanding[];
  author: (origin: string, landing: TrackedLanding) => CommitAuthor;
  vendorStats?: VendorLineStat[];
}

const ORDER: readonly ProvenanceAuthor[] = [...AGENT_VENDORS, "unattributed"];

interface Tally {
  vendor: ProvenanceAuthor;
  model: string | null;
  lines: number;
  reverted: number;
  reworked: number;
  open: number;
  landings: Set<string>;
  runs: Set<string>;
}

const keyOf = (agent: AgentRef | undefined) =>
  agent ? `${agent.vendor}\n${agent.model ?? ""}` : "unattributed\n";

function tally(agent: AgentRef | undefined): Tally {
  return {
    vendor: agent?.vendor ?? "unattributed",
    model: agent?.model ?? null,
    lines: 0,
    reverted: 0,
    reworked: 0,
    open: 0,
    landings: new Set(),
    runs: new Set(),
  };
}

function bump<K>(map: Map<K, Tally>, key: K, agent: AgentRef | undefined): Tally {
  let entry = map.get(key);
  if (!entry) {
    entry = tally(agent);
    map.set(key, entry);
  }
  return entry;
}

const rate = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

function compareAgents(
  a: { vendor: ProvenanceAuthor; model: string | null },
  b: { vendor: ProvenanceAuthor; model: string | null },
): number {
  return (
    ORDER.indexOf(a.vendor) - ORDER.indexOf(b.vendor) ||
    (a.model ?? "").localeCompare(b.model ?? "")
  );
}

const byLines = (a: { lines: number } & Parameters<typeof compareAgents>[0], b: typeof a) =>
  b.lines - a.lines || compareAgents(a, b);

type People = Map<string, { lines: number; agents: Map<string, Tally> }>;

/** Most lines first. */
function personRows(people: People): ProvenancePersonRow[] {
  return [...people.entries()]
    .map(([person, entry]): ProvenancePersonRow => {
      const agentLines = [...entry.agents.values()]
        .filter((row) => row.vendor !== "unattributed")
        .reduce((sum, row) => sum + row.lines, 0);
      return {
        person,
        lines: entry.lines,
        agent_lines: agentLines,
        agent_share: share(agentLines, entry.lines),
        by_agent: [...entry.agents.values()]
          .map((row) => ({ vendor: row.vendor, model: row.model, lines: row.lines }))
          .sort(byLines),
      };
    })
    .sort((a, b) => b.lines - a.lines || a.person.localeCompare(b.person));
}

function vendorReported(
  stats: VendorLineStat[] | undefined,
  from: Date,
  to: Date,
  landed: Set<string>,
): VendorReportedRow[] {
  const totals = new Map<string, VendorReportedRow>();
  const fromDay = from.toISOString().slice(0, 10);
  const toDay = to.toISOString().slice(0, 10);
  for (const stat of stats ?? []) {
    const inWindow = stat.commit
      ? [...landed].some((sha) => sha.startsWith(stat.commit?.toLowerCase() ?? "~"))
      : stat.day !== undefined && stat.day >= fromDay && stat.day <= toDay;
    if (!inWindow) continue;
    const row = totals.get(stat.vendor) ?? {
      vendor: stat.vendor,
      lines_added: 0,
      lines_removed: 0,
    };
    row.lines_added += stat.lines_added;
    row.lines_removed += stat.lines_removed ?? 0;
    totals.set(stat.vendor, row);
  }
  return [...totals.values()].sort((a, b) => ORDER.indexOf(a.vendor) - ORDER.indexOf(b.vendor));
}

/**
 * The report from tracked landings: lines by agent and model, by person and by module, with
 * each group's revert and rework counts. Pure: the same landings give the same report.
 */
export function provenanceReport(input: ReportInput): ProvenanceReport {
  const agents = new Map<string, Tally>();
  const people: People = new Map();
  const modules = new Map<
    string,
    {
      lines: number;
      agent: { lines: number; reverted: number; reworked: number };
      agents: Map<string, Tally>;
    }
  >();
  const landed = new Set<string>();
  let lines = 0;
  let landings = 0;

  for (const tracked of input.landings) {
    const id = tracked.landing.commits[0]?.sha ?? "";
    if (tracked.lines.length > 0) landings++;
    for (const commit of tracked.landing.commits) landed.add(commit.sha.toLowerCase());
    for (const line of tracked.lines) {
      const author = input.author(line.origin, tracked);
      const key = keyOf(author.agent);
      lines++;

      const row = bump(agents, key, author.agent);
      row.lines++;
      row.landings.add(id);
      if (author.agent && author.sessionId) row.runs.add(author.sessionId);
      if (line.fate === "reverted") row.reverted++;
      if (line.fate === "reworked") row.reworked++;
      if (tracked.open) row.open++;

      const person = people.get(author.person) ?? { lines: 0, agents: new Map() };
      person.lines++;
      bump(person.agents, key, author.agent).lines++;
      people.set(author.person, person);

      const module = modules.get(line.module) ?? {
        lines: 0,
        agent: { lines: 0, reverted: 0, reworked: 0 },
        agents: new Map(),
      };
      module.lines++;
      const inModule = bump(module.agents, key, author.agent);
      inModule.lines++;
      if (line.fate === "reverted") inModule.reverted++;
      if (line.fate === "reworked") inModule.reworked++;
      if (author.agent) {
        module.agent.lines++;
        if (line.fate === "reverted") module.agent.reverted++;
        if (line.fate === "reworked") module.agent.reworked++;
      }
      modules.set(line.module, module);
    }
  }

  const byAgent = [...agents.values()]
    .map(
      (row): ProvenanceAgentRow => ({
        vendor: row.vendor,
        model: row.model,
        lines: row.lines,
        share: share(row.lines, lines),
        landings: row.landings.size,
        runs: row.runs.size,
        reverted_lines: row.reverted,
        reworked_lines: row.reworked,
        open_lines: row.open,
        revert_rate: rate(row.reverted, row.lines),
        rework_rate: rate(row.reworked, row.lines),
        revert_rework_rate: rate(row.reverted + row.reworked, row.lines),
      }),
    )
    .sort(compareAgents);

  const byPerson = personRows(people);

  const { threshold } = input.settings;
  const moduleRows = [...modules.entries()]
    .map(([module, entry]): Omit<ProvenanceModuleRow, "rank"> => {
      const agentRate = rate(entry.agent.reverted + entry.agent.reworked, entry.agent.lines);
      return {
        module,
        lines: entry.lines,
        agent_lines: entry.agent.lines,
        agent_share: share(entry.agent.lines, entry.lines),
        agent_reverted_lines: entry.agent.reverted,
        agent_reworked_lines: entry.agent.reworked,
        agent_revert_rework_rate: agentRate,
        above_threshold:
          entry.agent.lines >= MIN_MODULE_LINES && agentRate !== null && agentRate > threshold,
        by_agent: [...entry.agents.values()]
          .map((row) => ({
            vendor: row.vendor,
            model: row.model,
            lines: row.lines,
            revert_rework_rate: rate(row.reverted + row.reworked, row.lines),
          }))
          .sort(byLines),
      };
    })
    .sort(
      (a, b) =>
        b.agent_lines - a.agent_lines || b.lines - a.lines || a.module.localeCompare(b.module),
    )
    .map((row, index): ProvenanceModuleRow => ({ ...row, rank: index + 1 }));

  const agentRows = byAgent.filter((row) => row.vendor !== "unattributed");
  const agentLines = agentRows.reduce((sum, row) => sum + row.lines, 0);
  const agentReverted = agentRows.reduce((sum, row) => sum + (row.reverted_lines ?? 0), 0);
  const agentReworked = agentRows.reduce((sum, row) => sum + (row.reworked_lines ?? 0), 0);

  return {
    schema: PROVENANCE_SCHEMA,
    repo: input.repo,
    status: "computed",
    note: null,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    branch: input.branch,
    head: input.head,
    window_days: input.settings.windowDays,
    threshold,
    min_module_lines: MIN_MODULE_LINES,
    totals: {
      lines,
      agent_lines: agentLines,
      agent_share: share(agentLines, lines),
      landings,
      agent_reverted_lines: agentReverted,
      agent_reworked_lines: agentReworked,
      agent_revert_rework_rate: rate(agentReverted + agentReworked, agentLines),
    },
    by_agent: byAgent,
    by_person: byPerson,
    modules: moduleRows,
    vendor_reported: vendorReported(input.vendorStats, input.from, input.to, landed),
  };
}

const isVendor = (value: unknown): value is AgentRef["vendor"] =>
  typeof value === "string" && (AGENT_VENDORS as readonly string[]).includes(value);

/**
 * The report from the ledger alone, for a repository the reader has no clone of: lines added
 * by merged pull requests (`pr.merged` events of the repo), by agent, model and person, and the
 * agent sessions whose recorded commits are on them. No modules and no revert or rework rate:
 * those need the git history. `note` says why.
 */
export function ledgerOnlyReport(input: {
  repo: string;
  from: Date;
  to: Date;
  settings: ProvenanceSettings;
  events: LedgerEvent[];
  note: string;
}): ProvenanceReport {
  const repo = input.repo.toLowerCase();
  const inRepo = (event: LedgerEvent) => event.repo?.toLowerCase() === repo;
  const merged = new Map<string, LedgerEvent>();
  for (const event of input.events) {
    if (event.kind !== "pr.merged" || !inRepo(event)) continue;
    const at = Date.parse(event.ts);
    if (at < input.from.getTime() || at >= input.to.getTime()) continue;
    const url = event.links?.pr_url ?? event.id;
    if (!merged.has(url)) merged.set(url, event);
  }
  const sessions = new Map<string, Set<string>>();
  for (const event of input.events) {
    const url = event.links?.pr_url;
    if (event.kind !== "commit.created" || !url || !event.session_id) continue;
    const set = sessions.get(url) ?? new Set();
    set.add(event.session_id);
    sessions.set(url, set);
  }

  const agents = new Map<string, Tally>();
  const people: People = new Map();
  let lines = 0;
  for (const [url, event] of merged) {
    const added = typeof event.data?.additions === "number" ? event.data.additions : 0;
    const vendor = event.agent?.vendor;
    const agent: AgentRef | undefined = isVendor(vendor)
      ? { vendor, ...(event.model ? { model: event.model } : {}) }
      : undefined;
    const key = keyOf(agent);
    const row = bump(agents, key, agent);
    row.lines += added;
    row.landings.add(url);
    if (agent) for (const session of sessions.get(url) ?? []) row.runs.add(session);
    lines += added;
    const person = event.actor?.kind === "person" ? event.actor.id : "unknown";
    const entry = people.get(person) ?? { lines: 0, agents: new Map() };
    entry.lines += added;
    bump(entry.agents, key, agent).lines += added;
    people.set(person, entry);
  }

  const byAgent = [...agents.values()]
    .map(
      (row): ProvenanceAgentRow => ({
        vendor: row.vendor,
        model: row.model,
        lines: row.lines,
        share: share(row.lines, lines),
        landings: row.landings.size,
        runs: row.runs.size,
        reverted_lines: null,
        reworked_lines: null,
        open_lines: null,
        revert_rate: null,
        rework_rate: null,
        revert_rework_rate: null,
      }),
    )
    .sort(compareAgents);
  const agentLines = byAgent
    .filter((row) => row.vendor !== "unattributed")
    .reduce((sum, row) => sum + row.lines, 0);

  return {
    schema: PROVENANCE_SCHEMA,
    repo: input.repo,
    status: "ledger_only",
    note: input.note,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    branch: null,
    head: null,
    window_days: input.settings.windowDays,
    threshold: input.settings.threshold,
    min_module_lines: MIN_MODULE_LINES,
    totals: {
      lines,
      agent_lines: agentLines,
      agent_share: share(agentLines, lines),
      landings: merged.size,
      agent_reverted_lines: null,
      agent_reworked_lines: null,
      agent_revert_rework_rate: null,
    },
    by_agent: byAgent,
    by_person: personRows(people),
    modules: [],
    vendor_reported: [],
  };
}
