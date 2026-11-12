import {
  type ActiveOnFileQuery,
  ActiveOnFileQuerySchema,
  type ActiveOnFileResponse,
  AskHumanInputSchema,
  BudgetQuerySchema,
  createValidator,
  type FileRun,
  type FileRunsQuery,
  FileRunsQuerySchema,
  type FileRunsResponse,
  GetAnswerInputSchema,
  type LedgerEvent,
  MCP_ACTIVE_MINUTES_DEFAULT,
  MCP_LIMIT_DEFAULT,
  MCP_RESPONSE_TOKEN_BUDGET,
  McpDecisionQuerySchema,
  McpEventQuerySchema,
  type McpItemStatus,
  McpPolicyQuerySchema,
  McpReviewItemQuerySchema,
  type PolicyResponse,
  PresenceQuerySchema,
  RecordDecisionInputSchema,
  RequestExceptionInputSchema,
  type ReviewItem,
  type ReviewItemsPage,
} from "@selfhost/schema";
import type { TSchema } from "@sinclair/typebox";
import type { CallContext, McpData } from "./data.js";
import { McpToolError } from "./errors.js";

export interface ToolDeps {
  data: McpData;
  context: CallContext;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

/** Calls whose file activity is read at most, for list_file_runs and list_active_on_file. */
const FILE_CALLS_READ = 1000;
/** Sessions list_active_on_file returns at most. */
const ACTIVE_SESSIONS_MAX = 20;
/** Source event ids a compact review item keeps. */
const SOURCE_IDS_KEPT = 5;
/** How often get_answer looks again while it waits. */
const POLL_MS = 2000;

/** A cheap upper bound on tokens: JSON runs about 3 to 4 characters a token. */
export const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 3);

/**
 * Reads a page, then smaller ones until it fits the token budget, so a page of large items comes
 * back shorter with next_cursor rather than over the budget.
 */
async function fit<T>(limit: number, read: (limit: number) => Promise<T>): Promise<T> {
  let page = await read(limit);
  while (limit > 1 && estimateTokens(page) > MCP_RESPONSE_TOKEN_BUDGET) {
    limit = Math.max(1, Math.floor(limit / 2));
    page = await read(limit);
  }
  return page;
}

function parse<T extends TSchema>(schema: T, args: unknown) {
  const result = createValidator(schema).validate(args ?? {});
  if (result.ok) return result.value;
  const [first] = result.errors;
  throw new McpToolError("invalid_request", `${first?.field || "input"}: ${first?.message}`);
}

/** The policy without the text and config.rules, which effective_rules already holds. */
export function compactPolicy(policy: PolicyResponse): PolicyResponse {
  const { text: _text, ...rest } = policy;
  const { rules: _rules, ...config } = policy.config;
  return { ...rest, config };
}

function compactItems(page: ReviewItemsPage): ReviewItemsPage {
  return {
    ...page,
    items: page.items.map(({ brief: _brief, ...item }) => ({
      ...item,
      source_event_ids: item.source_event_ids.slice(-SOURCE_IDS_KEPT),
    })),
  };
}

const personOf = (event: LedgerEvent) => event.actor.id;

/** Distinct values, most frequent first. */
function ranked(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
}

interface Group {
  key: string;
  events: LedgerEvent[];
}

/** Calls grouped by run: session, else run id, else the call itself. Newest group first. */
function groups(events: LedgerEvent[], keyOf: (event: LedgerEvent) => string): Group[] {
  const byKey = new Map<string, LedgerEvent[]>();
  for (const event of events) {
    const key = keyOf(event);
    byKey.set(key, [...(byKey.get(key) ?? []), event]);
  }
  return [...byKey].map(([key, list]) => ({ key, events: list }));
}

const runKey = (event: LedgerEvent) =>
  event.session_id ? `s:${event.session_id}` : event.run_id ? `r:${event.run_id}` : `e:${event.id}`;

