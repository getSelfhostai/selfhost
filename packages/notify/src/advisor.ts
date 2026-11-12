import { databaseOf, type Ledger } from "@selfhost/ledger";
import { countedHits, observedRules } from "@selfhost/review";
import {
  ADVISOR_DAYS,
  ADVISOR_MAX_RECOMMENDATIONS,
  ADVISOR_SCHEMA,
  type AdvisorAction,
  type AdvisorBillingRow,
  type AdvisorOverlap,
  type AdvisorRecommendation,
  type AdvisorReport,
  type AdvisorRevert,
  type AdvisorRuleRow,
  type AdvisorShippedRow,
  type AdvisorSignal,
  type AdvisorSpendRow,
  type AdvisorWork,
  type AgentVendor,
  EDIT_OVERLAP_ALERT,
  type LedgerEvent,
} from "@selfhost/schema";
import {
  breakEven,
  cacheStats,
  isVendorRollup,
  oneSourcePerSession,
  prUrlOf,
  sandboxWaste,
} from "@selfhost/spend";
import type { Message } from "./apprise.js";
import { clean, itemLink, listLink, plainId } from "./message.js";

/**
 * The weekly agent advisor (F58): what a team's agents did in a week and what to change, from
 * the events and review items already in the ledger. readAdvisorData reads them, advisorReport
 * turns them into the report by fixed rules, and advisorLines writes the text the note and
 * `selfhost advisor` show. Nothing here calls a model.
 */

const DAY_MS = 86_400_000;
const PAGE = 1000;
/** How far back a learned risk signal still waiting for a person is looked for. */
export const ADVISOR_SIGNAL_DAYS = 30;
/** A rule that stopped one person's agents this often in a week is worth a look. */
export const REPEATED_BLOCKS = 3;
/** A recording-only rule with this many hits and no likely false positives can start enforcing. */
export const ENFORCE_HITS = 3;
/** Smallest monthly saving a recommendation is made for. */
export const MIN_SAVING_USD = 20;
/** Rows a list of the report keeps. */
const ROWS = 10;

/** The event kinds the advisor reads for the week. */
export const ADVISOR_KINDS = [
  "cost.recorded",
  "pr.opened",
  "pr.merged",
  "pr.reverted",
  "pr.reworked",
  "policy.evaluated",
  "alert.raised",
  "session.started",
  "session.ended",
  "sandbox.started",
  "sandbox.stopped",
] as const;

/** A review item the advisor reads: an exception request, or a learned signal's item. */
export interface AdvisorItem {
  id: string;
  kind: string;
  state: string;
  verdict: string | null;
  session_id: string | null;
  created_at: string;
}

/** Everything one report is built from. */
export interface AdvisorData {
  /** Events of ADVISOR_KINDS in the week. */
  events: LedgerEvent[];
  /** risk.learned events of the last ADVISOR_SIGNAL_DAYS, newest first. */
  signals: LedgerEvent[];
  /** Exception requests made in the week, and the items of the signals. */
  items: AdvisorItem[];
  /** Who asked for each grant a laptop reported used in the week. */
  grantsUsed: string[];
}

/** Whose report it is: the teams read (null: every team), and the person of a self report. */
export interface AdvisorReader {
  teams: string[] | null;
  /** Set for a member's report about their own work. */
  person?: string;
}

const iso = (value: unknown) => new Date(value as string | Date).toISOString();

async function eventsOf(
  ledger: Ledger,
  kind: string,
  teams: string[] | null,
  from: Date,
  to: Date,
): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  for (const team of teams ?? [undefined]) {
    let cursor: string | undefined;
    do {
      const page = await ledger.query({
        kind,
        ...(team ? { team } : {}),
        from: from.toISOString(),
        to: to.toISOString(),
        limit: PAGE,
        cursor,
      });
      out.push(...page.events);
      cursor = page.nextCursor;
    } while (cursor);
  }
  return out;
}

