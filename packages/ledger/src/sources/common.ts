import { createHash } from "node:crypto";
import {
  type Actor,
  type AgentRef,
  type AgentVendor,
  type Cost,
  EVENT_SCHEMA,
  type EventKind,
  type EventSource,
  type FieldError,
  type LedgerEvent,
} from "@selfhost/schema";

/**
 * Event schema versions the source mappers (hooks, OpenTelemetry, gateway and vendor audit logs)
 * write, newest first. Each must be one the ledger accepts.
 */
export const SOURCE_EVENT_SCHEMAS: readonly string[] = [EVENT_SCHEMA];

/** What a source payload does not say about itself, supplied by the caller. */
export interface SourceContext {
  /**
   * actor.id of the person the agent works for, usually an email. Used when the payload has no
   * user of its own. Without one, the agent session is the actor.
   */
  person?: string;
  personName?: string;
  /** Event time for payloads that carry none, such as hook payloads. Default: now. */
  ts?: string;
  /** Agent CLI version, when the payload does not report it. */
  agentVersion?: string;
  repo?: string;
  org?: string;
  team?: string;
  /** Keep prompt text (ledger.log_prompts in selfhost.toml). Off by default. */
  logPrompts?: boolean;
  /** USD for token counts, when the source reports none. Without it usd is 0 and data.unpriced is true. */
  price?: (model: string | undefined, tokens: TokenCounts) => number | undefined;
}

export type TokenCounts = Omit<Cost, "usd" | "estimated">;

/** Thrown when a payload does not match the shape its source sends. */
export class SourcePayloadError extends Error {
  override name = "SourcePayloadError";
  readonly errors: FieldError[];

  constructor(source: string, errors: FieldError[]) {
    const first = errors[0];
    super(`Invalid ${source} payload${first ? `: ${first.field}: ${first.message}` : ""}`);
    this.errors = errors;
  }
}

export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function count(value: unknown): number {
  const n = num(value);
  return n === undefined || n < 0 ? 0 : Math.round(n);
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * A UUIDv7 derived from the event time and a key, so mapping the same source record twice gives
 * the same id and the ledger stores it once.
 */
export function stableEventId(ts: string, key: string): string {
  const ms = Date.parse(ts);
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 2 ** 48 - 1) : 0, 0, 6);
  createHash("sha256").update(key).digest().copy(bytes, 6, 0, 10);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const SUMMARY_MAX = 200;

