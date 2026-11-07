import { basename } from "node:path";
import type { Actor } from "@selfhost/schema";
import { agentActor, buildEvent, isoTimestamp, SESSION_IDLE_MS } from "./events.js";
import { shortHash } from "./ids.js";
import {
  commitsFromOutput,
  displayPath,
  isGitCommitCommand,
  promptData,
  type ToolDetails,
  toolDetails,
  toolFields,
} from "./summary.js";
import type { EventInput, LineMapper, MapContext, ParsedEvent } from "./types.js";
import {
  type CodexUsageEvent,
  type CodexUsageState,
  codexUsageEvents,
  newCodexUsageState,
} from "./vendor/ccusage/codex.js";
import { codexCostUsd } from "./vendor/ccusage/pricing.js";

type Json = Record<string, unknown>;

const VENDOR = "codex";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parseJson(value: unknown): Json {
  if (isObject(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** owner/name from a GitHub, GitLab or similar remote URL. */
export function repoFromRemote(url: string | undefined): string | undefined {
  const match = url?.match(/[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function shellCommand(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.every((part) => typeof part === "string")) return undefined;
  const [shell, flag, script] = value as string[];
  // ["bash", "-lc", "<script>"] runs the script.
  if (value.length === 3 && /(^|\/)(ba|z)?sh$/.test(shell ?? "") && flag?.startsWith("-")) {
    return script;
  }
  return value.join(" ");
}

const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;

function patchDetails(patch: string, cwd: string | undefined): ToolDetails {
  const files = [...patch.matchAll(PATCH_FILE)];
  const first = files[0];
  if (!first?.[1] || !first[2]) return toolDetails(undefined, undefined);
  const path = displayPath(first[2].trim(), cwd);
  const more = files.length > 1 ? ` (+${files.length - 1} more)` : "";
  const details = toolDetails(path, "file");
  return { ...details, summary: `${first[1].toLowerCase()} ${details.summary ?? path}${more}` };
}

const SAFE_ARG_KEYS = ["path", "file_path", "url", "query", "pattern", "description"];

/** Summary and target for a Codex tool call. Never patch bodies or full scripts. */
export function codexToolDetails(name: string, args: Json, cwd: string | undefined): ToolDetails {
  switch (name) {
    case "exec_command":
    case "shell":
    case "local_shell":
    case "container.exec": {
      const command = shellCommand(args.cmd ?? args.command);
      return toolDetails(command, "command", { command });
    }
    case "apply_patch":
      return patchDetails(str(args.input) ?? str(args.patch) ?? "", cwd);
    case "view_image": {
      const path = str(args.path);
      return toolDetails(path === undefined ? undefined : displayPath(path, cwd), "file");
    }
    case "write_stdin":
    case "update_plan":
      return toolDetails(undefined, undefined);
    default: {
      if (name.startsWith("mcp__")) return toolDetails(undefined, undefined);
      const key = SAFE_ARG_KEYS.find((candidate) => str(args[candidate]) !== undefined);
      return toolDetails(key === undefined ? undefined : str(args[key]), undefined);
    }
  }
}

interface PendingCommit {
  name: string;
  model?: string;
  details: ToolDetails;
}

function exitCode(output: unknown): number | undefined {
  const parsed = parseJson(output);
  const metadata = isObject(parsed.metadata) ? parsed.metadata : undefined;
  if (typeof metadata?.exit_code === "number") return metadata.exit_code;
  const text = typeof output === "string" ? output : "";
  const match = text.match(/(?:Process exited with code|Exit code:?)\s*(-?\d+)/);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function outputText(output: unknown): string {
  const parsed = parseJson(output);
  if (typeof parsed.output === "string") return parsed.output;
  return typeof output === "string" ? output : "";
}

/** Maps Codex rollouts (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). */
export class CodexMapper implements LineMapper {
  private sessionId: string;
  private version?: string;
  private cwd?: string;
  private repo?: string;
  private originator?: string;
  private firstTs?: string;
  private lastTs?: string;
  private metaSeen = false;
  private startEmitted = false;
  private endedAt?: string;
  private readonly usage: CodexUsageState = newCodexUsageState();
  private readonly pendingCommits = new Map<string, PendingCommit>();
  private readonly person: Actor;

  constructor(private readonly ctx: MapContext) {
    this.sessionId = basename(ctx.path).match(UUID)?.[0] ?? basename(ctx.path, ".jsonl");
    this.person = ctx.person;
  }

  line(line: Json): ParsedEvent[] {
    const ts = isoTimestamp(line.timestamp);
    if (!ts) return [];
    const payload = isObject(line.payload) ? line.payload : {};
    if (line.type === "session_meta") this.meta(payload);
    if (this.firstTs === undefined || ts < this.firstTs) this.firstTs = ts;
    if (this.lastTs === undefined || ts > this.lastTs) this.lastTs = ts;
    const out: ParsedEvent[] = [];
    for (const usage of codexUsageEvents(line, this.usage)) out.push(this.costEvent(usage));
    if (line.type === "response_item") this.responseItem(payload, ts, out);
    if (line.type === "event_msg") this.eventMsg(payload, ts, out);
    return out;
  }

  flush(now: number): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    if (!this.firstTs || !this.lastTs) return out;
    if (!this.startEmitted) {
      this.startEmitted = true;
      const data = {
        ...(this.cwd ? { cwd: this.cwd } : {}),
        ...(this.originator ? { originator: this.originator } : {}),
      };
      out.push(
        this.event({
          kind: "session.started",
          scope: this.sessionId,
          identity: "start",
          ts: this.firstTs,
          actor: this.person,
          fields: Object.keys(data).length > 0 ? { data } : {},
        }),
      );
    }
    if (now - Date.parse(this.lastTs) > SESSION_IDLE_MS && this.endedAt !== this.lastTs) {
      this.endedAt = this.lastTs;
      out.push(
        this.event({
          kind: "session.ended",
          scope: this.sessionId,
          identity: "end",
          ts: this.lastTs,
          actor: this.person,
          keep: "last",
        }),
      );
    }
    return out;
  }

  private event(input: Omit<EventInput, "sessionId" | "version">): ParsedEvent {
    return buildEvent(VENDOR, {
      ...input,
      sessionId: this.sessionId,
      version: this.version,
      fields: { ...(this.repo ? { repo: this.repo } : {}), ...input.fields },
    });
  }

  private meta(payload: Json) {
    if (this.metaSeen) return;
    this.metaSeen = true;
    this.sessionId = str(payload.id) ?? str(payload.session_id) ?? this.sessionId;
    this.version = str(payload.cli_version);
    this.cwd = str(payload.cwd);
    this.originator = str(payload.originator);
    const git = isObject(payload.git) ? payload.git : {};
    this.repo = repoFromRemote(str(git.repository_url));
  }

  private costEvent(usage: CodexUsageEvent): ParsedEvent {
    const raw = usage.usage;
    const usd = codexCostUsd(usage.model, raw, usage.serviceTier);
    const identity = usage.responseId
      ? `response:${usage.responseId}`
      : `${usage.timestamp}:${raw.inputTokens}:${raw.cachedInputTokens}:${raw.outputTokens}:${raw.reasoningOutputTokens}:${raw.totalTokens}`;
    const data = {
      reasoning_output_tokens: raw.reasoningOutputTokens,
      ...(usage.serviceTier && usage.serviceTier !== "standard"
        ? { service_tier: usage.serviceTier }
        : {}),
      ...(usage.isFallbackModel ? { fallback_model: true } : {}),
      ...(usage.responseId ? { compaction: true } : {}),
      ...(usd === undefined ? { unpriced: true } : {}),
    };
    return this.event({
      kind: "cost.recorded",
      // Forked and subagent rollouts replay their parent's lines verbatim; a global scope
      // makes the copies collapse onto the parent's ids.
      scope: "",
      identity,
      ts: isoTimestamp(usage.timestamp) ?? usage.timestamp,
      actor: this.person,
      model: usage.model,
      fields: {
        cost: {
          input_tokens: Math.max(
            0,
            raw.inputTokens - raw.cachedInputTokens - raw.cacheCreationTokens,
          ),
          output_tokens: raw.outputTokens,
          cache_read_tokens: raw.cachedInputTokens,
          cache_write_tokens: raw.cacheCreationTokens,
          usd: usd ?? 0,
          estimated: true,
        },
        data,
      },
    });
  }

  private responseItem(payload: Json, ts: string, out: ParsedEvent[]) {
    const type = payload.type;
    const callId = str(payload.call_id) ?? str(payload.id);
    if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") {
      const name = str(payload.name) ?? (type === "local_shell_call" ? "local_shell" : undefined);
      if (!name || !callId) return;
      const args =
        type === "custom_tool_call"
          ? { input: payload.input }
          : type === "local_shell_call"
            ? { command: isObject(payload.action) ? payload.action.command : undefined }
            : parseJson(payload.arguments);
      const details = codexToolDetails(name, args, this.cwd);
      const model = this.usage.currentModel;
      out.push(
        this.event({
          kind: "tool.called",
          scope: "",
          identity: callId,
          ts,
          actor: agentActor(VENDOR, this.sessionId),
          model,
          fields: toolFields(name, details),
        }),
      );
      if (isGitCommitCommand(details.command)) {
        this.pendingCommits.set(callId, { name, model, details });
      }
      return;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      if (callId) {
        const ok = exitCode(payload.output) === 0;
        this.commit(callId, ok ? outputText(payload.output) : undefined, ts, out);
      }
    }
  }

  private eventMsg(payload: Json, ts: string, out: ParsedEvent[]) {
    if (payload.type === "exec_command_end") {
      const callId = str(payload.call_id);
      if (callId) {
        const text = [payload.stdout, payload.aggregated_output, payload.formatted_output]
          .filter((part): part is string => typeof part === "string")
          .join("\n");
        this.commit(callId, payload.exit_code === 0 ? text : undefined, ts, out);
      }
      return;
    }
    if (payload.type !== "user_message" || !this.ctx.logPrompts) return;
    const text = str(payload.message);
    if (!text || text.trim() === "") return;
    const prompt = promptData(text);
    out.push(
      this.event({
        kind: "prompt.submitted",
        scope: "",
        identity: `${ts}:${shortHash(text)}`,
        ts,
        actor: this.person,
        model: this.usage.currentModel,
        fields: { data: prompt.data, ...(prompt.masked ? { redacted: ["data.prompt"] } : {}) },
      }),
    );
  }

  /** Resolves a pending git commit call; `output` is undefined when the command failed. */
  private commit(callId: string, output: string | undefined, ts: string, out: ParsedEvent[]) {
    const pending = this.pendingCommits.get(callId);
    if (!pending) return;
    this.pendingCommits.delete(callId);
    if (output === undefined) return;
    for (const commit of commitsFromOutput(output)) {
      out.push(
        this.event({
          kind: "commit.created",
          scope: "",
          identity: `${callId}:${commit.sha}`,
          ts,
          actor: agentActor(VENDOR, this.sessionId),
          model: pending.model,
          fields: {
            ...toolFields(pending.name, pending.details),
            links: { commit_sha: commit.sha },
            ...(commit.branch ? { data: { branch: commit.branch } } : {}),
          },
        }),
      );
    }
  }
}