function fileRun(group: Group): FileRun {
  // Calls come newest first.
  const [newest, ...rest] = group.events as [LedgerEvent, ...LedgerEvent[]];
  const oldest = rest.at(-1) ?? newest;
  const withAgent = group.events.find((event) => event.agent);
  const withRepo = group.events.find((event) => event.repo);
  return {
    ...(newest.session_id ? { session_id: newest.session_id } : {}),
    ...(newest.run_id ? { run_id: newest.run_id } : {}),
    person: personOf(newest),
    ...(withAgent?.agent ? { agent: withAgent.agent } : {}),
    ...(withRepo?.repo ? { repo: withRepo.repo } : {}),
    first_at: oldest.ts,
    last_at: newest.ts,
    calls: group.events.length,
    tools: ranked(group.events.flatMap((event) => (event.tool ? [event.tool.name] : []))),
  };
}

async function fileRuns(deps: ToolDeps, query: FileRunsQuery): Promise<FileRunsResponse> {
  const limit = query.limit ?? MCP_LIMIT_DEFAULT;
  const calls = await deps.data.fileCalls({
    path: query.path,
    limit: FILE_CALLS_READ,
    ...(query.repo ? { repo: query.repo } : {}),
    ...(query.team ? { team: query.team } : {}),
    ...(query.since ? { from: query.since } : {}),
  });
  const all = groups(calls, runKey).map(fileRun);
  const response = (count: number): FileRunsResponse => ({
    path: query.path,
    runs: all.slice(0, count),
    more: all.length > count || calls.length >= FILE_CALLS_READ,
  });
  return fit(limit, async (count) => response(count));
}

async function activeOnFile(
  deps: ToolDeps,
  query: ActiveOnFileQuery,
): Promise<ActiveOnFileResponse> {
  const minutes = query.within_minutes ?? MCP_ACTIVE_MINUTES_DEFAULT;
  const since = new Date(deps.now().getTime() - minutes * 60_000).toISOString();
  const calls = await deps.data.fileCalls({
    path: query.path,
    limit: FILE_CALLS_READ,
    from: since,
    ...(query.repo ? { repo: query.repo } : {}),
    ...(query.team ? { team: query.team } : {}),
  });
  const me = deps.data.person.toLowerCase();
  const sessions = groups(calls, (event) => `${personOf(event)}\n${runKey(event)}`)
    .slice(0, ACTIVE_SESSIONS_MAX)
    .map((group) => {
      const run = fileRun(group);
      return {
        person: run.person,
        you: run.person.toLowerCase() === me,
        ...(run.agent ? { agent: run.agent } : {}),
        ...(run.session_id ? { session_id: run.session_id } : {}),
        ...(run.repo ? { repo: run.repo } : {}),
        last_at: run.last_at,
        calls: run.calls,
        tools: run.tools,
      };
    });
  return { path: query.path, since, sessions };
}

/** What an agent should do next, given the item's state. */
function nextStep(item: ReviewItem, granted: boolean): string {
  const answer = item.answer;
  const exception = item.kind === "exception";
  if (item.state === "open") {
    return "Nobody has answered yet. Call get_answer with this item_id and wait_seconds to wait for the answer; meanwhile take other work that does not depend on it.";
  }
  if (item.state === "answered" && answer) {
    const approved = answer.verdict === "approve" || answer.verdict === "override";
    if (exception && approved) {
      return granted
        ? "Approved. Make the identical call again now: it is allowed once."
        : "Approved. The one-time grant reaches the machine that made the blocked call on its next selfhost sync (selfhost import or selfhost inbox); then make the identical call again.";
    }
    if (answer.verdict === "deny") {
      return exception
        ? "Denied. Do not retry the call or a variant of it; take the alternative the rule gave, or ask the person how to go on."
        : "Denied. Do not go ahead with this; ask the person how to go on if it is unclear.";
    }
    return "Answered. Follow the answer.";
  }
  return item.state === "expired"
    ? "Nobody answered in time, so it timed out. Do not go ahead with it; ask again if it is still needed."
    : "Closed without an answer. Ask again if it is still needed.";
}

