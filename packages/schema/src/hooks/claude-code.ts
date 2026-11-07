import { type Static, type TProperties, Type } from "@sinclair/typebox";
import { schemaId } from "../common.js";
import { createHookValidator, NullableString } from "./shared.js";

/**
 * Hook input that Claude Code sends on stdin (command hooks) or as the POST body (HTTP hooks).
 * Field names follow https://code.claude.com/docs/en/hooks. Every object allows additional
 * properties, and enumerated values are plain strings, so new Claude Code releases do not
 * break ingest.
 */

export const CLAUDE_CODE_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
] as const;

export type ClaudeCodeHookEventName = (typeof CLAUDE_CODE_HOOK_EVENTS)[number];

const common = {
  session_id: Type.String({ description: "Current session id." }),
  transcript_path: Type.Optional(
    Type.String({ description: "Path to the session transcript (JSONL)." }),
  ),
  cwd: Type.String({ description: "Working directory when the hook ran." }),
  permission_mode: Type.Optional(
    Type.String({
      description:
        "Permission mode: default, plan, acceptEdits, auto, dontAsk or bypassPermissions. Not sent on every event.",
    }),
  ),
  prompt_id: Type.Optional(
    Type.String({
      description: "Id of the user prompt being processed. Absent before the first prompt.",
    }),
  ),
  agent_id: Type.Optional(Type.String({ description: "Subagent or teammate the hook fired in." })),
  agent_type: Type.Optional(
    Type.String({
      description: "Agent name, for example Explore, when a subagent or --agent is used.",
    }),
  ),
  effort: Type.Optional(
    Type.Object(
      { level: Type.String({ description: "low, medium, high, xhigh or max." }) },
      {
        additionalProperties: true,
        description: "Effort level, on events with a tool-use context.",
      },
    ),
  ),
  scratchpad_dir: Type.Optional(Type.String({ description: "Session scratchpad directory." })),
};

function hookEvent<const N extends string, P extends TProperties>(
  name: N,
  description: string,
  properties: P,
) {
  return Type.Object(
    { ...common, hook_event_name: Type.Literal(name), ...properties },
    { additionalProperties: true, title: `ClaudeCode${name}HookInput`, description },
  );
}

const toolProperties = {
  tool_name: Type.String({
    description: "Tool name, for example Bash, Edit or mcp__server__tool.",
  }),
  tool_input: Type.Record(Type.String(), Type.Unknown(), {
    description: "Tool arguments. File tool paths are absolute.",
  }),
  tool_use_id: Type.Optional(Type.String({ description: "Tool call id." })),
  mcp_server: Type.Optional(
    Type.Object(
      {
        name: Type.String(),
        source: Type.String({
          description: "Where the server is defined: plugin, sdk, user, project and others.",
        }),
      },
      { additionalProperties: true, description: "MCP server details, for MCP tools only." },
    ),
  ),
};

const TaskList = (description: string) =>
  Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { description }));

export const ClaudeCodeSessionStartSchema = hookEvent(
  "SessionStart",
  "A session started or resumed.",
  {
    source: Type.String({ description: "startup, resume, clear, compact or fork." }),
    model: Type.Optional(Type.String({ description: "Active model id. Can be missing." })),
    session_title: Type.Optional(Type.String()),
    seconds_since_last_response: Type.Optional(Type.Number()),
    context_tokens: Type.Optional(Type.Number()),
    prompt_cache_likely_expired: Type.Optional(Type.Boolean()),
    estimated_cache_write_usd: Type.Optional(Type.Number()),
  },
);

export const ClaudeCodeSessionEndSchema = hookEvent("SessionEnd", "A session ended.", {
  reason: Type.String({
    description: "clear, resume, logout, prompt_input_exit or other.",
  }),
});

export const ClaudeCodeUserPromptSubmitSchema = hookEvent(
  "UserPromptSubmit",
  "The user submitted a prompt.",
  {
    prompt: Type.String({ description: "Prompt text. Stored only when ledger.log_prompts is on." }),
    session_title: Type.Optional(Type.String()),
  },
);

export const ClaudeCodePreToolUseSchema = hookEvent(
  "PreToolUse",
  "A tool is about to run. The hook can allow, deny or ask.",
  toolProperties,
);

