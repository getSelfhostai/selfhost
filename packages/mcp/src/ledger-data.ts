import { randomBytes } from "node:crypto";
import { fileCalls, type Ledger, LedgerQueryError, LedgerValidationError } from "@selfhost/ledger";
import {
  AlreadyAnsweredError,
  decisionRefusal,
  defaultConfig,
  MCP_EXCEPTION_REQUEST,
  MCP_QUESTION_REQUEST,
  openReviewList,
  ReviewInputError,
  ReviewItemNotFoundError,
  type ReviewList,
  refreshReviewList,
} from "@selfhost/review";
import {
  EVENT_SCHEMA,
  type EventSource,
  type LedgerEvent,
  type ResolvedSelfhostConfig,
  type ReviewItem,
  type ReviewItemKind,
} from "@selfhost/schema";
import type { CallContext, McpData } from "./data.js";
import { itemOutOfReach, McpToolError, notInTeam } from "./errors.js";

/**
 * Kinds of item an agent waits on, that guard a rule, that change what every agent of the team
 * loads, or that warn about spend and runs (budget and alert items): a person answers them, never
 * the agent itself through record_decision.
 */
export const GATING_KINDS: readonly ReviewItemKind[] = [
  "approval",
  "question",
  "exception",
  "blocked_action",
  "context_promotion",
  "budget",
  "spend_spike",
  "stuck_run",
  "quality",
];

/** "an exception", "a budget": the kind as words, with its article. */
const kindWords = (kind: ReviewItemKind) => {
  const words = kind.replaceAll("_", " ");
  return `${/^[aeiou]/.test(words) ? "an" : "a"} ${words}`;
};

export interface LedgerDataOptions {
  /** Runs `fn` with the ledger open: the server's, or this machine's opened for the call. */
  use<T>(fn: (ledger: Ledger) => Promise<T>): Promise<T>;
  person: string;
  /**
   * On a team server, the teams the person token reads, its own first: every read and write is
   * limited to them. Undefined for one machine's ledger, where everything is the person's.
   */
  teams?: () => Promise<string[]>;
  /** selfhost.toml for items whose events have no team policy. */
  config?: ResolvedSelfhostConfig;
  now: () => Date;
  /** source of the events the write tools record. */
  source: EventSource;
  /**
   * Bring the review list up to date before reads. On by default; the team server turns it off,
   * since its refresh job runs every few seconds and the write tools refresh themselves.
   */
  refreshOnRead?: boolean;
  /** Runs before an exception request reads the list: brings this machine's blocks in. */
  beforeException?: (ledger: Ledger, id: string) => Promise<void>;
}

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A new UUIDv7 for an event or an item. */
export function uuidv7(now: Date): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Math.min(Math.max(now.getTime(), 0), 2 ** 48 - 1), 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Ledger and review list errors as tool errors; anything else is a bug and goes on. */
function translated(error: unknown): unknown {
  if (
    error instanceof LedgerQueryError ||
    error instanceof LedgerValidationError ||
    error instanceof ReviewInputError
  ) {
    return new McpToolError("invalid_request", error.message);
  }
  if (error instanceof AlreadyAnsweredError) {
    return new McpToolError("not_open", `This item is ${error.item.state}, not open.`);
  }
  if (error instanceof ReviewItemNotFoundError) return new McpToolError("not_found", error.message);
  return error;
}

/**
 * Everything but the policy and the budget, over a ledger: the review list, events, decisions,
 * file activity and the write tools. The CLI and the team server share it; they differ in the
 * ledger they hand over and in `teams`.
 */
