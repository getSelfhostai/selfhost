import { type Static, type TObject, type TProperties, Type } from "@sinclair/typebox";
import {
  BudgetQuerySchema,
  BudgetResponseSchema,
  DecisionQuerySchema,
  DecisionResponseSchema,
  DecisionsPageSchema,
  EventQuerySchema,
  EventsPageSchema,
  PolicyQuerySchema,
  PolicyResponseSchema,
  RecordDecisionInputSchema,
  ReviewItemQuerySchema,
  ReviewItemsPageSchema,
} from "./api.js";
import { DateTime, NonEmpty, RepoSlug, StringEnum, Uuidv7 } from "./common.js";
import { AgentRefSchema, VerdictSchema } from "./event.js";
import { PresenceQuerySchema, PresenceResponseSchema } from "./presence.js";
import { REVIEW_ITEM_KINDS, REVIEW_ITEM_STATES } from "./review-item.js";

export const MCP_TOOLS_SCHEMA = "selfhost.mcp_tools/v1";

/** The name agents know the server by, in their MCP config and in tool prefixes. */
export const MCP_SERVER_NAME = "selfhost";

/** Items a list tool returns when the call names no limit, and the most it returns. */
export const MCP_LIMIT_DEFAULT = 10;
export const MCP_LIMIT_MAX = 50;

/**
 * The most a tool answer may cost, in tokens. A page that would go over comes back shorter,
 * with next_cursor to read on; the protocol tests fail if a default answer goes over.
 */
export const MCP_RESPONSE_TOKEN_BUDGET = 6000;

/** get_answer waits at most this long per call, under the tool timeouts agents use (60 s). */
export const MCP_WAIT_MAX_SECONDS = 55;

/** Minutes of activity list_active_on_file looks back by default, and at most. */
export const MCP_ACTIVE_MINUTES_DEFAULT = 120;
export const MCP_ACTIVE_MINUTES_MAX = 24 * 60;

export interface McpToolDefinition {
  name: string;
  description: string;
  /** Reads only: changes nothing in the ledger or the review list. */
  readOnly: boolean;
  inputSchema: TObject;
  outputSchema: TObject;
}

const McpLimit = Type.Integer({
  minimum: 1,
  maximum: MCP_LIMIT_MAX,
  default: MCP_LIMIT_DEFAULT,
  description: `Maximum number of results. Default ${MCP_LIMIT_DEFAULT}.`,
});

/** A paged API query with the MCP limit in place of the API's, and extra fields. */
function mcpQuery<B extends TProperties & { limit: unknown }, T extends TProperties>(
  base: TObject<B>,
  extra: T,
  title: string,
) {
  const { limit: _limit, ...rest } = base.properties;
  return Type.Object(
    { ...(rest as Omit<B, "limit">), limit: Type.Optional(McpLimit), ...extra },
    { additionalProperties: false, title },
  );
}

const Full = (description: string) => Type.Optional(Type.Boolean({ default: false, description }));

export const McpPolicyQuerySchema = Type.Object(
  {
    ...PolicyQuerySchema.properties,
    full: Full(
      "Also return the selfhost.toml text and config.rules. By default both are left out: effective_rules holds the rules after overrides.",
    ),
  },
  { additionalProperties: false, title: "McpPolicyQuery" },
);

export const McpReviewItemQuerySchema = mcpQuery(
  ReviewItemQuerySchema,
  {
    mine: Type.Optional(
      Type.Boolean({
        default: true,
        description:
          "Only items you own or your own sessions raised. false: every item of the team you can read.",
      }),
    ),
    full: Full(
      "Keep each item's brief and every source event id. By default the brief is left out and only the 5 newest source event ids are kept.",
    ),
  },
  "McpReviewItemQuery",
);

export const McpEventQuerySchema = mcpQuery(EventQuerySchema, {}, "McpEventQuery");

export const McpDecisionQuerySchema = mcpQuery(DecisionQuerySchema, {}, "McpDecisionQuery");

const FilePath = NonEmpty({
  maxLength: 1024,
  description:
    "File or folder path relative to the repository root. Matches that file, files under that folder, and the same path seen from a deeper root.",
});

export const FileRunsQuerySchema = Type.Object(
  {
    path: FilePath,
    repo: Type.Optional(RepoSlug({ description: "Only runs in this repository, as owner/name." })),
    team: Type.Optional(
      Type.String({ description: "Team id on a team server. Default: every team you are in." }),
    ),
    since: Type.Optional(DateTime({ description: "Only runs with a call at or after this time." })),
    limit: Type.Optional(McpLimit),
  },
  { additionalProperties: false, title: "FileRunsQuery" },
);

