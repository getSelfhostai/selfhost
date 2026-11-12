import { type Static, Type } from "@sinclair/typebox";
import { DateTime, StringEnum } from "./common.js";
import { AgentRefSchema, LedgerEventSchema } from "./event.js";
import { RunHandoffSchema } from "./handoff.js";
import { RUN_OWNER_SOURCES } from "./presence.js";
import { SecondOpinionSchema } from "./second-opinion.js";
import { CACHE_HIT_RATE_TEXT } from "./usage.js";

/**
 * One agent run for the console's run view: GET /v1/runs/{run_id}. A run is one agent session,
 * so run_id is the session_id its events carry. The full timeline lives in the team's tracer;
 * this is the summary, the ledger events in time order and the links out.
 */

export const RUN_SCHEMA = "selfhost.run/v1";

export const RUN_EVENTS_LIMIT_DEFAULT = 200;
export const RUN_EVENTS_LIMIT_MAX = 1000;

export const RUN_PR_STATES = ["open", "merged", "closed"] as const;

const NullableText = (description: string) =>
  Type.Union([Type.String(), Type.Null()], { description });

export const RunSummarySchema = Type.Object(
  {
    id: Type.String({ description: "Run id: the agent's session id." }),
    agent: Type.Union([AgentRefSchema, Type.Null()], {
      description: "The coding agent, or null when no event named one.",
    }),
    model: NullableText("The model most of the run's requests went to, or null."),
    person: NullableText("The person the run worked for, or null when not known."),
    owner: NullableText(
      "The one human who answers for the run: the new owner of its newest handoff, else the owner of the named agent that wrote it, else person, else who started it (or the schedule's owner), else the first person in [review] fallback.",
    ),
    owner_via: Type.Optional(
      Type.Union([StringEnum(RUN_OWNER_SOURCES), Type.Null()], {
        description:
          "Where owner came from: handoff, named_agent, person, trigger, schedule or fallback.",
      }),
    ),
    named_agent: Type.Optional(
      NullableText("The [agents.<name>] whose events these are, or null."),
    ),
    team: NullableText("The team the run belongs to, or null on a laptop ledger."),
    repo: NullableText("Repository as owner/name, or null when not known."),
    started_at: DateTime({ description: "The run's first event." }),
    ended_at: Type.Union([DateTime(), Type.Null()], {
      description:
        "When the session ended, else its last event once it has been idle for 30 minutes. null while it is still going.",
    }),
    cost_usd: Type.Number({
      minimum: 0,
      description:
        "Spend of the run's model requests, counting one source when several reported the same session.",
    }),
    tokens: Type.Integer({
      minimum: 0,
      description: "Input, output, cache read and cache write tokens of those requests.",
    }),
    cache_hit_rate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()], {
      description: `Share of the run's input tokens read from the prompt cache, 0 to 1: ${CACHE_HIT_RATE_TEXT} null when the run reported no cache read or write.`,
    }),
    cache_tip: NullableText(
      "One line when the run cost at least [alerts] cache_tip_usd at a hit rate under cache_hit_floor, naming the usual causes; else null.",
    ),
  },
  { additionalProperties: false, title: "RunSummary" },
);

export const RunPullRequestSchema = Type.Object(
  {
    url: Type.String({ format: "uri", description: "Pull request URL." }),
    state: StringEnum(RUN_PR_STATES, {
      description: "From the newest pr.opened, pr.merged or pr.closed event for it.",
    }),
    second_opinions: Type.Optional(
      Type.Array(SecondOpinionSchema, {
        description:
          "What the team's AI reviewers said about it, the newest review from each tool. Absent when no reviewer has reviewed it.",
      }),
    ),
  },
  { additionalProperties: false, title: "RunPullRequest" },
);

export const RunQuerySchema = Type.Object(
  {
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: RUN_EVENTS_LIMIT_MAX,
        default: RUN_EVENTS_LIMIT_DEFAULT,
        description: "Maximum number of events.",
      }),
    ),
    cursor: Type.Optional(
      Type.String({ description: "Opaque cursor from next_cursor of the previous page." }),
    ),
  },
  { additionalProperties: false },
);

export const RunResponseSchema = Type.Object(
  {
    schema: Type.Literal(RUN_SCHEMA),
    run: RunSummarySchema,
    events: Type.Array(LedgerEventSchema, {
      description:
        "The run's ledger events, oldest first, at most limit of them. Redacted under the team's current [ledger] and [[redaction]] settings, so prompt text appears only when log_prompts is on.",
    }),
    next_cursor: Type.Union([Type.String(), Type.Null()], {
      description: "Pass as cursor to get the next events. null on the last page.",
    }),
    prs: Type.Array(RunPullRequestSchema, {
      description: "Pull requests the run's events link to, in the order they first appear.",
    }),
    trace_url: Type.Union([Type.String(), Type.Null()], {
      description:
        "The run in the team's tracer: [integrations.tracer] run_url with {run_id} and {trace_id} filled in. null when no tracer is set up, it has no run_url, or the run has not been sent yet.",
    }),
    handoffs: Type.Array(RunHandoffSchema, {
      description:
        "Who held the run: each handoff, oldest first, with its redacted note. Empty when it never changed hands.",
    }),
  },
  { additionalProperties: false, title: "RunResponse" },
);

export type RunSummary = Static<typeof RunSummarySchema>;
export type RunPullRequest = Static<typeof RunPullRequestSchema>;
export type RunQuery = Static<typeof RunQuerySchema>;
export type RunResponse = Static<typeof RunResponseSchema>;