export function ledgerData(options: LedgerDataOptions): Omit<McpData, "policy" | "budget"> {
  const { person, now, source } = options;
  const refreshOnRead = options.refreshOnRead ?? true;

  const listFor = (ledger: Ledger, team: string | undefined): ReviewList =>
    openReviewList(ledger, {
      now,
      ...(options.config ? { config: options.config } : {}),
      ...(team !== undefined ? { team } : {}),
    });

  /** The teams a query may read: the one it names, if the person is in it, else all of theirs. */
  async function teamsFor(team: string | undefined): Promise<string[] | undefined> {
    if (!options.teams) return undefined;
    const teams = await options.teams();
    if (team === undefined) return teams;
    if (!teams.includes(team)) throw notInTeam(team);
    return [team];
  }

  /** One team for a query that reads a single team: the one named, else the person's own. */
  async function oneTeam(team: string | undefined): Promise<string | undefined> {
    const teams = await teamsFor(team);
    return teams?.[0];
  }

  async function run<T>(fn: (ledger: Ledger) => Promise<T>): Promise<T> {
    try {
      return await options.use(fn);
    } catch (error) {
      throw translated(error);
    }
  }

  async function refresh(ledger: Ledger): Promise<void> {
    await refreshReviewList(ledger, listFor(ledger, undefined));
  }

  /** The item and the team list it is in, or forbidden (team server) or not_found. */
  async function find(
    ledger: Ledger,
    id: string,
  ): Promise<{ item: ReviewItem; list: ReviewList; team?: string }> {
    if (!UUIDV7.test(id)) throw new McpToolError("invalid_request", "item_id: Expected a UUIDv7");
    const teams = options.teams ? await options.teams() : [undefined];
    for (const team of teams) {
      const list = listFor(ledger, team);
      const item = await list.get(id);
      if (item) return { item, list, ...(team !== undefined ? { team } : {}) };
    }
    if (options.teams) throw itemOutOfReach(id);
    throw new McpToolError("not_found", `No review item ${id}.`);
  }

  async function record(ledger: Ledger, event: LedgerEvent, team: string | undefined) {
    await ledger.append([event], team !== undefined ? { team } : {});
    await refresh(ledger);
  }

  const request = (
    data: Record<string, unknown>,
    context: CallContext,
    itemId: string,
    repo?: string,
  ): LedgerEvent => {
    const at = now();
    return {
      id: uuidv7(at),
      schema: EVENT_SCHEMA,
      ts: at.toISOString(),
      source,
      kind: "approval.requested",
      actor: { kind: "person", id: person },
      ...(context.agent ? { agent: context.agent } : {}),
      ...(repo ? { repo } : {}),
      links: { item_id: itemId },
      data,
    };
  };

  return {
    person,

    reviewItems: (query) =>
      run(async (ledger) => {
        if (refreshOnRead) await refresh(ledger);
        const team = await oneTeam(query.team);
        const { team: _team, ...rest } = query;
        return listFor(ledger, team).list(rest);
      }),

    events: (query) =>
      run(async (ledger) => {
        const team = options.teams ? await oneTeam(query.team) : query.team;
        const page = await ledger.query({ ...query, ...(team !== undefined ? { team } : {}) });
        return { events: page.events, next_cursor: page.nextCursor ?? null };
      }),

    decisions: (query) =>
      run(async (ledger) => {
        const teams = await teamsFor(query.team);
        const { team: _team, ...rest } = query;
        const page = await ledger.decisions.search(
          options.teams ? rest : query,
          teams ? { teams } : {},
        );
        return { decisions: page.events, next_cursor: page.nextCursor ?? null };
      }),

    fileCalls: (query) =>
      run(async (ledger) => {
        const teams = await teamsFor(query.team);
        return fileCalls(ledger, {
          path: query.path,
          limit: query.limit,
          ...(teams ? { teams } : {}),
          ...(query.repo ? { repo: query.repo } : {}),
          ...(query.from ? { from: query.from } : {}),
        });
      }),

    item: (id) =>
      run(async (ledger) => {
        if (refreshOnRead) await refresh(ledger);
        return (await find(ledger, id)).item;
      }),

    ask: (input, context) =>
      run(async (ledger) => {
        const own = await oneTeam(undefined);
        const id = uuidv7(now());
        const brief = input.context?.trim();
        const event = request(
          {
            request: MCP_QUESTION_REQUEST,
            question: input.question,
            ...(brief ? { context: brief } : {}),
            ...(input.paths?.length ? { paths: input.paths } : {}),
          },
          context,
          id,
          input.repo,
        );
        await record(ledger, event, own);
        return (await find(ledger, id)).item;
      }),

    requestException: (input, context) =>
      run(async (ledger) => {
        const id = input.exception_id.toLowerCase();
        await options.beforeException?.(ledger, id);
        await refresh(ledger);
        const found = await find(ledger, id);
        if (found.item.kind !== "exception") {
          throw new McpToolError(
            "invalid_request",
            `Review item ${id} is a ${found.item.kind}, not an exception request.`,
          );
        }
        if (found.item.state !== "open") return found.item;
        const event = request(
          { request: MCP_EXCEPTION_REQUEST, reason: input.reason },
          context,
          id,
          found.item.repo,
        );
        await record(ledger, event, found.team);
        return (await find(ledger, id)).item;
      }),

    decide: (input) =>
      run(async (ledger) => {
        if (refreshOnRead) await refresh(ledger);
        const { item, list, team } = await find(ledger, input.item_id);
        if (GATING_KINDS.includes(item.kind)) {
          throw new McpToolError(
            "forbidden",
            `An agent cannot answer ${kindWords(item.kind)} item: a person answers it in selfhost inbox, the console or chat.`,
          );
        }
        // On a team server, the same rule as every other path an answer takes.
        if (team !== undefined) {
          const role = (await ledger.teams.getPerson(team, person))?.role;
          const refusal = decisionRefusal(
            item,
            team,
            input.verdict,
            { by: person, ...(role ? { role } : {}) },
            options.config ?? defaultConfig(),
          );
          if (refusal !== undefined) throw new McpToolError("forbidden", refusal);
        }
        return list.decide(item.id, {
          verdict: input.verdict,
          by: person,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          surface: "mcp",
        });
      }),
  };
}