export const ActiveOnFileQuerySchema = Type.Object(
  {
    path: FilePath,
    repo: Type.Optional(RepoSlug({ description: "Only work in this repository, as owner/name." })),
    team: Type.Optional(
      Type.String({ description: "Team id on a team server. Default: every team you are in." }),
    ),
    within_minutes: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MCP_ACTIVE_MINUTES_MAX,
        default: MCP_ACTIVE_MINUTES_DEFAULT,
        description: `How far back counts as working now. Default ${MCP_ACTIVE_MINUTES_DEFAULT}.`,
      }),
    ),
  },
  { additionalProperties: false, title: "ActiveOnFileQuery" },
);

export const AskHumanInputSchema = Type.Object(
  {
    question: NonEmpty({
      maxLength: 500,
      description: "The question, in one or two lines. It becomes the review item's title.",
    }),
    context: Type.Optional(
      Type.String({
        maxLength: 4000,
        description: "What the person needs to answer quickly: options, trade-offs, links.",
      }),
    ),
    paths: Type.Optional(
      Type.Array(NonEmpty({ maxLength: 1024 }), {
        maxItems: 50,
        description:
          "Files the question is about, relative to the repository root. They route the item to the files' owners, and path search finds the answer later.",
      }),
    ),
    repo: Type.Optional(RepoSlug({ description: "Repository as owner/name." })),
  },
  { additionalProperties: false, title: "AskHumanInput" },
);

export const RequestExceptionInputSchema = Type.Object(
  {
    exception_id: Uuidv7({
      description:
        "The exception id from selfhost's block message (selfhost inbox approve <id>). It names the blocked call.",
    }),
    reason: NonEmpty({
      maxLength: 2000,
      description: "Why this exact call is needed and why the rule's alternative does not work.",
    }),
  },
  { additionalProperties: false, title: "RequestExceptionInput" },
);

export const GetAnswerInputSchema = Type.Object(
  {
    item_id: Uuidv7({ description: "The item_id ask_human or request_exception returned." }),
    wait_seconds: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: MCP_WAIT_MAX_SECONDS,
        default: 0,
        description: `Wait up to this long for an answer before returning. Default 0: return at once. At most ${MCP_WAIT_MAX_SECONDS}.`,
      }),
    ),
  },
  { additionalProperties: false, title: "GetAnswerInput" },
);

const Time = DateTime();

export const FileRunSchema = Type.Object(
  {
    session_id: Type.Optional(Type.String({ description: "Vendor session id." })),
    run_id: Type.Optional(Type.String()),
    person: Type.String({ description: "Whose session it was." }),
    agent: Type.Optional(AgentRefSchema),
    repo: Type.Optional(RepoSlug()),
    first_at: Time,
    last_at: Time,
    calls: Type.Integer({ minimum: 1, description: "Tool calls on the path in this run." }),
    tools: Type.Array(Type.String(), { description: "Tools used on the path, most used first." }),
  },
  { additionalProperties: false, title: "FileRun" },
);

export const FileRunsResponseSchema = Type.Object(
  {
    path: Type.String(),
    runs: Type.Array(FileRunSchema, { description: "Newest last call first." }),
    more: Type.Boolean({
      description: "true when older runs were left out. Narrow with since or repo.",
    }),
  },
  { additionalProperties: false, title: "FileRunsResponse" },
);

