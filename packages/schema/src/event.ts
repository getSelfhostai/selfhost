import { type Static, Type } from "@sinclair/typebox";
import {
  DateTime,
  NonEmpty,
  RepoSlug,
  requiredWhenSchema,
  StringEnum,
  schemaId,
  Url,
  Uuidv7,
} from "./common.js";
import {
  createValidator,
  type FieldError,
  formatField,
  requiredWhenErrors,
  type ValidationResult,
} from "./validate.js";

export const EVENT_SCHEMA = "selfhost.event/v1";

export const EVENT_SOURCES = [
  "hook",
  "otel",
  "local_log",
  "vendor_api",
  "github",
  "gateway",
  "sdk",
  "cli",
  "server",
] as const;

export const EVENT_KINDS = [
  "session.started",
  "session.ended",
  "prompt.submitted",
  "tool.called",
  "tool.result",
  "approval.requested",
  "decision.recorded",
  "cost.recorded",
  "commit.created",
  "pr.opened",
  "pr.merged",
  "pr.closed",
  "policy.evaluated",
  "alert.raised",
  "config.reported",
  "review.submitted",
  "credential.issued",
  "credential.revoked",
  "egress.blocked",
] as const;

export const ACTOR_KINDS = ["person", "agent", "system"] as const;

export const AGENT_VENDORS = [
  "claude_code",
  "codex",
  "opencode",
  "goose",
  "cursor",
  "copilot",
  "other",
] as const;

export const TARGET_TYPES = ["file", "command", "url", "repo", "pr", "resource"] as const;

export const VERDICTS = ["allow", "block", "ask", "approve", "deny", "answer", "override"] as const;

/** Verdicts a person gives when answering a review item. */
export const PERSON_VERDICTS = ["approve", "deny", "answer", "override"] as const;

export const RULE_MODES_RECORDED = ["observe", "enforce"] as const;

export type EventSource = (typeof EVENT_SOURCES)[number];
export type EventKind = (typeof EVENT_KINDS)[number];
export type AgentVendor = (typeof AGENT_VENDORS)[number];
export type Verdict = (typeof VERDICTS)[number];
export type PersonVerdict = (typeof PERSON_VERDICTS)[number];

/** Optional fields that become required for some event kinds. */
export const EVENT_KIND_REQUIRES = {
  "tool.called": ["tool"],
  "tool.result": ["tool"],
  "decision.recorded": ["decision"],
  "policy.evaluated": ["decision"],
  "cost.recorded": ["cost"],
} as const satisfies Partial<Record<EventKind, readonly string[]>>;

export const ActorSchema = Type.Object(
  {
    kind: StringEnum(ACTOR_KINDS, {
      description:
        "person for a human, agent for a coding agent acting on its own, system for selfhost, CI or another service.",
    }),
    id: NonEmpty({
      description:
        "Stable identifier: email or login for a person, agent or run id for an agent, component name for system.",
    }),
    name: Type.Optional(Type.String({ description: "Display name." })),
  },
  { additionalProperties: false, description: "Who did it." },
);

export const AgentRefSchema = Type.Object(
  {
    vendor: StringEnum(AGENT_VENDORS, { description: "Agent product." }),
    version: Type.Optional(
      Type.String({ description: "Agent CLI or app version, for example 2.1.0." }),
    ),
    name: Type.Optional(
      Type.String({
        description:
          "Agent or subagent name when the vendor reports one, for example a Claude Code subagent type.",
      }),
    ),
  },
  { additionalProperties: false, description: "Which coding agent was involved." },
);

export const VerdictSchema = StringEnum(VERDICTS, {
  description:
    "allow, block and ask come from a rule. approve, deny, answer and override come from a person.",
});

export const ToolSchema = Type.Object(
  {
    name: NonEmpty({
      description:
        "Tool name as the vendor reports it, for example Bash, Edit or an MCP tool name.",
    }),
    input_summary: Type.Optional(
      Type.String({
        description:
          "Short, redacted summary of the tool input, such as the command or file path. Full inputs are not stored here.",
      }),
    ),
  },
  { additionalProperties: false, description: "Tool call details." },
);