/** First SUMMARY_MAX characters of a single-line version of text. */
export function summarize(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 3)}...` : flat;
}

export function toIso(ms: number): string | undefined {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function personOrAgent(
  ctx: SourceContext,
  vendor: AgentVendor,
  sessionId: string | undefined,
  person?: string,
): Actor {
  if (person) return { kind: "person", id: person };
  if (ctx.person) {
    return { kind: "person", id: ctx.person, ...(ctx.personName ? { name: ctx.personName } : {}) };
  }
  return { kind: "agent", id: `${vendor}:session:${sessionId ?? "unknown"}` };
}

export function agentRef(vendor: AgentVendor, version?: string, name?: string): AgentRef {
  return { vendor, ...(version ? { version } : {}), ...(name ? { name } : {}) };
}

export function detectVendor(text: string | undefined): AgentVendor | undefined {
  if (!text) return undefined;
  const value = text.toLowerCase();
  if (/claude[-_ ]?(?:cli|code)/.test(value)) return "claude_code";
  if (value.includes("codex")) return "codex";
  if (value.includes("opencode")) return "opencode";
  if (value.includes("goose")) return "goose";
  if (value.includes("cursor")) return "cursor";
  if (value.includes("copilot")) return "copilot";
  return undefined;
}

/** Cost from reported USD, else from ctx.price, else 0 with unpriced set. */
export function costFrom(
  ctx: SourceContext,
  model: string | undefined,
  tokens: TokenCounts,
  usd?: number,
): { cost: Cost; unpriced: boolean } {
  const value = usd ?? ctx.price?.(model, tokens);
  const priced = value !== undefined && Number.isFinite(value) && value >= 0;
  return { cost: { ...tokens, usd: priced ? value : 0, estimated: true }, unpriced: !priced };
}

const FILE_KEYS = ["file_path", "notebook_path", "path"] as const;
const COMMAND_KEYS = ["command", "cmd", "bash_command", "full_command"] as const;

function relativeTo(cwd: string | undefined, path: string): string {
  if (cwd && path.startsWith(`${cwd.replace(/\/+$/, "")}/`))
    return path.slice(cwd.length).replace(/^\/+/, "");
  return path;
}

/** Files named in a Codex apply_patch body, as "A path", "M path" or "D path". */
function patchFiles(patch: string): string[] {
  const ops: Record<string, string> = { Add: "A", Update: "M", Delete: "D" };
  return [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map(
    (m) => `${ops[m[1] ?? ""] ?? "M"} ${m[2]?.trim()}`,
  );
}

/**
 * tool and target for a tool call: the command for shell tools, the file for file tools, the URL
 * for fetch tools. Inputs are summarized, never stored in full.
 */
export function toolDetails(
  name: string,
  input: unknown,
  cwd?: string,
): Pick<LedgerEvent, "tool" | "target"> {
  if (typeof input === "string") {
    const value = summarize(input);
    return value
      ? { tool: { name, input_summary: value }, target: { type: "command", value } }
      : { tool: { name } };
  }
  if (!isObject(input)) return { tool: { name } };
  for (const key of COMMAND_KEYS) {
    const command = str(input[key]);
    if (!command) continue;
    if (command.startsWith("*** Begin Patch")) {
      const files = patchFiles(command).map(
        (f) => `${f.slice(0, 2)}${relativeTo(cwd, f.slice(2))}`,
      );
      const only = files.length === 1 ? files[0]?.slice(2) : undefined;
      return {
        tool: { name, ...(files.length ? { input_summary: summarize(files.join(", ")) } : {}) },
        ...(only ? { target: { type: "file", value: only } } : {}),
      };
    }
    const value = summarize(command);
    return { tool: { name, input_summary: value }, target: { type: "command", value } };
  }
  for (const key of FILE_KEYS) {
    const path = str(input[key]);
    if (!path) continue;
    const value = relativeTo(cwd, path);
    return { tool: { name, input_summary: summarize(value) }, target: { type: "file", value } };
  }
  const url = str(input.url);
  if (url) {
    return { tool: { name, input_summary: summarize(url) }, target: { type: "url", value: url } };
  }
  const pattern = str(input.pattern) ?? str(input.query);
  return pattern ? { tool: { name, input_summary: summarize(pattern) } } : { tool: { name } };
}

export interface EventParts {
  source: EventSource;
  kind: EventKind;
  ts: string;
  /** Unique per source record and kind; hashed into the id. */
  key: string;
  actor: Actor;
  agent?: AgentRef;
  model?: string;
  session_id?: string;
  run_id?: string;
  team?: string;
  tool?: LedgerEvent["tool"];
  target?: LedgerEvent["target"];
  decision?: LedgerEvent["decision"];
  cost?: LedgerEvent["cost"];
  data?: Json;
  redacted?: string[];
}

/** Assembles an event, dropping empty optional fields and taking repo, org and team from ctx. */
export function buildEvent(ctx: SourceContext, parts: EventParts): LedgerEvent {
  const { key, data, team, ...rest } = parts;
  const event: Record<string, unknown> = {
    id: stableEventId(parts.ts, `${parts.source}:${parts.kind}:${key}`),
    schema: EVENT_SCHEMA,
    ...rest,
    org: ctx.org,
    team: ctx.team ?? team,
    repo: ctx.repo,
  };
  const cleanData = data
    ? Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))
    : {};
  if (Object.keys(cleanData).length > 0) event.data = cleanData;
  for (const [field, value] of Object.entries(event)) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete event[field];
  }
  return event as LedgerEvent;
}

/** data.prompt only when prompts are logged; otherwise its length and a redacted marker. */
export function promptFields(ctx: SourceContext, prompt: string | undefined) {
  if (prompt === undefined) return { data: {}, redacted: [] as string[] };
  if (ctx.logPrompts) return { data: { prompt, prompt_chars: prompt.length }, redacted: [] };
  return { data: { prompt_chars: prompt.length }, redacted: ["data.prompt"] };
}
