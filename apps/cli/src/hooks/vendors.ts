import { isAbsolute, resolve } from "node:path";

/**
 * Each agent's pre-tool hook, in plain terms: which events can stop a tool call, how a payload
 * names the call, and how the agent wants the answer. receive.ts loads this module on every hook
 * event, so it imports no workspace package.
 *
 * Vendor docs, as of November 2026:
 * - Claude Code: https://code.claude.com/docs/en/hooks (PreToolUse, hookSpecificOutput; an
 *   "ask" reaches no person in bypassPermissions or dontAsk mode, nor in print and SDK runs, so
 *   there an ask is a deny; see askSkippedBy)
 * - Codex: https://learn.chatgpt.com/docs/hooks (PreToolUse; "ask" is parsed but not
 *   supported, so an ask is answered as a deny)
 * - Cursor: https://cursor.com/docs/hooks (preToolUse, beforeShellExecution, beforeReadFile,
 *   beforeMCPExecution; a permission hook that prints nothing or invalid JSON blocks the action)
 * - OpenCode: the plugin selfhost installs sends its own payload, see guard/opencode-plugin.ts
 */

/** The payload kinds the ledger mappers read, by the names agents are configured with. */
export const HOOK_AGENTS = {
  claude: "claude",
  "claude-code": "claude",
  claude_code: "claude",
  codex: "codex",
  "codex-notify": "codex-notify",
  cursor: "cursor",
  "cursor-agent": "cursor",
  opencode: "opencode",
} as const;

export type HookAgent = (typeof HOOK_AGENTS)[keyof typeof HOOK_AGENTS];

export type Vendor = "claude_code" | "codex" | "cursor" | "opencode";

const VENDORS: Record<Exclude<HookAgent, "codex-notify">, Vendor> = {
  claude: "claude_code",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
};

export const AGENT_LABELS: Record<Vendor, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

/** The events whose answer can stop a tool call, by agent. */
export const PRE_TOOL_EVENTS: Record<HookAgent, readonly string[]> = {
  claude: ["PreToolUse"],
  codex: ["PreToolUse"],
  "codex-notify": [],
  cursor: ["preToolUse", "beforeShellExecution", "beforeReadFile", "beforeMCPExecution"],
  opencode: ["tool.execute.before"],
};

/** Cursor events that can ask the person; its preToolUse accepts "ask" but does not apply it. */
const CURSOR_ASKS = new Set(["beforeShellExecution", "beforeMCPExecution"]);

/** Cursor events whose answer is a JSON object even when nothing is decided. */
const CURSOR_ANSWERS: Record<string, string> = { beforeSubmitPrompt: '{"continue":true}' };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

export function eventName(payload: Json): string | undefined {
  return text(payload.hook_event_name);
}

export function isPreToolEvent(agent: HookAgent, payload: Json): boolean {
  const name = eventName(payload);
  return name !== undefined && PRE_TOOL_EVENTS[agent].includes(name);
}

/** One pre-tool payload in the terms the checks use. */
export interface PreToolCall {
  vendor: Vendor;
  event: string;
  sessionId?: string;
  /** Absolute folder the call runs in. */
  cwd?: string;
  /** Workspace folders the agent reports, such as Cursor's workspace_roots. */
  roots: string[];
  tool: string;
  /** Shell command, as one string. */
  command?: string;
  /** File the tool works on, absolute when the agent says where. */
  file?: string;
  access?: "read" | "write";
  url?: string;
  mcpServer?: string;
  model?: string;
  toolUseId?: string;
  /** The session's permission mode, as the agent names it (Claude Code, Codex). */
  permissionMode?: string;
  /**
   * Another hook of the same agent decides this call: answer allow and record nothing, unless
   * this check blocks it. Cursor sends Shell, Read and MCP calls to preToolUse and then to their
   * own hook, which can ask and carries more detail.
   */
  deferred?: boolean;
}

