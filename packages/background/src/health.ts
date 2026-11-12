import type { RunHealth, RunStuckReason } from "@selfhost/schema";

/** A tool call read from an agent's JSON output. */
export interface SeenToolCall {
  /** The agent's own id for the call, when it gives one, so a call reported twice counts once. */
  id?: string;
  name: string;
  /** Tool name and input, normalized: two identical calls have the same key. */
  key: string;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const call = (name: unknown, input: unknown, id?: unknown): SeenToolCall | undefined => {
  if (typeof name !== "string" || name === "") return undefined;
  return {
    ...(typeof id === "string" && id ? { id } : {}),
    name,
    key: `${name} ${stable(input ?? null)}`,
  };
};

/**
 * The tool calls in one line of agent output. It reads the JSON lines Claude Code
 * (`--output-format stream-json`), Codex (`exec --json`), OpenCode (`run --format json`) and
 * Goose (`--output-format stream-json`) print; anything else is no call.
 */
export function toolCallsIn(line: string): SeenToolCall[] {
  const text = line.trim();
  if (!text.startsWith("{")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObject(parsed)) return [];
  const found: SeenToolCall[] = [];
  const push = (seen: SeenToolCall | undefined) => {
    if (seen) found.push(seen);
  };
  // Claude Code: assistant messages carry tool_use blocks.
  const message = isObject(parsed.message) ? parsed.message : undefined;
  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (!isObject(block)) continue;
      if (block.type === "tool_use") push(call(block.name, block.input, block.id));
      // Goose: toolRequest blocks with the call under toolCall.value.
      if (block.type === "toolRequest" && isObject(block.toolCall)) {
        const value = isObject(block.toolCall.value) ? block.toolCall.value : {};
        push(call(value.name, value.arguments, block.id));
      }
    }
  }
  // Codex: one item per command, MCP call or file change, reported when it starts and ends.
  if (isObject(parsed.item) && typeof parsed.type === "string" && parsed.type.startsWith("item.")) {
    const item = parsed.item;
    if (item.type === "command_execution") push(call("shell", item.command, item.id));
    if (item.type === "mcp_tool_call")
      push(call(`${item.server}:${item.tool}`, item.arguments, item.id));
    if (item.type === "file_change") push(call("apply_patch", item.changes, item.id));
  }
  // OpenCode: tool parts with the input in state.
  if (parsed.type === "tool_use" && isObject(parsed.part)) {
    const part = parsed.part;
    const state = isObject(part.state) ? part.state : {};
    push(call(part.tool, state.input, part.callID ?? part.id));
  }
  return found;
}

export interface HealthOptions {
  stallMinutes: number;
  loopRepeats: number;
  /** When the agent started, so a silent start counts as quiet time. */
  startedAt: Date;
}

const minutes = (ms: number) => Math.floor(ms / 60_000);

/**
 * Run health for one agent process: when it last printed anything, when the sandbox last
 * answered, and how many identical tool calls it made in a row. `check` says whether to stop it.
 */
export class HealthMonitor {
  private lastOutput: Date | undefined;
  private heartbeat: Date | undefined;
  private lastKey: string | undefined;
  private lastTool: string | undefined;
  private repeats = 0;
  private readonly seenIds = new Set<string>();
  private buffer = "";

  constructor(private readonly options: HealthOptions) {}

  /** A chunk of output, which may hold several lines or part of one. */
  output(text: string, at: Date): void {
    if (text.length > 0) this.lastOutput = at;
    this.buffer += text;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  private line(line: string): void {
    for (const seen of toolCallsIn(line)) {
      if (seen.id) {
        if (this.seenIds.has(seen.id)) continue;
        this.seenIds.add(seen.id);
      }
      if (seen.key === this.lastKey) this.repeats += 1;
      else {
        this.lastKey = seen.key;
        this.lastTool = seen.key.length > 120 ? `${seen.key.slice(0, 117)}...` : seen.key;
        this.repeats = 1;
      }
    }
  }

  /** The sandbox answered a liveness check. */
  beat(at: Date): void {
    this.heartbeat = at;
  }

  check(at: Date): RunHealth & { stop?: RunStuckReason } {
    const base = {
      heartbeat_at: this.heartbeat?.toISOString() ?? null,
      last_output_at: this.lastOutput?.toISOString() ?? null,
      ...(this.repeats > 1 ? { repeats: this.repeats } : {}),
      ...(this.repeats > 1 && this.lastTool ? { tool: this.lastTool } : {}),
    };
    if (this.repeats >= this.options.loopRepeats) {
      return {
        ...base,
        status: "stuck",
        reason: "loop",
        stop: "loop",
        line: `stopped: the same tool call ${this.repeats} times in a row`,
      };
    }
    const since = this.lastOutput ?? this.options.startedAt;
    const idle = at.getTime() - since.getTime();
    if (idle >= this.options.stallMinutes * 60_000) {
      return {
        ...base,
        status: "stuck",
        reason: "no_output",
        stop: "no_output",
        line: `stopped: no output for ${minutes(idle)}m`,
      };
    }
    if (idle >= 2 * 60_000)
      return { ...base, status: "quiet", line: `quiet for ${minutes(idle)}m` };
    return { ...base, status: "ok", line: this.lastOutput ? "working" : "starting" };
  }

  /**
   * Health once the agent is done and nothing stopped it for its health: a run that finished
   * before the first watchdog pass would otherwise keep showing "starting".
   */
  finished(): RunHealth {
    return {
      heartbeat_at: this.heartbeat?.toISOString() ?? null,
      last_output_at: this.lastOutput?.toISOString() ?? null,
      status: "ok",
      line: "finished",
    };
  }

  /** The sandbox stopped answering. */
  lost(at: Date): RunHealth & { stop: RunStuckReason } {
    return {
      heartbeat_at: this.heartbeat?.toISOString() ?? null,
      last_output_at: this.lastOutput?.toISOString() ?? null,
      status: "lost",
      reason: "sandbox_lost",
      stop: "sandbox_lost",
      line: `the sandbox stopped answering at ${at.toISOString().slice(11, 16)} UTC`,
    };
  }
}