export const TargetSchema = Type.Object(
  {
    type: StringEnum(TARGET_TYPES, { description: "What kind of thing was touched." }),
    value: NonEmpty({
      description: "The file path, command, URL, owner/name, PR URL or resource id.",
    }),
  },
  { additionalProperties: false, description: "What the action touched." },
);

export const DecisionSchema = Type.Object(
  {
    verdict: VerdictSchema,
    by: Type.Optional(
      Type.String({ description: "Person who decided, or the rule engine for rule verdicts." }),
    ),
    reason: Type.Optional(Type.String({ description: "Why. For a question, the answer text." })),
    rule_id: Type.Optional(
      Type.String({
        description:
          'Rule id from selfhost.toml when a rule decided, or "mcp.allow", "models.allow" and "egress.allow" for the [mcp], [models] and [egress] allow lists.',
      }),
    ),
    mode: Type.Optional(
      StringEnum(RULE_MODES_RECORDED, {
        description:
          "Rule mode at decision time. In observe, block and ask verdicts are recorded but not applied.",
      }),
    ),
    policy_commit: Type.Optional(
      Type.String({
        pattern: "^[0-9a-f]{7,64}$",
        description:
          "Last git commit that changed the selfhost.toml the rule came from. Absent when the file is not committed.",
      }),
    ),
    policy_hash: Type.Optional(
      Type.String({
        pattern: "^[0-9a-f]{64}$",
        description:
          "SHA-256 of the selfhost.toml bytes the rule came from, in hex. Differs from the file at policy_commit when it had uncommitted changes.",
      }),
    ),
    item_id: Type.Optional(Uuidv7({ description: "Review item this decision answers." })),
    replaces_event_id: Type.Optional(
      Uuidv7({
        description:
          "Earlier decision event this one supersedes. The ledger is append-only, so corrections are new events.",
      }),
    ),
  },
  { additionalProperties: false, description: "A rule verdict or a human decision." },
);

const TokenCount = (description: string) => Type.Integer({ minimum: 0, description });

export const CostSchema = Type.Object(
  {
    input_tokens: TokenCount("Uncached input tokens."),
    output_tokens: TokenCount("Output tokens, including reasoning tokens."),
    cache_read_tokens: TokenCount("Input tokens read from the prompt cache."),
    cache_write_tokens: TokenCount("Input tokens written to the prompt cache."),
    usd: Type.Number({ minimum: 0, description: "Cost in US dollars." }),
    estimated: Type.Boolean({
      description:
        "true when usd was computed from a price table, false when the vendor reported it.",
    }),
  },
  { additionalProperties: false, description: "Tokens and spend for this event." },
);

export const LinksSchema = Type.Object(
  {
    pr_url: Type.Optional(Url({ description: "Pull request URL." })),
    commit_sha: Type.Optional(
      Type.String({ pattern: "^[0-9a-f]{7,64}$", description: "Git commit SHA." }),
    ),
    run_url: Type.Optional(Url({ description: "CI run or agent run URL." })),
    item_id: Type.Optional(Uuidv7({ description: "Related review item." })),
  },
  { additionalProperties: false, description: "Links to related objects." },
);