async function status(deps: ToolDeps, item: ReviewItem): Promise<McpItemStatus> {
  const answer = item.answer;
  const grant =
    item.kind === "exception" && item.state === "answered" && deps.data.grant
      ? await deps.data.grant(item)
      : undefined;
  return {
    item_id: item.id,
    kind: item.kind,
    state: item.state,
    title: item.title,
    blocking: item.blocking,
    owners: item.owners,
    ...(answer
      ? {
          answer: {
            verdict: answer.verdict,
            by: answer.by,
            ...(answer.reason !== undefined ? { reason: answer.reason } : {}),
            at: answer.at,
          },
        }
      : {}),
    ...(grant ? { grant } : {}),
    next: nextStep(item, grant !== undefined),
  };
}

type Handler = (deps: ToolDeps, args: unknown) => Promise<object>;

const HANDLERS: Record<string, Handler> = {
  get_policy: async ({ data }, args) => {
    const { full, ...query } = parse(McpPolicyQuerySchema, args);
    const policy = await data.policy(query);
    return full ? policy : compactPolicy(policy);
  },

  get_budget: async ({ data }, args) => data.budget(parse(BudgetQuerySchema, args)),

  list_review_items: async ({ data }, args) => {
    const {
      mine = true,
      full = false,
      limit = MCP_LIMIT_DEFAULT,
      ...query
    } = parse(McpReviewItemQuerySchema, args);
    return fit(limit, async (count) => {
      const page = await data.reviewItems({
        ...query,
        limit: count,
        ...(mine ? { for: data.person } : {}),
      });
      return full ? page : compactItems(page);
    });
  },

  search_events: async ({ data }, args) => {
    const { limit = MCP_LIMIT_DEFAULT, ...query } = parse(McpEventQuerySchema, args);
    return fit(limit, (count) => data.events({ ...query, limit: count }));
  },

  search_decisions: async ({ data }, args) => {
    const { limit = MCP_LIMIT_DEFAULT, ...query } = parse(McpDecisionQuerySchema, args);
    return fit(limit, (count) => data.decisions({ ...query, limit: count }));
  },

  list_file_runs: (deps, args) => fileRuns(deps, parse(FileRunsQuerySchema, args)),

  list_active_on_file: (deps, args) => activeOnFile(deps, parse(ActiveOnFileQuerySchema, args)),

  who: async ({ data }, args) => {
    const presence = await data.presence(parse(PresenceQuerySchema, args));
    // A busy team's answer comes back with its newest runs only, overlaps kept, within budget.
    let runs = presence.runs;
    while (runs.length > 1 && estimateTokens({ ...presence, runs }) > MCP_RESPONSE_TOKEN_BUDGET) {
      const kept = new Set(
        [...runs]
          .sort((a, b) => Date.parse(b.last_event_at) - Date.parse(a.last_event_at))
          .slice(0, Math.floor(runs.length / 2))
          .map((run) => run.id),
      );
      runs = runs.filter((run) => kept.has(run.id));
    }
    return { ...presence, runs };
  },

  ask_human: async (deps, args) =>
    status(deps, await deps.data.ask(parse(AskHumanInputSchema, args), deps.context)),

  request_exception: async (deps, args) =>
    status(
      deps,
      await deps.data.requestException(parse(RequestExceptionInputSchema, args), deps.context),
    ),

  get_answer: async (deps, args) => {
    const { item_id, wait_seconds = 0 } = parse(GetAnswerInputSchema, args);
    let item = await deps.data.item(item_id);
    for (let waited = 0; item.state === "open" && waited < wait_seconds * 1000; ) {
      const step = Math.min(POLL_MS, wait_seconds * 1000 - waited);
      await deps.sleep(step);
      waited += step;
      item = await deps.data.item(item_id);
    }
    return status(deps, item);
  },

  record_decision: async ({ data }, args) => data.decide(parse(RecordDecisionInputSchema, args)),
};

/** Runs one tool. Throws McpToolError for an answer the agent should read as an error. */
export async function runTool(name: string, args: unknown, deps: ToolDeps): Promise<object> {
  const handler = HANDLERS[name];
  if (!handler) throw new McpToolError("not_found", `No tool ${name}.`);
  return handler(deps, args);
}

export const TOOL_NAMES = Object.keys(HANDLERS);