export const ActiveOnFileResponseSchema = Type.Object(
  {
    path: Type.String(),
    since: Time,
    sessions: Type.Array(
      Type.Object(
        {
          person: Type.String(),
          you: Type.Boolean({ description: "true for your own sessions." }),
          agent: Type.Optional(AgentRefSchema),
          session_id: Type.Optional(Type.String()),
          repo: Type.Optional(RepoSlug()),
          last_at: Time,
          calls: Type.Integer({ minimum: 1 }),
          tools: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
      { description: "Sessions with tool calls on the path since `since`, newest first." },
    ),
  },
  { additionalProperties: false, title: "ActiveOnFileResponse" },
);

export const McpItemStatusSchema = Type.Object(
  {
    item_id: Uuidv7(),
    kind: StringEnum(REVIEW_ITEM_KINDS),
    state: StringEnum(REVIEW_ITEM_STATES, {
      description:
        "open until a person answers; answered; dismissed when it was closed unanswered; expired when it timed out.",
    }),
    title: Type.String(),
    blocking: Type.Boolean(),
    owners: Type.Array(Type.String(), { description: "Who is asked to answer." }),
    answer: Type.Optional(
      Type.Object(
        {
          verdict: VerdictSchema,
          by: Type.String(),
          reason: Type.Optional(Type.String({ description: "For a question, the answer text." })),
          at: Time,
        },
        { additionalProperties: false },
      ),
    ),
    grant: Type.Optional(
      Type.Object(
        {
          expires_at: Time,
        },
        {
          additionalProperties: false,
          description:
            "An approved exception's one-time grant on this machine: the identical call is allowed once until expires_at.",
        },
      ),
    ),
    next: Type.String({ description: "What to do now, in one or two sentences." }),
  },
  { additionalProperties: false, title: "McpItemStatus" },
);

/** Tools the selfhost MCP server exposes to agents. List outputs match the HTTP API bodies. */
export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "get_policy",
    description:
      "Get the team rules that apply to you in this repo: selfhost.toml with team overrides resolved for you and your agent. Check it before an action a rule may block.",
    readOnly: true,
    inputSchema: McpPolicyQuerySchema,
    outputSchema: PolicyResponseSchema,
  },
  {
    name: "get_budget",
    description:
      "Get spend so far, the budget and what is left (remaining_usd) for your team or for you, this day, week or month. budgets lists every budget that applies to you (yours, your team's, your org's; daily, weekly, monthly), whether the gateway stops requests at it (enforcement) and whether it does now (cut_off), and who can raise it. A cut-off budget explains a 402 from the gateway.",
    readOnly: true,
    inputSchema: BudgetQuerySchema,
    outputSchema: BudgetResponseSchema,
  },
  {
    name: "list_review_items",
    description:
      "List your pending review items: open items you own or your sessions raised, blocking first, then by risk.",
    readOnly: true,
    inputSchema: McpReviewItemQuerySchema,
    outputSchema: ReviewItemsPageSchema,
  },
  {
    name: "search_events",
    description: "Search the ledger by person, agent, model, session, kind and time range.",
    readOnly: true,
    inputSchema: McpEventQuerySchema,
    outputSchema: EventsPageSchema,
  },
  {
    name: "search_decisions",
    description:
      "Search past human decisions and rule verdicts by file path, topic, rule or person. Check here before asking a person something they may have answered already.",
    readOnly: true,
    inputSchema: McpDecisionQuerySchema,
    outputSchema: DecisionsPageSchema,
  },
  {
    name: "list_file_runs",
    description:
      "List past agent runs that touched a file or folder: who, which agent, when and with which tools.",
    readOnly: true,
    inputSchema: FileRunsQuerySchema,
    outputSchema: FileRunsResponseSchema,
  },
  {
    name: "list_active_on_file",
    description:
      "Who else is working on a file or folder right now: sessions with tool calls on it in the last minutes. Check before a large change to avoid collisions.",
    readOnly: true,
    inputSchema: ActiveOnFileQuerySchema,
    outputSchema: ActiveOnFileResponseSchema,
  },
  {
    name: "who",
    description:
      "Who (people and named agents) is working right now on which repo, branch and files, who owns each run, and which files two runs are both editing. Check it before starting on a file another run is editing.",
    readOnly: true,
    inputSchema: PresenceQuerySchema,
    outputSchema: PresenceResponseSchema,
  },
  {
    name: "ask_human",
    description:
      "Ask a person a question. Creates a question on the review list and returns its item_id at once; call get_answer with wait_seconds for the answer. Search past decisions first.",
    readOnly: false,
    inputSchema: AskHumanInputSchema,
    outputSchema: McpItemStatusSchema,
  },
  {
    name: "request_exception",
    description:
      "Ask a person to allow one blocked call once. Pass the exception id from selfhost's block message and why the call is needed. Returns at once; call get_answer with wait_seconds, and once approved make the identical call again.",
    readOnly: false,
    inputSchema: RequestExceptionInputSchema,
    outputSchema: McpItemStatusSchema,
  },
  {
    name: "get_answer",
    description:
      "Get the answer to a question or exception request: open while nobody has answered, else the person's verdict and reason. wait_seconds waits for it.",
    readOnly: true,
    inputSchema: GetAnswerInputSchema,
    outputSchema: McpItemStatusSchema,
  },
  {
    name: "record_decision",
    description:
      "Record your person's own decision on a review item they asked you to answer, such as a pull request. Items an agent waits on (approvals, questions, exceptions, blocked actions), proposals to the team's context, and budget and alert items need a person and are refused. Writes a decision.recorded event.",
    readOnly: false,
    inputSchema: RecordDecisionInputSchema,
    outputSchema: DecisionResponseSchema,
  },
];

export type McpPolicyQuery = Static<typeof McpPolicyQuerySchema>;
export type McpReviewItemQuery = Static<typeof McpReviewItemQuerySchema>;
export type McpEventQuery = Static<typeof McpEventQuerySchema>;
export type McpDecisionQuery = Static<typeof McpDecisionQuerySchema>;
export type FileRunsQuery = Static<typeof FileRunsQuerySchema>;
export type ActiveOnFileQuery = Static<typeof ActiveOnFileQuerySchema>;
export type AskHumanInput = Static<typeof AskHumanInputSchema>;
export type RequestExceptionInput = Static<typeof RequestExceptionInputSchema>;
export type GetAnswerInput = Static<typeof GetAnswerInputSchema>;
export type FileRun = Static<typeof FileRunSchema>;
export type FileRunsResponse = Static<typeof FileRunsResponseSchema>;
export type ActiveOnFileResponse = Static<typeof ActiveOnFileResponseSchema>;
export type McpItemStatus = Static<typeof McpItemStatusSchema>;