export const LedgerEventSchema = Type.Object(
  {
    id: Uuidv7({
      description:
        "Event id, a UUIDv7 so ids sort by time. Also the idempotency key: writing the same id twice stores one event.",
    }),
    schema: Type.Literal(EVENT_SCHEMA, { description: "Schema version tag." }),
    ts: DateTime({
      description: "When the event happened (not when it was ingested), with a UTC offset.",
    }),
    source: StringEnum(EVENT_SOURCES, {
      description:
        "Ingest path: hook (agent hook), otel (OpenTelemetry export), local_log (agent log on disk), vendor_api (vendor audit or compliance API), github, gateway (model gateway), sdk, cli, or server (selfhost itself).",
    }),
    kind: StringEnum(EVENT_KINDS, { description: "What happened." }),
    actor: ActorSchema,
    org: Type.Optional(Type.String({ description: "Organization slug." })),
    team: Type.Optional(Type.String({ description: "Team name from selfhost.toml [teams]." })),
    repo: Type.Optional(RepoSlug({ description: "Repository as owner/name." })),
    agent: Type.Optional(AgentRefSchema),
    model: Type.Optional(
      Type.String({
        description: "Model id as the vendor reports it, for example claude-opus-4 or gpt-5-codex.",
      }),
    ),
    session_id: Type.Optional(
      Type.String({
        description:
          "Vendor session id, for example the Claude Code session_id or Codex thread id.",
      }),
    ),
    run_id: Type.Optional(
      Type.String({ description: "Run id that groups work on one task, or a CI run id." }),
    ),
    tool: Type.Optional(ToolSchema),
    target: Type.Optional(TargetSchema),
    decision: Type.Optional(DecisionSchema),
    cost: Type.Optional(CostSchema),
    links: Type.Optional(LinksSchema),
    data: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "Source-specific extras with no field of their own. Keep it small and never put secrets here.",
      }),
    ),
    redacted: Type.Optional(
      Type.Array(NonEmpty(), {
        description:
          "Field paths whose values were removed or masked before the event was written, for example tool.input_summary.",
      }),
    ),
  },
  {
    $id: schemaId("event.schema.json"),
    title: "LedgerEvent",
    description:
      "One ledger record: a run, tool call, approval, human decision or cost, from any coding agent. Events are append-only.",
    additionalProperties: false,
    allOf: requiredWhenSchema("kind", EVENT_KIND_REQUIRES),
  },
);

export type LedgerEvent = Static<typeof LedgerEventSchema>;
export type Actor = Static<typeof ActorSchema>;
export type AgentRef = Static<typeof AgentRefSchema>;
export type Decision = Static<typeof DecisionSchema>;
export type Cost = Static<typeof CostSchema>;

export const eventValidator = createValidator(LedgerEventSchema, (event) =>
  requiredWhenErrors(event, "kind", EVENT_KIND_REQUIRES),
);

export function validateEvent(value: unknown): ValidationResult<LedgerEvent> {
  return eventValidator.validate(value);
}

export const MAX_EVENT_BATCH = 1000;

export interface BatchError extends FieldError {
  /** Position of the failing event in the batch, or -1 when the batch itself is wrong. */
  index: number;
}

export type BatchResult = { ok: true; events: LedgerEvent[] } | { ok: false; errors: BatchError[] };

/**
 * Validates a batch for atomic ingest: either every event is valid and the batch can be
 * written, or nothing is written and every error is returned with its index.
 */
export function validateEventBatch(value: unknown): BatchResult {
  if (!Array.isArray(value)) {
    return { ok: false, errors: [{ index: -1, field: "events", message: "Expected an array" }] };
  }
  if (value.length === 0 || value.length > MAX_EVENT_BATCH) {
    return {
      ok: false,
      errors: [
        {
          index: -1,
          field: "events",
          message: `Expected between 1 and ${MAX_EVENT_BATCH} events, got ${value.length}`,
        },
      ],
    };
  }
  const errors: BatchError[] = [];
  const firstIndexById = new Map<string, number>();
  value.forEach((item, index) => {
    const result = validateEvent(item);
    if (!result.ok) {
      for (const error of result.errors) errors.push({ index, ...error });
      return;
    }
    const earlier = firstIndexById.get(result.value.id);
    if (earlier !== undefined) {
      errors.push({
        index,
        field: formatField(["id"]),
        message: `Duplicate id, also used by the event at index ${earlier}`,
      });
      return;
    }
    firstIndexById.set(result.value.id, index);
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, events: value as LedgerEvent[] };
}
