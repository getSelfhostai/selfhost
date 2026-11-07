import { type Static, type TProperties, Type } from "@sinclair/typebox";
import { schemaId } from "../common.js";
import { createHookValidator, NullableString } from "./shared.js";

/**
 * Payloads accepted from OpenAI Codex.
 *
 * Hooks: Codex runs Claude Code style hooks from hooks.json or a [hooks] table in config.toml
 * and sends JSON on stdin. Field names follow the schemas Codex generates in
 * codex-rs/hooks/schema/generated. Codex marks most fields required; here only the fields
 * ingest needs are required, unknown fields are allowed and enumerated values are plain
 * strings, because the hooks feature is new and still changing.
 *
 * Notify: the older `notify` setting runs a program with one JSON argument after each turn.
 */

export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostModelRequest",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Interrupt",
] as const;

export type CodexHookEventName = (typeof CODEX_HOOK_EVENTS)[number];

const common = {
  session_id: Type.String({ description: "Codex thread id." }),
  turn_id: Type.Optional(Type.String({ description: "Active turn id, on turn-scoped events." })),
  transcript_path: Type.Optional(NullableString("Path to the session rollout file, or null.")),
  cwd: Type.String({ description: "Working directory." }),
  model: Type.Optional(Type.String({ description: "Active model id." })),
  permission_mode: Type.Optional(
    Type.String({ description: "default, acceptEdits, plan, dontAsk or bypassPermissions." }),
  ),
  agent_id: Type.Optional(Type.String({ description: "Subagent id." })),
  agent_type: Type.Optional(Type.String({ description: "Subagent type." })),
};

function hookEvent<const N extends string, P extends TProperties>(
  name: N,
  description: string,
  properties: P,
) {
  return Type.Object(
    { ...common, hook_event_name: Type.Literal(name), ...properties },
    { additionalProperties: true, title: `Codex${name}HookInput`, description },
  );
}

const toolProperties = {
  tool_name: Type.String({ description: "Tool name, for example Bash or apply_patch." }),
  tool_input: Type.Unknown({ description: "Tool arguments. Usually an object." }),
};

const trigger = { trigger: Type.String({ description: "manual or auto." }) };

const stopProperties = {
  stop_hook_active: Type.Optional(Type.Boolean()),
  last_assistant_message: Type.Optional(NullableString("Text of the final assistant message.")),
};

export const CODEX_HOOK_SCHEMAS = {
  SessionStart: hookEvent("SessionStart", "A session started.", {
    source: Type.String({ description: "startup, resume, clear, compact or fork." }),
  }),
  SessionEnd: hookEvent("SessionEnd", "A session ended.", {
    reason: Type.String({ description: "End reason. Codex currently always sends other." }),
  }),
  UserPromptSubmit: hookEvent("UserPromptSubmit", "The user submitted a prompt.", {
    prompt: Type.String({ description: "Prompt text. Stored only when ledger.log_prompts is on." }),
  }),
  PreToolUse: hookEvent("PreToolUse", "A tool is about to run.", {
    ...toolProperties,
    tool_use_id: Type.Optional(Type.String({ description: "Tool call id. Short and opaque." })),
  }),
  PermissionRequest: hookEvent("PermissionRequest", "Codex asks for permission to run a tool.", {
    ...toolProperties,
  }),
  PostToolUse: hookEvent("PostToolUse", "A tool ran.", {
    ...toolProperties,
    tool_response: Type.Optional(Type.Unknown({ description: "Tool result." })),
    tool_use_id: Type.Optional(Type.String()),
  }),
  PostModelRequest: hookEvent("PostModelRequest", "A model request finished.", {
    status: Type.Optional(Type.String({ description: "completed, failed or cancelled." })),
    error: Type.Optional(NullableString()),
    token_usage: Type.Optional(
      Type.Union([
        Type.Object(
          {
            input_tokens: Type.Optional(Type.Integer()),
            cached_input_tokens: Type.Optional(Type.Integer()),
            cache_write_input_tokens: Type.Optional(Type.Integer()),
            output_tokens: Type.Optional(Type.Integer()),
            reasoning_output_tokens: Type.Optional(Type.Integer()),
            total_tokens: Type.Optional(Type.Integer()),
          },
          { additionalProperties: true },
        ),
        Type.Null(),
      ]),
    ),
  }),
  Stop: hookEvent("Stop", "The agent finished its turn.", stopProperties),
  SubagentStart: hookEvent("SubagentStart", "A subagent started.", {}),
  SubagentStop: hookEvent("SubagentStop", "A subagent finished.", {
    ...stopProperties,
    agent_transcript_path: Type.Optional(NullableString()),
  }),
  PreCompact: hookEvent("PreCompact", "Context compaction is about to run.", trigger),
  PostCompact: hookEvent("PostCompact", "Context compaction finished.", trigger),
  Interrupt: hookEvent("Interrupt", "The user interrupted the turn.", {}),
} as const satisfies Record<CodexHookEventName, unknown>;

export const CodexOtherHookSchema = Type.Object(
  {
    ...common,
    hook_event_name: Type.String({
      description: "An event this version of the schema does not model yet.",
      not: { enum: [...CODEX_HOOK_EVENTS] },
    }),
  },
  {
    additionalProperties: true,
    title: "CodexOtherHookInput",
    description: "Any other hook event. Only the common fields are checked.",
  },
);

const s = CODEX_HOOK_SCHEMAS;

export const CodexHookInputSchema = Type.Union(
  [
    s.SessionStart,
    s.SessionEnd,
    s.UserPromptSubmit,
    s.PreToolUse,
    s.PermissionRequest,
    s.PostToolUse,
    s.PostModelRequest,
    s.Stop,
    s.SubagentStart,
    s.SubagentStop,
    s.PreCompact,
    s.PostCompact,
    s.Interrupt,
    CodexOtherHookSchema,
  ],
  {
    $id: schemaId("codex-hook.schema.json"),
    title: "CodexHookInput",
    description:
      "Hook input accepted from Codex, one schema per hook_event_name. Unknown fields and unknown events are accepted.",
  },
);

export type CodexHookInput = Static<typeof CodexHookInputSchema>;

export const validateCodexHook = createHookValidator<CodexHookInput>(
  "hook_event_name",
  CODEX_HOOK_SCHEMAS,
  CodexOtherHookSchema,
);

export const CodexNotifySchema = Type.Object(
  {
    type: Type.String({ description: "Notification type. Codex sends agent-turn-complete." }),
    "thread-id": Type.Optional(Type.String({ description: "Codex thread (session) id." })),
    "turn-id": Type.Optional(Type.String({ description: "Turn id." })),
    cwd: Type.Optional(Type.String({ description: "Working directory." })),
    client: Type.Optional(
      Type.String({ description: "Client that ran the turn, for example codex-tui." }),
    ),
    "input-messages": Type.Optional(
      Type.Array(Type.String(), { description: "User messages that started the turn." }),
    ),
    "last-assistant-message": Type.Optional(NullableString("Final assistant message.")),
  },
  {
    $id: schemaId("codex-notify.schema.json"),
    title: "CodexNotifyPayload",
    description:
      "JSON that Codex passes as the last argument to the program set in its notify setting, after each agent turn.",
    additionalProperties: true,
  },
);

export type CodexNotifyPayload = Static<typeof CodexNotifySchema>;

const notifyValidator = createHookValidator<CodexNotifyPayload>("type", {}, CodexNotifySchema);

export function validateCodexNotify(value: unknown) {
  return notifyValidator(value);
}
