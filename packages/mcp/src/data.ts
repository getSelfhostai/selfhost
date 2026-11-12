import type {
  AgentRef,
  AskHumanInput,
  BudgetQuery,
  BudgetResponse,
  DecisionResponse,
  DecisionsPage,
  EventsPage,
  LedgerEvent,
  McpDecisionQuery,
  McpEventQuery,
  McpPolicyQuery,
  PolicyResponse,
  PresenceQuery,
  PresenceResponse,
  RecordDecisionInput,
  RequestExceptionInput,
  ReviewItem,
  ReviewItemQuery,
  ReviewItemsPage,
} from "@selfhost/schema";

/** Who calls, beyond the person: the agent, from the MCP client's name when it is known. */
export interface CallContext {
  agent?: AgentRef;
}

export interface FileCallsQuery {
  path: string;
  repo?: string;
  team?: string;
  from?: string;
  /** At most this many calls, newest first. */
  limit: number;
}

/**
 * What the tools read and write, scoped to one person. The CLI implements it over this
 * machine's ledger and selfhost.toml; the team server over its ledger and the person token's
 * teams and role. A team, repo or item outside the person's permissions throws McpToolError
 * forbidden and returns no data.
 */
export interface McpData {
  /** The person every call acts as. */
  person: string;
  /** The full policy response; the tool trims it. */
  policy(query: Omit<McpPolicyQuery, "full">): Promise<PolicyResponse>;
  budget(query: BudgetQuery): Promise<BudgetResponse>;
  /** `for` limits the page to the items that person owns or raised. */
  reviewItems(query: ReviewItemQuery & { for?: string }): Promise<ReviewItemsPage>;
  events(query: McpEventQuery): Promise<EventsPage>;
  decisions(query: McpDecisionQuery): Promise<DecisionsPage>;
  /** tool.called events on a file or folder, newest first. */
  fileCalls(query: FileCallsQuery): Promise<LedgerEvent[]>;
  /** Who is working where right now, in the teams the person can read. */
  presence(query: PresenceQuery): Promise<PresenceResponse>;
  /** One item the person can read. */
  item(id: string): Promise<ReviewItem>;
  /** Opens a question item and returns it. */
  ask(input: AskHumanInput, context: CallContext): Promise<ReviewItem>;
  /** Adds the agent's case to the exception item a block named, and returns it. */
  requestException(input: RequestExceptionInput, context: CallContext): Promise<ReviewItem>;
  decide(input: RecordDecisionInput): Promise<DecisionResponse>;
  /**
   * For an approved exception: the one-time grant this machine now holds for it, when the
   * blocked call was made here. Only the CLI has one; the team server never sees the grants.
   */
  grant?(item: ReviewItem): Promise<{ expires_at: string } | undefined>;
}
