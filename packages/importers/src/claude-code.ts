import { basename } from "node:path";
import { type Actor, claudeCodeRequestType } from "@selfhost/schema";
import { agentActor, buildEvent, isoTimestamp, SESSION_IDLE_MS } from "./events.js";
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
  type ClaudeUsageEntry,
  claudeAdvisorUsages,
  claudeCacheCreationTokens,
  claudeUsageDedupeKey,
  claudeUsageEntry,
  claudeUsageTotal,
} from "./vendor/ccusage/claude.js";
import { type ClaudeTokenUsage, claudeCostUsd } from "./vendor/ccusage/pricing.js";

type Json = Record<string, unknown>;

const VENDOR = "claude_code";

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

interface SessionState {
  firstTs: string;
  lastTs: string;
  version?: string;
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  startEmitted: boolean;
  /** lastTs at which session.ended was last emitted. */
  endedAt?: string;
  /** Explicit SessionEnd hook seen at this timestamp. */
  endMarkerAt?: string;
}

interface PendingCost {
  scope: string;
  identity: string;
  ts: string;
  sessionId: string;
  version?: string;
  model: string;
  usage: ClaudeTokenUsage;
  costUsd?: number;
  replay?: { group: string; sidechain: boolean };
  /** id of the transcript's api-request line for this response. */
  requestRef?: string;
  sidechain: boolean;
  /** First response in its thread after an API error. */
  retry: boolean;
}

interface UsageRecord {
  /** Appended to the dedupe identity: advisor iterations are priced separately. */
  suffix: string;
  model?: string;
  usage: ClaudeTokenUsage;
  costUsd?: number;
}

interface PendingCommit {
  sessionId: string;
  version?: string;
  model?: string;
  details: ToolDetails;
}

const SAFE_INPUT_KEYS = ["file_path", "path", "url", "pattern", "query", "description", "command"];