/** Reads the week before `to` for the teams given; null reads every team and no team. */
export async function readAdvisorData(
  ledger: Ledger,
  range: { from: Date; to: Date; teams: string[] | null },
): Promise<AdvisorData> {
  const { from, to, teams } = range;
  const events: LedgerEvent[] = [];
  for (const kind of ADVISOR_KINDS) events.push(...(await eventsOf(ledger, kind, teams, from, to)));
  const signalFrom = new Date(to.getTime() - ADVISOR_SIGNAL_DAYS * DAY_MS);
  const signals = (await eventsOf(ledger, "risk.learned", teams, signalFrom, to)).sort(
    (a, b) => Date.parse(b.ts) - Date.parse(a.ts) || (a.id < b.id ? 1 : -1),
  );
  const db = databaseOf(ledger);
  // null reads every team; the parameter is always sent so its type is known.
  const teamList = teams === null ? null : JSON.stringify(teams);
  const inTeams = (param: string) =>
    `(${param}::text IS NULL OR team IN (SELECT jsonb_array_elements_text(coalesce(${param}::text, '[]')::jsonb)))`;
  const itemIds = signals.flatMap((event) =>
    typeof event.links?.item_id === "string" ? [event.links.item_id] : [],
  );
  const rows = await db.query<{
    id: string;
    kind: string;
    state: string;
    verdict: string | null;
    session_id: string | null;
    created_at: unknown;
  }>(
    `SELECT id::text AS id, kind, state, body#>>'{answer,verdict}' AS verdict, session_id, created_at
     FROM review_items
     WHERE (kind = 'exception' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
            AND ${inTeams("$3")})
        OR id::text IN (SELECT jsonb_array_elements_text($4::text::jsonb))
     ORDER BY created_at, id`,
    [from.toISOString(), to.toISOString(), teamList, JSON.stringify(itemIds)],
  );
  const grants = await db.query<{ requested_by: string }>(
    `SELECT requested_by FROM exception_grants
     WHERE used_at >= $1::timestamptz AND used_at < $2::timestamptz AND ${inTeams("$3")}`,
    [from.toISOString(), to.toISOString(), teamList],
  );
  return {
    events,
    signals,
    items: rows.map((row) => ({ ...row, created_at: iso(row.created_at) })),
    grantsUsed: grants.map((row) => row.requested_by),
  };
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  a !== null &&
  a !== undefined &&
  b !== null &&
  b !== undefined &&
  a.toLowerCase() === b.toLowerCase();

const round = (usd: number) => Math.round(usd * 100) / 100;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const UNKNOWN = "unknown";

const runOf = (event: LedgerEvent | undefined) => event?.run_id ?? event?.session_id ?? null;

/** Counts of a key, most first, then by key. */
function ranked<T>(map: Map<string, T>, score: (value: T) => number): T[] {
  return [...map.entries()]
    .sort(([ka, a], [kb, b]) => score(b) - score(a) || compareText(ka, kb))
    .map(([, value]) => value);
}

/**
 * The report for a reader, from the week's data. A self report (reader.person set) keeps only the
 * person's own sessions, pull requests, spend and sandboxes, and leaves out learned signals and
 * rule changes, which are the admins' to make.
 */
export function advisorReport(
  data: AdvisorData,
  options: AdvisorReader & { from: Date; to: Date },
): AdvisorReport {
  const self = options.person;
  const events = [...data.events].sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts) || compareText(a.id, b.id),
  );

  // Whose each session is: the person named on any of its events.
  const sessionPerson = new Map<string, string>();
  for (const event of events) {
    if (event.actor.kind === "person" && event.session_id && !sessionPerson.has(event.session_id)) {
      sessionPerson.set(event.session_id, event.actor.id);
    }
  }
  const personOf = (event: LedgerEvent): string | undefined => {
    if (event.actor.kind === "person") return event.actor.id;
    if (event.session_id) return sessionPerson.get(event.session_id);
    const owner = event.data?.owner;
    return typeof owner === "string" && owner !== "" ? owner : undefined;
  };
  const mine = (event: LedgerEvent) => self === undefined || same(personOf(event), self);
  const ownSessions = new Set(
    [...sessionPerson]
      .filter(([, person]) => self === undefined || same(person, self))
      .map(([s]) => s),
  );
  const of = (kind: string) => events.filter((event) => event.kind === kind && mine(event));

  // What shipped: agent pull requests opened and merged, each once.
  const shippedBy = new Map<string, AdvisorShippedRow>();
  const counted = { opened: new Set<string>(), merged: new Set<string>() };
  for (const event of [...of("pr.opened"), ...of("pr.merged")]) {
    const url = prUrlOf(event);
    if (!event.agent || !url) continue;
    const which = event.kind === "pr.opened" ? counted.opened : counted.merged;
    if (which.has(url)) continue;
    which.add(url);
    const person = personOf(event) ?? UNKNOWN;
    const key = `${person}\n${event.agent.vendor}`;
    const row = shippedBy.get(key) ?? { person, agent: event.agent.vendor, opened: 0, merged: 0 };
    if (event.kind === "pr.opened") row.opened += 1;
    else row.merged += 1;
    shippedBy.set(key, row);
  }

  // What got blocked: enforced and recorded rule hits, and one-time exceptions.
  const policy = of("policy.evaluated");
  const rules = new Map<
    string,
    AdvisorRuleRow & { people: Map<string, number>; first?: LedgerEvent }
  >();
  const ruleRow = (id: string) => {
    let row = rules.get(id);
    if (!row) {
      row = {
        rule_id: id,
        blocked: 0,
        asked: 0,
        would_block: 0,
        would_ask: 0,
        likely_false_positives: 0,
        top_person: null,
        top_person_hits: 0,
        run: null,
        people: new Map(),
      };
      rules.set(id, row);
    }
    return row;
  };
  for (const mode of ["enforce", "observe"] as const) {
    for (const hit of countedHits(policy, mode)) {
      const row = ruleRow(hit.rule_id);
      if (mode === "enforce") {
        if (hit.verdict === "ask") row.asked += 1;
        else row.blocked += 1;
        const person = personOf(hit.event);
        if (person) row.people.set(person, (row.people.get(person) ?? 0) + 1);
      } else if (hit.verdict === "ask") row.would_ask += 1;
      else row.would_block += 1;
      row.first ??= hit.event;
    }
  }
  for (const observed of observedRules(policy)) {
    ruleRow(observed.rule_id).likely_false_positives = observed.likely_false_positives;
  }
  const ruleRows: AdvisorRuleRow[] = ranked(
    rules,
    (r) => r.blocked + r.asked + r.would_block + r.would_ask,
  ).map(({ people, first, ...row }) => {
    const [top] = ranked(
      new Map([...people].map(([person, hits]) => [person, { person, hits }])),
      (p) => p.hits,
    );
    return {
      ...row,
      top_person: top?.person ?? null,
      top_person_hits: top?.hits ?? 0,
      run: runOf(first),
    };
  });
  const exceptionItems = data.items.filter(
    (item) =>
      item.kind === "exception" &&
      (self === undefined || (item.session_id !== null && ownSessions.has(item.session_id))),
  );
  const approvedVerdict = (verdict: string | null) =>
    verdict === "approve" || verdict === "override";

  // Where money went: spend counted as GET /v1/usage counts it, by person and agent.
  const costs = oneSourcePerSession(events.filter((e) => e.kind === "cost.recorded")).filter(mine);
  const spendBy = new Map<string, AdvisorSpendRow>();
  let usd = 0;
  let vendorUsd = 0;
  for (const event of costs) {
    const amount = event.cost?.usd ?? 0;
    const person = personOf(event) ?? UNKNOWN;
    const agent = event.agent?.vendor ?? UNKNOWN;
    const key = `${person}\n${agent}`;
    const row = spendBy.get(key) ?? { person, agent, usd: 0, vendor_usd: 0 };
    row.usd += amount;
    usd += amount;
    if (isVendorRollup(event)) {
      row.vendor_usd += amount;
      vendorUsd += amount;
    }
    spendBy.set(key, row);
  }
  const spendRows = ranked(spendBy, (row) => row.usd).map((row) => ({
    ...row,
    usd: round(row.usd),
    vendor_usd: round(row.vendor_usd),
  }));
  const days = (options.to.getTime() - options.from.getTime()) / DAY_MS;
  const billing: AdvisorBillingRow[] = breakEven(
    spendRows.filter((row) => row.person !== UNKNOWN && row.usd > 0),
    days > 0 ? days : ADVISOR_DAYS,
  )
    .filter((row) => row.saving_usd >= 1)
    .map((row) => ({
      person: row.person,
      agent: row.agent,
      verdict: row.verdict,
      tier: row.tier,
      monthly_api_usd: row.monthly_api_usd,
      saving_usd: row.saving_usd,
    }));
  const cache = cacheStats(costs);
  const sandboxEvents = events.filter(
    (event) =>
      ((event.kind === "sandbox.started" || event.kind === "sandbox.stopped") && mine(event)) ||
      (event.run_id !== undefined &&
        (event.kind === "cost.recorded" ||
          event.kind === "session.ended" ||
          event.kind === "alert.raised")),
  );
  const [week] = sandboxWaste(sandboxEvents, { now: options.to }).windows;
  const best = week?.by_runtime
    .flatMap((row) => (row.suggestion ? [row.suggestion] : []))
    .sort((a, b) => b.monthly_saving_usd - a.monthly_saving_usd)[0];
  const sandbox =
    week && (week.billed_usd > 0 || week.by_runtime.length > 0)
      ? {
          billed_usd: week.billed_usd,
          idle_usd: week.idle_usd,
          idle_share: week.idle_share,
          monthly_saving_usd: best?.monthly_saving_usd ?? null,
          suggestion: best?.text ?? null,
        }
      : null;

  // Quality: reverts and reworks found in the week, and learned risk signals.
  const reverts: AdvisorRevert[] = [];
  const outcomeUrls = { revert: new Set<string>(), rework: new Set<string>() };
  for (const event of [...of("pr.reverted"), ...of("pr.reworked")]) {
    const url = prUrlOf(event);
    if (!url) continue;
    const kind = event.kind === "pr.reverted" ? "revert" : "rework";
    if (outcomeUrls[kind].has(url)) continue;
    outcomeUrls[kind].add(url);
    reverts.push({
      kind,
      pr_url: url,
      repo: event.repo ?? null,
      agent: event.agent?.vendor ?? null,
      run: runOf(event),
    });
  }
  const reworkedOnly = [...outcomeUrls.rework].filter((url) => !outcomeUrls.revert.has(url));
  const signals: AdvisorSignal[] = self === undefined ? learnedSignals(data, options.from) : [];

  // Who worked where: agent sessions per person and repository, and files two runs edited at once.
  const sessionRepo = new Map<string, string>();
  for (const event of events) {
    if (event.session_id && event.repo && !sessionRepo.has(event.session_id)) {
      sessionRepo.set(event.session_id, event.repo);
    }
  }
  const work = new Map<string, Map<string, number>>();
  for (const [session, person] of sessionPerson) {
    if (!ownSessions.has(session)) continue;
    const repo = sessionRepo.get(session);
    if (!repo) continue;
    const repos = work.get(person) ?? new Map<string, number>();
    repos.set(repo, (repos.get(repo) ?? 0) + 1);
    work.set(person, repos);
  }
  const workRows: AdvisorWork[] = ranked(
    new Map(
      [...work].map(([person, repos]) => [
        person,
        {
          person,
          repos: ranked(
            new Map([...repos].map(([repo, sessions]) => [repo, { repo, sessions }])),
            (r) => r.sessions,
          ),
        },
      ]),
    ),
    (row) => row.repos.reduce((sum, r) => sum + r.sessions, 0),
  );
  const overlaps = new Map<string, AdvisorOverlap & { sets: Set<string> }>();
  for (const event of events) {
    if (event.kind !== "alert.raised" || event.data?.alert !== EDIT_OVERLAP_ALERT) continue;
    const data = event.data;
    const file = typeof data.file === "string" ? data.file : undefined;
    const repo = event.repo;
    if (!file || !repo) continue;
    const owners = Array.isArray(data.owners)
      ? data.owners.filter((o): o is string => typeof o === "string")
      : [];
    if (self !== undefined && !owners.some((owner) => same(owner, self))) continue;
    const runs = Array.isArray(data.runs)
      ? data.runs.filter((r): r is string => typeof r === "string").sort()
      : [];
    const key = `${repo}\n${file}`;
    const row = overlaps.get(key) ?? {
      repo,
      file,
      owners: [],
      times: 0,
      run: runs[0] ?? null,
      sets: new Set<string>(),
    };
    row.owners = [...new Set([...row.owners, ...owners])].sort();
    row.sets.add(runs.join(","));
    row.times = row.sets.size;
    overlaps.set(key, row);
  }

  const report: AdvisorReport = {
    schema: ADVISOR_SCHEMA,
    from: options.from.toISOString(),
    to: options.to.toISOString(),
    scope: self === undefined ? "team" : "self",
    person: self ?? null,
    teams: options.teams,
    shipped: {
      opened: counted.opened.size,
      merged: counted.merged.size,
      by: ranked(shippedBy, (row) => row.merged * 1000 + row.opened),
    },
    blocked: {
      blocked: ruleRows.reduce((sum, r) => sum + r.blocked, 0),
      asked: ruleRows.reduce((sum, r) => sum + r.asked, 0),
      would_block: ruleRows.reduce((sum, r) => sum + r.would_block, 0),
      would_ask: ruleRows.reduce((sum, r) => sum + r.would_ask, 0),
      rules: ruleRows.slice(0, ROWS),
      exceptions: {
        requested: exceptionItems.length,
        approved: exceptionItems.filter((item) => approvedVerdict(item.verdict)).length,
        denied: exceptionItems.filter((item) => item.verdict === "deny").length,
        used: data.grantsUsed.filter((by) => self === undefined || same(by, self)).length,
      },
    },
    spend: {
      usd: round(usd),
      vendor_usd: round(vendorUsd),
      cache_hit_rate: cache.hit_rate === null ? null : Math.round(cache.hit_rate * 1000) / 1000,
      by: spendRows.slice(0, ROWS),
      billing,
      sandbox,
    },
    quality: {
      merged: counted.merged.size,
      reverted: outcomeUrls.revert.size,
      reworked: reworkedOnly.length,
      reverts: reverts.slice(0, ROWS),
      signals,
    },
    presence: {
      work: workRows.slice(0, ROWS),
      overlaps: ranked(overlaps, (row) => row.times)
        .slice(0, ROWS)
        .map(({ sets: _sets, ...row }) => row),
    },
    recommendations: [],
  };
  report.recommendations = recommend(report);
  return report;
}