/** Quotes argv words into one command line, for agents that send the command as a list. */
function joinArgv(words: unknown[]): string {
  return words
    .map(String)
    .map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`))
    .join(" ");
}

function commandOf(input: Json): string | undefined {
  const command = input.command ?? input.cmd;
  if (Array.isArray(command)) return command.length > 0 ? joinArgv(command) : undefined;
  return text(command);
}

/** Files a Codex apply_patch body adds, updates or deletes. */
function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(
    (match) => match[1]?.trim() ?? "",
  );
}

const FILE_KEYS = ["file_path", "notebook_path", "filePath", "path", "target_file"] as const;

function fileOf(input: Json): string | undefined {
  for (const key of FILE_KEYS) {
    const value = text(input[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Claude Code tools by what they do with their file. Edit and MultiEdit echo the file back. */
const CLAUDE_READ = new Set(["Read", "NotebookRead", "Edit", "MultiEdit", "Grep"]);
const CLAUDE_WRITE = new Set(["Write", "NotebookEdit"]);
const CURSOR_READ = new Set(["Read", "Grep"]);
const CURSOR_WRITE = new Set(["Write", "Delete", "Edit"]);
const OPENCODE_READ = new Set(["read", "edit", "grep"]);
const OPENCODE_WRITE = new Set(["write", "patch"]);

/**
 * What a file tool does with its file, by the tool's name in any agent: Claude Code's first,
 * then Cursor's and OpenCode's. Undefined for a tool that works on no file.
 */
export function toolAccess(tool: string): "read" | "write" | undefined {
  if (CLAUDE_READ.has(tool)) return "read";
  if (CLAUDE_WRITE.has(tool)) return "write";
  if (CURSOR_READ.has(tool) || OPENCODE_READ.has(tool)) return "read";
  if (CURSOR_WRITE.has(tool) || OPENCODE_WRITE.has(tool)) return "write";
  return undefined;
}

/** Tools that change their file, by name in any agent; Edit reads it too, but it is a change. */
const CHANGE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Delete",
  "write",
  "edit",
  "patch",
  "apply_patch",
]);
const READ_TOOLS = new Set(["Read", "NotebookRead", "Grep", "read", "grep"]);

/**
 * What a file tool call does, as a person would say it: a read or a change. Undefined for a call
 * that names no file.
 */
export function callAction(call: Pick<PreToolCall, "tool" | "file" | "access">) {
  if (call.file === undefined) return undefined;
  if (CHANGE_TOOLS.has(call.tool)) return "change" as const;
  if (READ_TOOLS.has(call.tool)) return "read" as const;
  if (call.access === "write") return "change" as const;
  if (call.access === "read") return "read" as const;
  return undefined;
}

function mcpServerOf(tool: string): string | undefined {
  if (!tool.startsWith("mcp__")) return undefined;
  const rest = tool.slice("mcp__".length);
  const end = rest.indexOf("__");
  return (end === -1 ? rest : rest.slice(0, end)) || undefined;
}

function absolute(path: string | undefined, cwd: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  if (isAbsolute(path)) return path;
  return cwd === undefined ? path : resolve(cwd, path);
}

function claudeOrCodex(vendor: Vendor, event: string, p: Json): PreToolCall | undefined {
  const tool = text(p.tool_name);
  if (tool === undefined) return undefined;
  const input = isObject(p.tool_input) ? p.tool_input : {};
  const cwd = text(p.cwd);
  const call: PreToolCall = {
    vendor,
    event,
    sessionId: text(p.session_id),
    cwd,
    roots: [],
    tool,
    model: text(p.model),
    toolUseId: text(p.tool_use_id),
    mcpServer: mcpServerOf(tool),
    permissionMode: text(p.permission_mode),
  };
  if (vendor === "codex" && tool === "apply_patch") {
    const files = patchFiles(commandOf(input) ?? "");
    return { ...call, file: absolute(files[0], cwd), access: "write" };
  }
  const command = commandOf(input);
  if (command !== undefined) return { ...call, command };
  const file = absolute(fileOf(input), cwd);
  const access = CLAUDE_READ.has(tool) ? "read" : CLAUDE_WRITE.has(tool) ? "write" : undefined;
  return { ...call, file, access, url: text(input.url) };
}

function cursor(event: string, p: Json): PreToolCall | undefined {
  const roots = Array.isArray(p.workspace_roots)
    ? p.workspace_roots.filter((root): root is string => typeof root === "string" && root !== "")
    : [];
  const cwd = text(p.cwd) ?? roots[0];
  const base = {
    vendor: "cursor" as const,
    event,
    sessionId: text(p.conversation_id),
    cwd,
    roots,
    model: text(p.model) ?? text(p.model_id),
  };
  switch (event) {
    case "beforeShellExecution": {
      const command = text(p.command);
      return command === undefined ? undefined : { ...base, tool: "Shell", command };
    }
    case "beforeReadFile": {
      const file = absolute(text(p.file_path), cwd);
      return file === undefined ? undefined : { ...base, tool: "Read", file, access: "read" };
    }
    case "beforeMCPExecution": {
      const name = text(p.tool_name) ?? "unknown";
      return {
        ...base,
        tool: `MCP:${name}`,
        mcpServer: text(p.mcp_server_name) ?? text(p.server),
        url: text(p.url) ?? text(p.mcp_server_url),
      };
    }
    case "preToolUse": {
      const tool = text(p.tool_name);
      if (tool === undefined) return undefined;
      const input = isObject(p.tool_input) ? p.tool_input : {};
      const call: PreToolCall = {
        ...base,
        cwd: text(input.working_directory) ?? cwd,
        tool,
        toolUseId: text(p.tool_use_id),
        deferred: tool === "Shell" || tool === "Read" || tool.startsWith("MCP:"),
      };
      const command = commandOf(input);
      if (command !== undefined) return { ...call, command };
      const access = CURSOR_READ.has(tool) ? "read" : CURSOR_WRITE.has(tool) ? "write" : undefined;
      return { ...call, file: absolute(fileOf(input), call.cwd), access, url: text(input.url) };
    }
    default:
      return undefined;
  }
}

function opencode(event: string, p: Json): PreToolCall | undefined {
  const tool = text(p.tool_name);
  if (tool === undefined) return undefined;
  const input = isObject(p.tool_input) ? p.tool_input : {};
  const cwd = text(input.workdir) ?? text(p.cwd);
  const call: PreToolCall = {
    vendor: "opencode",
    event,
    sessionId: text(p.session_id),
    cwd,
    roots: text(p.cwd) ? [text(p.cwd) as string] : [],
    tool,
    toolUseId: text(p.call_id),
  };
  const command = tool === "bash" ? commandOf(input) : undefined;
  if (command !== undefined) return { ...call, command };
  const access = OPENCODE_READ.has(tool) ? "read" : OPENCODE_WRITE.has(tool) ? "write" : undefined;
  return { ...call, file: absolute(fileOf(input), cwd), access, url: text(input.url) };
}

/** The call a pre-tool payload is about, or undefined when the payload does not name one. */
export function preToolCall(agent: HookAgent, payload: Json): PreToolCall | undefined {
  const event = eventName(payload);
  if (agent === "codex-notify" || event === undefined || !isPreToolEvent(agent, payload)) {
    return undefined;
  }
  const vendor = VENDORS[agent];
  if (vendor === "cursor") return cursor(event, payload);
  if (vendor === "opencode") return opencode(event, payload);
  return claudeOrCodex(vendor, event, payload);
}

export type Answer = "allow" | "deny" | "ask";

/**
 * Claude Code permission modes in which a hook's "ask" stops the call for a person. In
 * bypassPermissions the call runs without a prompt, and in dontAsk anything that would prompt is
 * denied with no one asked, so in both a hook's ask decides nothing a person sees. A mode not
 * named here (a new one) is treated the same way: an enforced ask is never let through on a
 * guess. No mode in the payload (older versions) is the default mode.
 */
const CLAUDE_ASKING_MODES = new Set(["default", "manual", "acceptEdits", "plan", "auto"]);

/**
 * Claude Code entrypoints with a person at a prompt. Claude Code sets CLAUDE_CODE_ENTRYPOINT in
 * its own environment, which the hook inherits: "cli" for the interactive terminal (JetBrains
 * runs this too), "claude-vscode" for the VS Code extension. Print and SDK runs set "sdk-cli",
 * "sdk-ts" or "sdk-py", where a hook's ask goes to whatever host runs the session, or to no one:
 * `claude -p` in default mode runs an asked call with no person. Any other value, or none, is not
 * known to reach a person, so an enforced ask there is a deny with a one-time exception.
 */
const CLAUDE_INTERACTIVE_ENTRYPOINTS = new Set(["cli", "claude-vscode"]);

/** The variable selfhost's background runner sets for the agent and its hooks. */
export const BACKGROUND_RUN_ENV = "SELFHOST_RUN_ID";

/** A value from the session that goes into the texts: only a plain name, as the agent sends it. */
const plainName = (value: string) => (/^[A-Za-z][\w-]{0,39}$/.test(value) ? value : undefined);

const set = (value: string | undefined) => value !== undefined && value.trim() !== "";

/** Why no person is at the session, whatever the agent: a selfhost background run, or CI. */
function unattended(env: NodeJS.ProcessEnv): string | undefined {
  if (set(env[BACKGROUND_RUN_ENV])) return "is a selfhost background run, with no person to ask";
  const ci = env.CI?.trim().toLowerCase();
  if (set(env.GITHUB_ACTIONS) || (ci !== undefined && ci !== "" && ci !== "false" && ci !== "0")) {
    return "runs in CI, with no person to ask";
  }
  return undefined;
}

/**
 * Why an ask from the hook would reach no person in this session, as the rest of a sentence
 * that starts "this <agent> session"; undefined when a person is asked (or the agent cannot ask
 * from this event at all, which canAsk says).
 */
export function askSkippedBy(
  agent: HookAgent,
  mode: string | undefined,
  env: NodeJS.ProcessEnv = {},
): string | undefined {
  if (agent === "cursor") return unattended(env);
  if (agent !== "claude") return undefined;
  if (mode !== undefined && !CLAUDE_ASKING_MODES.has(mode)) {
    return `runs in ${plainName(mode) ?? "an unknown"} mode, which skips asks`;
  }
  const away = unattended(env);
  if (away) return away;
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT?.trim();
  if (entrypoint === undefined || entrypoint === "") {
    return "does not say it has a person at a prompt (no CLAUDE_CODE_ENTRYPOINT), so no one is known to be asked";
  }
  if (CLAUDE_INTERACTIVE_ENTRYPOINTS.has(entrypoint)) return undefined;
  if (entrypoint.startsWith("sdk-")) {
    return `runs without a prompt (${plainName(entrypoint) ?? "an SDK entrypoint"}, as in claude -p), with no person to ask`;
  }
  return `runs from entrypoint ${plainName(entrypoint) ?? "an unknown one"}, which is not known to have a person at a prompt`;
}

/**
 * Whether the agent can put a call to a person from this event, in this session: its permission
 * mode when the payload names one, and the environment the agent started the hook in.
 */
export function canAsk(
  agent: HookAgent,
  event: string,
  mode?: string,
  env: NodeJS.ProcessEnv = {},
): boolean {
  if (agent === "claude") return askSkippedBy(agent, mode, env) === undefined;
  if (agent === "cursor")
    return CURSOR_ASKS.has(event) && askSkippedBy(agent, mode, env) === undefined;
  return false;
}

/** Whether the agent can ask from this event in some session; canAsk says whether this one does. */
export function asksFrom(agent: HookAgent, event: string): boolean {
  if (agent === "claude") return true;
  if (agent === "cursor") return CURSOR_ASKS.has(event);
  return false;
}

/** The text that goes with an answer: what the agent reads and what the person sees. */
export interface AnswerText {
  agent: string;
  user: string;
}

/**
 * What the hook prints on stdout for a pre-tool answer, in the agent's own format, with the text
 * in the field each side reads (vendor docs as of November 2026):
 *
 * - Claude Code: a deny's permissionDecisionReason goes to the model; an ask's is shown to the
 *   person in the permission prompt. systemMessage is shown to the person.
 * - Codex: permissionDecisionReason goes to the model as the reason the call was blocked;
 *   systemMessage is shown as a warning in the UI.
 * - Cursor: agent_message goes to the agent, user_message to the person. beforeReadFile has no
 *   agent_message.
 * - OpenCode: the plugin throws `reason`, which the model gets as the tool's error and the person
 *   sees on the call.
 *
 * Allow prints nothing where the agent reads silence as "no opinion" (Claude Code, Codex), so
 * selfhost never approves a call the agent would otherwise ask about; with a text for the person
 * (an exception used) it prints only systemMessage, which decides nothing. Cursor needs a JSON
 * answer on every permission hook: silence blocks the action there.
 */
export function answerText(
  agent: HookAgent,
  event: string,
  answer: Answer,
  text?: AnswerText,
): string {
  if (agent === "claude" || agent === "codex") {
    if (answer === "allow") return text ? JSON.stringify({ systemMessage: text.user }) : "";
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: answer,
        permissionDecisionReason: (answer === "ask" ? text?.user : text?.agent) ?? "",
      },
      ...(answer === "deny" && text ? { systemMessage: text.user } : {}),
    });
  }
  if (agent === "cursor") {
    if (answer === "allow") return JSON.stringify({ permission: "allow" });
    // beforeReadFile's answer has no agent_message.
    const messages =
      event === "beforeReadFile"
        ? { user_message: text?.user ?? "" }
        : { user_message: text?.user ?? "", agent_message: text?.agent ?? "" };
    return JSON.stringify({ permission: answer, ...messages });
  }
  if (agent === "opencode") {
    return JSON.stringify(
      answer === "allow" ? { decision: "allow" } : { decision: answer, reason: text?.agent },
    );
  }
  return "";
}

/** What the hook prints for an event that is not a pre-tool event; most need nothing. */
export function otherEventText(agent: HookAgent, payload: Json): string {
  if (agent !== "cursor") return "";
  return CURSOR_ANSWERS[eventName(payload) ?? ""] ?? "";
}

/** The answer when the check could not run: the call goes ahead (fail open). */
export function failOpenText(agent: HookAgent, payload: Json): string {
  const event = eventName(payload) ?? "";
  return isPreToolEvent(agent, payload) ? answerText(agent, event, "allow") : "";
}

/** Payload fields never spooled: tool output and file contents. The ledger reads neither. */
export const DROPPED_FIELDS = ["tool_response", "tool_output", "output", "content", "attachments"];