/** Summary and target for a Claude Code tool call. Never file contents or full commands. */
export function claudeToolDetails(name: string, input: unknown, cwd: string | undefined) {
  const args = isObject(input) ? input : {};
  switch (name) {
    case "Bash": {
      const command = str(args.command);
      return toolDetails(command, "command", { command });
    }
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "NotebookRead": {
      const path = str(args.file_path) ?? str(args.notebook_path);
      return toolDetails(path === undefined ? undefined : displayPath(path, cwd), "file");
    }
    case "Glob":
    case "Grep":
      return toolDetails(str(args.pattern), undefined);
    case "WebFetch":
      return toolDetails(str(args.url), "url");
    case "WebSearch":
      return toolDetails(str(args.query), undefined);
    case "Task":
    case "Agent":
      return toolDetails(str(args.description), undefined, { prefix: str(args.subagent_type) });
    default: {
      if (name.startsWith("mcp__")) return toolDetails(undefined, undefined);
      const key = SAFE_INPUT_KEYS.find((candidate) => str(args[candidate]) !== undefined);
      return toolDetails(key === undefined ? undefined : str(args[key]), undefined);
    }
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isObject(block) && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

function promptText(line: Json): string | undefined {
  if (line.type !== "user" || line.isMeta === true || line.isCompactSummary === true) return;
  const message = isObject(line.message) ? line.message : undefined;
  const content = message?.content;
  if (typeof content === "string") return content.trim() === "" ? undefined : content;
  if (!Array.isArray(content)) return undefined;
  if (content.some((block) => !isObject(block) || block.type !== "text")) return undefined;
  const text = textOf(content);
  return text.trim() === "" ? undefined : text;
}

/** The main thread or one subagent of a session; retries are tracked per thread. */
function threadKey(line: Json, sessionId: string): string {
  const agent = str(line.agentId) ?? (line.isSidechain === true ? "sidechain" : "");
  return `${sessionId}\n${agent}`;
}

/** Maps Claude Code transcript lines (`~/.claude/projects/<project>/<session>.jsonl`). */
export class ClaudeCodeMapper implements LineMapper {
  private readonly sessions = new Map<string, SessionState>();
  private readonly pendingCosts = new Map<string, PendingCost>();
  private readonly emittedCosts = new Set<string>();
  private readonly pendingCommits = new Map<string, PendingCommit>();
  /** querySource of each api-request line, by its id. */
  private readonly querySources = new Map<string, string>();
  /** Threads whose last API call failed, so their next response is a retry. */
  private readonly failedThreads = new Set<string>();
  private readonly fileSessionId: string;
  private readonly person: Actor;

  constructor(private readonly ctx: MapContext) {
    this.fileSessionId = basename(ctx.path, ".jsonl");
    this.person = ctx.person;
  }

  line(line: Json): ParsedEvent[] {
    if (line.type === "api-request") {
      const id = str(line.id);
      const source = str(line.querySource);
      if (id && source) this.querySources.set(id, source);
    }
    const ts = isoTimestamp(line.timestamp);
    if (!ts) return [];
    const sessionId = str(line.sessionId) ?? this.fileSessionId;
    const sidechain = line.isSidechain === true;
    const version = str(line.version);
    if (!sidechain) this.track(sessionId, ts, line, version);
    const out: ParsedEvent[] = [];
    if (line.type === "assistant") this.assistant(line, ts, sessionId, version, sidechain, out);
    if (line.type === "user") this.user(line, ts, sessionId, version, sidechain, out);
    if (line.type === "system" && line.subtype === "api_error") {
      this.failedThreads.add(threadKey(line, sessionId));
    }
    return out;
  }

  flush(now: number): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (!session.startEmitted) {
        session.startEmitted = true;
        const data = {
          ...(session.cwd ? { cwd: session.cwd } : {}),
          ...(session.gitBranch ? { git_branch: session.gitBranch } : {}),
          ...(session.entrypoint ? { entrypoint: session.entrypoint } : {}),
        };
        out.push(
          this.event({
            kind: "session.started",
            scope: sessionId,
            identity: "start",
            ts: session.firstTs,
            sessionId,
            actor: this.person,
            version: session.version,
            fields: Object.keys(data).length > 0 ? { data } : {},
          }),
        );
      }
      const ended =
        session.endMarkerAt === session.lastTs ||
        now - Date.parse(session.lastTs) > SESSION_IDLE_MS;
      if (ended && session.endedAt !== session.lastTs) {
        session.endedAt = session.lastTs;
        out.push(
          this.event({
            kind: "session.ended",
            scope: sessionId,
            identity: "end",
            ts: session.lastTs,
            sessionId,
            actor: this.person,
            version: session.version,
            keep: "last",
          }),
        );
      }
    }
    for (const [key, cost] of this.pendingCosts) {
      this.emittedCosts.add(key);
      out.push(this.costEvent(cost));
    }
    this.pendingCosts.clear();
    return out;
  }

  private event(input: EventInput): ParsedEvent {
    return buildEvent(VENDOR, input);
  }

  private track(sessionId: string, ts: string, line: Json, version: string | undefined) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { firstTs: ts, lastTs: ts, startEmitted: false };
      this.sessions.set(sessionId, session);
    }
    if (ts < session.firstTs) session.firstTs = ts;
    if (ts > session.lastTs) session.lastTs = ts;
    session.version = version ?? session.version;
    session.cwd ??= str(line.cwd);
    session.gitBranch ??= str(line.gitBranch);
    session.entrypoint ??= str(line.entrypoint);
    const attachment = isObject(line.attachment) ? line.attachment : undefined;
    if (attachment?.hookEvent === "SessionEnd") session.endMarkerAt = ts;
  }

  private assistant(
    line: Json,
    ts: string,
    sessionId: string,
    version: string | undefined,
    sidechain: boolean,
    out: ParsedEvent[],
  ) {
    const message = isObject(line.message) ? line.message : {};
    const reported = str(message.model);
    const model = reported === "<synthetic>" ? undefined : reported;
    const entry = claudeUsageEntry(line);
    const thread = threadKey(line, sessionId);
    if (entry) {
      const records: UsageRecord[] = [
        { suffix: "", model: entry.model, usage: entry.usage, costUsd: entry.costUsd },
        ...claudeAdvisorUsages(line).map((advisor, index) => ({
          suffix: `:advisor:${index}`,
          model: advisor.model,
          usage: advisor.usage,
        })),
      ];
      const request = {
        requestRef: str(line.requestRef),
        sidechain,
        retry: this.failedThreads.has(thread),
      };
      if (this.addUsageRecords(entry, ts, sessionId, version, records, request)) {
        this.failedThreads.delete(thread);
      }
    }
    if (line.isApiErrorMessage === true) this.failedThreads.add(thread);
    if (!Array.isArray(message.content)) return;
    const cwd = str(line.cwd) ?? this.sessions.get(sessionId)?.cwd;
    for (const block of message.content) {
      if (!isObject(block) || block.type !== "tool_use") continue;
      const id = str(block.id);
      const name = str(block.name);
      if (!id || !name) continue;
      const details = claudeToolDetails(name, block.input, cwd);
      out.push(
        this.event({
          kind: "tool.called",
          scope: "",
          identity: id,
          ts,
          sessionId,
          actor: agentActor(VENDOR, sessionId),
          version,
          model,
          fields: {
            ...toolFields(name, details),
            ...(sidechain ? { data: { sidechain: true } } : {}),
          },
        }),
      );
      if (name === "Bash" && isGitCommitCommand(details.command)) {
        this.pendingCommits.set(id, { sessionId, version, model, details });
      }
    }
  }

  /** Buffers each usage record once; true when a new response was buffered. */
  private addUsageRecords(
    entry: ClaudeUsageEntry,
    ts: string,
    sessionId: string,
    version: string | undefined,
    records: UsageRecord[],
    request: Pick<PendingCost, "requestRef" | "sidechain" | "retry">,
  ): boolean {
    let added = false;
    for (const record of records) {
      if (!record.model || record.model === "<synthetic>") continue;
      if (claudeUsageTotal(record.usage) === 0) continue;
      const base = entry.messageId
        ? claudeUsageDedupeKey(entry.messageId, entry.requestId, sessionId, ts)
        : { scope: sessionId, identity: `line@${ts}` };
      const identity = `${base.identity}${record.suffix}`;
      const key = `${base.scope}\n${identity}`;
      if (this.emittedCosts.has(key)) continue;
      const replay =
        entry.messageId && record.suffix === ""
          ? { group: `${sessionId}\n${entry.messageId}`, sidechain: entry.isSidechain }
          : undefined;
      const existing = this.pendingCosts.get(key);
      if (existing) {
        // Keep the line with the most tokens, but the first line's timestamp, so the id is
        // stable however the lines of one response are split across reads.
        if (claudeUsageTotal(record.usage) > claudeUsageTotal(existing.usage)) {
          existing.usage = record.usage;
          existing.costUsd = record.costUsd;
        }
        continue;
      }
      this.pendingCosts.set(key, {
        scope: base.scope,
        identity,
        ts,
        sessionId,
        version,
        model: record.model,
        usage: record.usage,
        costUsd: record.costUsd,
        replay,
        ...request,
      });
      added = true;
    }
    return added;
  }

  private costEvent(cost: PendingCost): ParsedEvent {
    const estimated = claudeCostUsd(cost.model, cost.usage);
    const usd = cost.costUsd ?? estimated ?? 0;
    const source =
      cost.requestRef === undefined ? undefined : this.querySources.get(cost.requestRef);
    const requestType = cost.retry
      ? "retry"
      : (claudeCodeRequestType(source, { subagent: cost.sidechain }) ?? "main");
    const data = {
      request_type: requestType,
      ...(source ? { request_source: source } : {}),
      ...(cost.usage.fast ? { speed: "fast" } : {}),
      ...(cost.costUsd === undefined && estimated === undefined ? { unpriced: true } : {}),
    };
    const parsed = this.event({
      kind: "cost.recorded",
      scope: cost.scope,
      identity: cost.identity,
      ts: cost.ts,
      sessionId: cost.sessionId,
      actor: this.person,
      version: cost.version,
      model: cost.model,
      fields: {
        cost: {
          input_tokens: cost.usage.inputTokens,
          output_tokens: cost.usage.outputTokens,
          cache_read_tokens: cost.usage.cacheReadTokens,
          cache_write_tokens: claudeCacheCreationTokens(cost.usage),
          usd,
          estimated: cost.costUsd === undefined,
        },
        data,
      },
    });
    return cost.replay ? { ...parsed, replay: cost.replay } : parsed;
  }

  private user(
    line: Json,
    ts: string,
    sessionId: string,
    version: string | undefined,
    sidechain: boolean,
    out: ParsedEvent[],
  ) {
    const message = isObject(line.message) ? line.message : {};
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isObject(block) || block.type !== "tool_result") continue;
        const id = str(block.tool_use_id);
        const pending = id === undefined ? undefined : this.pendingCommits.get(id);
        if (!id || !pending) continue;
        this.pendingCommits.delete(id);
        if (block.is_error === true) continue;
        const result = isObject(line.toolUseResult) ? line.toolUseResult : {};
        const output = `${textOf(block.content)}\n${typeof result.stdout === "string" ? result.stdout : ""}`;
        for (const commit of commitsFromOutput(output)) {
          out.push(
            this.event({
              kind: "commit.created",
              scope: "",
              identity: `${id}:${commit.sha}`,
              ts,
              sessionId: pending.sessionId,
              actor: agentActor(VENDOR, pending.sessionId),
              version: pending.version,
              model: pending.model,
              fields: {
                ...toolFields("Bash", pending.details),
                links: { commit_sha: commit.sha },
                ...(commit.branch ? { data: { branch: commit.branch } } : {}),
              },
            }),
          );
        }
      }
    }
    const text = promptText(line);
    // A new prompt after an error is the person's next request, not a retry.
    if (text !== undefined) this.failedThreads.delete(threadKey(line, sessionId));
    if (!this.ctx.logPrompts || sidechain) return;
    const uuid = str(line.uuid);
    if (text === undefined || !uuid) return;
    const prompt = promptData(text);
    out.push(
      this.event({
        kind: "prompt.submitted",
        scope: "",
        identity: uuid,
        ts,
        sessionId,
        actor: this.person,
        version,
        fields: { data: prompt.data, ...(prompt.masked ? { redacted: ["data.prompt"] } : {}) },
      }),
    );
  }
}