/**
 * The newest record of each learned signal (repo, agent, model, module): those recorded in the
 * week, and older ones whose review item still waits for a person.
 */
function learnedSignals(data: AdvisorData, from: Date): AdvisorSignal[] {
  const items = new Map(data.items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const out: AdvisorSignal[] = [];
  for (const event of data.signals) {
    const d = event.data ?? {};
    const module = typeof d.module === "string" ? d.module : undefined;
    const repo = event.repo ?? (event.target?.type === "repo" ? event.target.value : undefined);
    if (!module || !repo || !event.agent) continue;
    const key = `${repo}\n${event.agent.vendor}\n${event.model ?? ""}\n${module}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const itemId = typeof event.links?.item_id === "string" ? event.links.item_id : null;
    const item = itemId ? items.get(itemId) : undefined;
    const state: AdvisorSignal["state"] =
      d.state === "cleared"
        ? "cleared"
        : item?.state === "answered"
          ? item.verdict === "approve" || item.verdict === "override"
            ? "approved"
            : "denied"
          : "open";
    if (Date.parse(event.ts) < from.getTime() && state !== "open") continue;
    const num = (value: unknown) => (typeof value === "number" ? value : 0);
    out.push({
      repo,
      agent: event.agent.vendor,
      model: event.model ?? null,
      module,
      pulls: num(d.pulls),
      reverted: num(d.reverted),
      reworked: num(d.reworked),
      rate: Math.min(1, Math.max(0, num(d.rate))),
      state,
      item_id: itemId,
      suggestion: typeof d.suggestion === "string" ? d.suggestion : null,
    });
  }
  return out;
}

export const AGENT_NAMES: Record<AgentVendor, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  goose: "Goose",
  cursor: "Cursor",
  copilot: "Copilot",
  other: "another agent",
};

const agentName = (agent: string) => AGENT_NAMES[agent as AgentVendor] ?? agent;

const TIER_NAMES: Record<string, string> = {
  pro: "Pro",
  max_5x: "Max 5x",
  max_20x: "Max 20x",
  plus: "Plus",
};

export const dollars = (value: number) =>
  `$${value >= 100 ? Math.round(value).toLocaleString("en-US") : value.toFixed(2)}`;
const percentOf = (share: number) => `${Math.round(share * 100)}%`;

/** Order of the kinds of recommendation: what is risky first, then what saves money. */
const ACTION_ORDER: readonly AdvisorAction[] = [
  "review_learned_signal",
  "check_repeated_blocks",
  "enforce_rule",
  "switch_billing",
  "trim_idle_sandboxes",
];

/**
 * Up to ADVISOR_MAX_RECOMMENDATIONS changes, by fixed rules from the report's numbers: the best
 * of each kind first, in ACTION_ORDER, then the rest. A self report gets only those about the
 * person's own work.
 */
export function recommend(report: AdvisorReport): AdvisorRecommendation[] {
  const team = report.scope === "team";
  const candidates: (AdvisorRecommendation & { weight: number })[] = [];
  const add = (
    rec: Omit<AdvisorRecommendation, "saving_usd" | "item_id" | "run"> &
      Partial<AdvisorRecommendation> & { weight: number },
  ) => candidates.push({ saving_usd: null, item_id: null, run: null, ...rec });

  for (const signal of report.quality.signals) {
    if (signal.state !== "open") continue;
    add({
      action: "review_learned_signal",
      title: `Approve or deny the learned risk signal for ${agentName(signal.agent)} in ${signal.repo} ${signal.module}`,
      why: `${signal.reverted} reverted and ${signal.reworked} reworked of ${signal.pulls} merged pull requests (${percentOf(signal.rate)}). Approved, its pull requests there rank high and wait for a person.`,
      screen: "review",
      item_id: signal.item_id,
      weight: signal.rate * 100 + signal.pulls,
    });
  }
  for (const rule of report.blocked.rules) {
    if (rule.top_person && rule.top_person_hits >= REPEATED_BLOCKS) {
      add({
        action: "check_repeated_blocks",
        title: team
          ? `Ask ${rule.top_person} why their agents keep hitting ${rule.rule_id}`
          : `Change how you brief your agents around ${rule.rule_id}`,
        why: `It stopped ${team ? "their" : "your"} agents ${rule.top_person_hits} times this week. Repeated hits mean the task needs another approach or the rule a narrower match.`,
        screen: "rules",
        run: rule.run,
        weight: rule.top_person_hits,
      });
    }
    const recorded = rule.would_block + rule.would_ask;
    if (
      team &&
      recorded >= ENFORCE_HITS &&
      rule.likely_false_positives === 0 &&
      rule.blocked + rule.asked === 0
    ) {
      add({
        action: "enforce_rule",
        title: `Start enforcing rule ${rule.rule_id}`,
        why: `Recording only, it would have stopped ${recorded} calls this week and none look like false positives. Set mode = "enforce" for it in selfhost.toml.`,
        screen: "rules",
        run: rule.run,
        weight: recorded,
      });
    }
  }
  for (const row of report.spend.billing) {
    if (row.saving_usd < MIN_SAVING_USD) continue;
    const who = team ? `${row.person}'s` : "Your";
    add({
      action: "switch_billing",
      title:
        row.verdict === "seat"
          ? `Put ${team ? row.person : "yourself"} on a ${agentName(row.agent)} ${TIER_NAMES[row.tier ?? ""] ?? row.tier ?? ""} seat if on an API key`
          : `Move ${team ? row.person : "yourself"} to an API key for ${agentName(row.agent)} if on a seat`,
      why: `${who} use is about ${dollars(row.monthly_api_usd)} a month at API rates; the ${row.verdict === "seat" ? "seat" : "API key"} costs about ${dollars(row.saving_usd)} a month less.`,
      saving_usd: row.saving_usd,
      screen: "spend",
      weight: row.saving_usd,
    });
  }
  const sandbox = report.spend.sandbox;
  if (sandbox?.suggestion && (sandbox.monthly_saving_usd ?? 0) >= MIN_SAVING_USD) {
    add({
      action: "trim_idle_sandboxes",
      title: "Cut idle sandbox time on background runs",
      why: `${percentOf(sandbox.idle_share)} of ${dollars(sandbox.billed_usd)} sandbox cost this week was idle. ${sandbox.suggestion}`,
      saving_usd: sandbox.monthly_saving_usd,
      screen: "runs",
      weight: sandbox.monthly_saving_usd ?? 0,
    });
  }

  const order = (a: (typeof candidates)[number], b: (typeof candidates)[number]) =>
    ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action) ||
    b.weight - a.weight ||
    compareText(a.title, b.title);
  const sorted = [...candidates].sort(order);
  const picked: typeof candidates = [];
  for (const action of ACTION_ORDER) {
    const first = sorted.find((c) => c.action === action);
    if (first && picked.length < ADVISOR_MAX_RECOMMENDATIONS) picked.push(first);
  }
  for (const candidate of sorted) {
    if (picked.length >= ADVISOR_MAX_RECOMMENDATIONS) break;
    if (!picked.includes(candidate)) picked.push(candidate);
  }
  return picked.sort(order).map(({ weight: _weight, ...rec }) => rec);
}