export const ClaudeCodePostToolUseSchema = hookEvent("PostToolUse", "A tool ran successfully.", {
  ...toolProperties,
  tool_response: Type.Unknown({ description: "Tool result. Shape depends on the tool." }),
  duration_ms: Type.Optional(Type.Number({ description: "Tool run time in milliseconds." })),
});

export const ClaudeCodeNotificationSchema = hookEvent(
  "Notification",
  "Claude Code raised a notification, for example a permission prompt or idle prompt.",
  {
    message: Type.String({ description: "Notification text." }),
    title: Type.Optional(Type.String()),
    notification_type: Type.Optional(
      Type.String({
        description: "permission_prompt, idle_prompt, auth_success, elicitation_dialog and others.",
      }),
    ),
  },
);

const stopProperties = {
  stop_hook_active: Type.Optional(
    Type.Boolean({
      description: "true when the turn is already continuing because of a Stop hook.",
    }),
  ),
  last_assistant_message: Type.Optional(
    Type.String({ description: "Text of the final assistant message." }),
  ),
  background_tasks: TaskList("Tasks still running in the background."),
  session_crons: TaskList("Scheduled wakeups for the session."),
};

export const ClaudeCodeStopSchema = hookEvent(
  "Stop",
  "The main agent finished its turn.",
  stopProperties,
);

export const ClaudeCodeSubagentStopSchema = hookEvent("SubagentStop", "A subagent finished.", {
  ...stopProperties,
  agent_transcript_path: Type.Optional(Type.String({ description: "The subagent's transcript." })),
});

export const ClaudeCodePreCompactSchema = hookEvent(
  "PreCompact",
  "Context compaction is about to run.",
  {
    trigger: Type.String({ description: "manual or auto." }),
    custom_instructions: Type.Optional(NullableString("Instructions passed to /compact.")),
  },
);

export const ClaudeCodeOtherHookSchema = Type.Object(
  {
    ...common,
    hook_event_name: Type.String({
      description: "An event this version of the schema does not model yet.",
      not: { enum: [...CLAUDE_CODE_HOOK_EVENTS] },
    }),
  },
  {
    additionalProperties: true,
    title: "ClaudeCodeOtherHookInput",
    description: "Any other hook event. Only the common fields are checked.",
  },
);

export const CLAUDE_CODE_HOOK_SCHEMAS = {
  SessionStart: ClaudeCodeSessionStartSchema,
  SessionEnd: ClaudeCodeSessionEndSchema,
  UserPromptSubmit: ClaudeCodeUserPromptSubmitSchema,
  PreToolUse: ClaudeCodePreToolUseSchema,
  PostToolUse: ClaudeCodePostToolUseSchema,
  Notification: ClaudeCodeNotificationSchema,
  Stop: ClaudeCodeStopSchema,
  SubagentStop: ClaudeCodeSubagentStopSchema,
  PreCompact: ClaudeCodePreCompactSchema,
} as const satisfies Record<ClaudeCodeHookEventName, unknown>;

export const ClaudeCodeHookInputSchema = Type.Union(
  [
    ClaudeCodeSessionStartSchema,
    ClaudeCodeSessionEndSchema,
    ClaudeCodeUserPromptSubmitSchema,
    ClaudeCodePreToolUseSchema,
    ClaudeCodePostToolUseSchema,
    ClaudeCodeNotificationSchema,
    ClaudeCodeStopSchema,
    ClaudeCodeSubagentStopSchema,
    ClaudeCodePreCompactSchema,
    ClaudeCodeOtherHookSchema,
  ],
  {
    $id: schemaId("claude-code-hook.schema.json"),
    title: "ClaudeCodeHookInput",
    description:
      "Hook input accepted from Claude Code, one schema per hook_event_name. Unknown fields and unknown events are accepted.",
  },
);

export type ClaudeCodeHookInput = Static<typeof ClaudeCodeHookInputSchema>;
export type ClaudeCodePreToolUse = Static<typeof ClaudeCodePreToolUseSchema>;
export type ClaudeCodePostToolUse = Static<typeof ClaudeCodePostToolUseSchema>;

export const validateClaudeCodeHook = createHookValidator<ClaudeCodeHookInput>(
  "hook_event_name",
  CLAUDE_CODE_HOOK_SCHEMAS,
  ClaudeCodeOtherHookSchema,
);