/** A week with nothing in it: no note is sent for it. */
export function isQuietWeek(report: AdvisorReport): boolean {
  return (
    report.shipped.opened + report.shipped.merged === 0 &&
    report.blocked.blocked + report.blocked.asked + report.blocked.would_block === 0 &&
    report.blocked.would_ask + report.blocked.exceptions.requested === 0 &&
    report.spend.usd === 0 &&
    report.spend.sandbox === null &&
    report.quality.reverted + report.quality.reworked === 0 &&
    report.quality.signals.length === 0 &&
    report.presence.work.length === 0 &&
    report.recommendations.length === 0
  );
}

const day = (at: string) => at.slice(0, 10);

/** A file path or other name safe to send: masked and clipped, as clean does. */
const safe = (text: string) => clean(text);
/** An id that looks like one (rule, repo), else a stand-in. */
const id = (value: string | null | undefined, fallback: string) =>
  plainId(value ?? undefined) ?? fallback;

function viewLink(consoleUrl: string | undefined, rec: AdvisorRecommendation): string | undefined {
  if (!consoleUrl) return undefined;
  if (rec.item_id) return itemLink(consoleUrl, rec.item_id);
  if (rec.run) {
    return `${consoleUrl.replace(/\/+$/, "")}/?screen=run&run=${encodeURIComponent(rec.run)}`;
  }
  return listLink(consoleUrl, rec.screen);
}

/**
 * The report as text: the note's body and what `selfhost advisor` prints. Names, repositories,
 * rule ids, file paths and amounts only; never a prompt, a command or anything an agent wrote.
 */
export function advisorLines(report: AdvisorReport, consoleUrl?: string): string[] {
  const lines: string[] = [];
  const whose = report.scope === "self" ? "Your agents" : "Agents";
  lines.push(`${whose}, ${day(report.from)} to ${day(report.to)}.`);

  lines.push("", "What to change:");
  if (report.recommendations.length === 0) lines.push("- Nothing this week.");
  report.recommendations.forEach((rec, index) => {
    const saving = rec.saving_usd ? ` Saves about ${dollars(rec.saving_usd)} a month.` : "";
    lines.push(`${index + 1}. ${rec.title}. ${rec.why}${saving}`);
    const link = viewLink(consoleUrl, rec);
    if (link) lines.push(`   ${link}`);
  });

  const { shipped } = report;
  lines.push(
    "",
    `What shipped: ${shipped.opened} agent pull requests opened, ${shipped.merged} merged.`,
  );
  for (const row of shipped.by.slice(0, 5)) {
    lines.push(
      `- ${row.person}, ${agentName(row.agent)}: ${row.merged} merged, ${row.opened} opened`,
    );
  }

  const { blocked } = report;
  const recorded = blocked.would_block + blocked.would_ask;
  lines.push(
    "",
    `What got blocked: ${blocked.blocked} calls blocked, ${blocked.asked} sent to a person${recorded > 0 ? `, ${recorded} more by rules still recording only` : ""}.`,
  );
  for (const rule of blocked.rules.slice(0, 5)) {
    const parts = [
      rule.blocked ? `${rule.blocked} blocked` : undefined,
      rule.asked ? `${rule.asked} asked` : undefined,
      rule.would_block + rule.would_ask
        ? `${rule.would_block + rule.would_ask} recorded`
        : undefined,
      rule.top_person && report.scope === "team"
        ? `most for ${rule.top_person} (${rule.top_person_hits})`
        : undefined,
    ].filter((part) => part !== undefined);
    lines.push(`- ${id(rule.rule_id, "a rule")}: ${parts.join(", ")}`);
  }
  const ex = blocked.exceptions;
  if (ex.requested + ex.used > 0) {
    lines.push(
      `- One-time exceptions: ${ex.requested} asked, ${ex.approved} approved, ${ex.denied} denied, ${ex.used} used`,
    );
  }

  const { spend } = report;
  const cache =
    spend.cache_hit_rate === null ? "" : `, cache hit rate ${percentOf(spend.cache_hit_rate)}`;
  const vendor = spend.vendor_usd > 0 ? ` (${dollars(spend.vendor_usd)} from vendor reports)` : "";
  lines.push("", `Where money went: ${dollars(spend.usd)} on models${vendor}${cache}.`);
  for (const row of spend.by.slice(0, 5)) {
    lines.push(`- ${row.person}, ${agentName(row.agent)}: ${dollars(row.usd)}`);
  }
  if (spend.sandbox) {
    lines.push(
      `- Sandboxes: ${dollars(spend.sandbox.billed_usd)}, of which ${dollars(spend.sandbox.idle_usd)} idle (${percentOf(spend.sandbox.idle_share)})`,
    );
  }

  const { quality } = report;
  lines.push(
    "",
    `Quality: ${quality.reverted} reverted and ${quality.reworked} reworked agent pull requests found, ${quality.merged} merged.`,
  );
  for (const signal of quality.signals.slice(0, 3)) {
    lines.push(
      `- Learned signal (${signal.state}): ${agentName(signal.agent)} in ${id(signal.repo, "a repo")} ${safe(signal.module)}, ${percentOf(signal.rate)} of ${signal.pulls} reverted or reworked`,
    );
  }

  const { presence } = report;
  if (presence.work.length + presence.overlaps.length > 0) {
    lines.push("", "Who worked where:");
    for (const row of presence.work.slice(0, 5)) {
      const repos = row.repos
        .slice(0, 3)
        .map((r) => `${id(r.repo, "a repo")} (${r.sessions})`)
        .join(", ");
      lines.push(`- ${row.person}: ${repos}`);
    }
    for (const overlap of presence.overlaps.slice(0, 3)) {
      lines.push(
        `- Overlap: ${id(overlap.repo, "a repo")} ${safe(overlap.file)} edited at once by ${overlap.owners.join(", ") || "two runs"}`,
      );
    }
  }
  return lines;
}

/** The weekly note. */
export function advisorMessage(report: AdvisorReport, consoleUrl: string | undefined): Message {
  const link = listLink(consoleUrl, "overview");
  const count = report.recommendations.length;
  return {
    title:
      count > 0
        ? `selfhost: your week with agents, ${count} ${count === 1 ? "change" : "changes"} to make`
        : "selfhost: your week with agents",
    body: [
      ...advisorLines(report, consoleUrl),
      "",
      link ? `This week in the console: ${link}` : "See it again with selfhost advisor.",
    ].join("\n"),
    type: "info",
  };
}
