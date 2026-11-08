import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import {
  type Actor,
  type AgentVendor,
  EVENT_SCHEMA,
  type EventKind,
  type LedgerEvent,
} from "@selfhost/schema";
import { defaultActorId, isoTimestamp } from "./events.js";
import { deterministicUuidv7 } from "./ids.js";
import { type WriteResult, writeEvents } from "./import.js";
import { promptData } from "./summary.js";
import type { LedgerWriter } from "./types.js";

/**
 * Workspace history from Conductor (conductor.build), as ledger events.
 *
 * Conductor does not publish the format of its account export (Settings, Account, Export data;
 * https://www.conductor.build/changelog/0.93.0-conductor-is-joining-meta). What is published is
 * its API (https://www.conductor.build/docs/api, OpenAPI at
 * https://api.conductor.build/v0/openapi.json), so this reads JSON shaped like the API's own
 * objects wherever they sit in the files:
 *
 * - workspaces: `{ id, projectId, name, state, repoUrl, createdAt }`
 * - sessions (chats): `{ id, name, model, resolvedModel, archivedAt }`, nested in a workspace
 *   under `sessions` or carrying `workspaceId`
 * - transcript messages: `{ id, sessionId, sessionIndex, type, content, receivedAt }`, where
 *   `type` is `userMessage` for a prompt and `agent` for the harness's raw output
 * - projects: `{ id, name, gitRemote }`
 * - rows of the `session_transcripts_view` that `POST /v0/sql` returns: `session_id`,
 *   `workspace_id`, `session_title`, `agent_type`, `model`, `workspace_name`, `repo_url`,
 *   `session_created_at`, `transcript_updated_at`
 *
 * Each session becomes `session.started` and `session.ended` at its first and last
 * timestamp, with `run_id` naming its workspace, and each prompt a `prompt.submitted` when
 * prompts are kept. Tool calls and token usage inside `agent` messages are not read: that
 * payload is undocumented, and the agents of local workspaces already logged them where
 * `selfhost import` reads them. Ids come from the Conductor ids, so a second import adds nothing.
 */

export interface ConductorHistoryOptions {
  /** Person the sessions belong to. Default: the OS user name. */
  actorId?: string;
  /** Add `prompt.submitted` events with the prompt text. Default false: no prompt events. */
  logPrompts?: boolean;
}

export interface ConductorHistory {
  /** JSON and JSON Lines files read. */
  files: number;
  workspaces: number;
  sessions: number;
  messages: number;
  /** Files or sessions that were left out, with why. */
  skipped: { path: string; reason: string }[];
  events: LedgerEvent[];
}

const SOURCE_EXTENSIONS = new Set([".json", ".jsonl", ".ndjson"]);
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const USER_MESSAGE_TYPES = new Set(["userMessage", "user_message", "user"]);

type Json = Record<string, unknown>;

interface Workspace {
  id: string;
  name?: string;
  projectId?: string;
  repoUrl?: string;
  state?: string;
  createdAt?: string;
}

interface Message {
  id: string;
  index?: number;
  type: string;
  ts: string;
  content: unknown;
}

interface Session {
  id: string;
  workspaceId?: string;
  name?: string;
  agent?: string;
  /** The vendor's model id, such as claude-opus-5-5, when the export has it. */
  resolvedModel?: string;
  /** Conductor's model id, such as opus-5-5-1m. */
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  messages: Map<string, Message>;
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** Fills fields that are still empty, so the first file to name a value wins. */
function merge<T extends object>(target: T, source: Partial<T>): void {
  for (const [key, value] of Object.entries(source)) {
    const record = target as Record<string, unknown>;
    if (value !== undefined && record[key] === undefined) record[key] = value;
  }
}

class Collector {
  readonly workspaces = new Map<string, Workspace>();
  readonly sessions = new Map<string, Session>();
  readonly projectRemotes = new Map<string, string>();

  workspace(id: string, fields: Partial<Workspace> = {}): Workspace {
    let workspace = this.workspaces.get(id);
    if (!workspace) {
      workspace = { id };
      this.workspaces.set(id, workspace);
    }
    merge(workspace, fields);
    return workspace;
  }

  session(id: string, fields: Partial<Omit<Session, "messages">> = {}): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = { id, messages: new Map() };
      this.sessions.set(id, session);
    }
    merge(session, fields);
    return session;
  }

  /** Walks any JSON value, picking out the objects that have the shape of a Conductor record. */
  visit(value: unknown, parentKey: string, workspace?: Workspace, session?: Session): void {
    if (Array.isArray(value)) {
      for (const item of value) this.visit(item, parentKey, workspace, session);
      return;
    }
    if (!isObject(value)) return;
    if (this.message(value, session)) return;
    if (this.transcriptRow(value)) return;
    const id = str(value.id);
    if (id && isWorkspace(value, parentKey)) {
      const found = this.workspace(id, {
        name: str(value.name),
        projectId: str(value.projectId),
        repoUrl: str(value.repoUrl) ?? str(value.repositoryUrl),
        state: str(value.state) ?? str(value.status),
        createdAt: isoTimestamp(value.createdAt),
      });
      this.children(value, found, undefined);
      return;
    }
    if (id && isSession(value, parentKey)) {
      const workspaceId = str(value.workspaceId) ?? workspace?.id;
      const found = this.session(id, {
        workspaceId,
        name: str(value.name) ?? str(value.title),
        agent: str(value.agent) ?? str(value.agentType),
        resolvedModel: str(value.resolvedModel),
        model: str(value.model),
        createdAt: isoTimestamp(value.createdAt),
        updatedAt: isoTimestamp(value.updatedAt) ?? isoTimestamp(value.lastActivityAt),
      });
      if (workspaceId) this.workspace(workspaceId);
      this.children(value, workspace, found);
      return;
    }
    if (id && str(value.gitRemote) && !this.projectRemotes.has(id)) {
      this.projectRemotes.set(id, value.gitRemote as string);
    }
    this.children(value, workspace, session);
  }

  private children(value: Json, workspace?: Workspace, session?: Session): void {
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "object" && child !== null) this.visit(child, key, workspace, session);
    }
  }

  /** A transcript message. Its content is the harness's raw payload, so it is not walked. */
  private message(value: Json, session: Session | undefined): boolean {
    const type = str(value.type);
    const ts = isoTimestamp(value.receivedAt);
    const sessionId = str(value.sessionId) ?? session?.id;
    if (!type || !ts) return false;
    if (typeof value.sessionIndex !== "number" && str(value.sessionId) === undefined) return false;
    const id = str(value.id);
    if (!sessionId || !id) return true;
    const target = this.session(sessionId);
    if (!target.messages.has(id)) {
      target.messages.set(id, {
        id,
        type,
        ts,
        content: value.content,
        ...(typeof value.sessionIndex === "number" ? { index: value.sessionIndex } : {}),
      });
    }
    return true;
  }

  /** One row of session_transcripts_view, from POST /v0/sql. */
  private transcriptRow(value: Json): boolean {
    const sessionId = str(value.session_id);
    if (!sessionId) return false;
    if (!("session_created_at" in value || "transcript_updated_at" in value)) return false;
    const workspaceId = str(value.workspace_id);
    this.session(sessionId, {
      workspaceId,
      name: str(value.session_title),
      agent: str(value.agent_type),
      model: str(value.model),
      createdAt: isoTimestamp(value.session_created_at),
      updatedAt: isoTimestamp(value.transcript_updated_at),
    });
    if (workspaceId) {
      this.workspace(workspaceId, {
        name: str(value.workspace_name),
        state: str(value.workspace_state),
        repoUrl: str(value.repo_url),
        createdAt: isoTimestamp(value.workspace_created_at),
      });
    }
    return true;
  }
}

function isWorkspace(value: Json, parentKey: string): boolean {
  if (parentKey === "workspaces" || parentKey === "workspace") return true;
  if (str(value.repoUrl)) return true;
  return str(value.projectId) !== undefined && str(value.state) !== undefined;
}

function isSession(value: Json, parentKey: string): boolean {
  if (parentKey === "sessions" || parentKey === "session") return true;
  if ("resolvedModel" in value || "fastMode" in value) return true;
  if (str(value.workspaceId) !== undefined && Array.isArray(value.messages)) return true;
  // A page of GET /v0/workspaces/{id}/sessions: a deep link, and none of a workspace's fields.
  return str(value.deepLink) !== undefined && !("repoUrl" in value) && !("state" in value);
}

async function listFiles(root: string): Promise<string[]> {
  const info = await stat(root).catch(() => undefined);
  if (!info) throw new Error(`${root} does not exist`);
  if (info.isFile()) return [root];
  const files: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    files.push(join(entry.parentPath, entry.name));
  }
  return files.sort();
}

/** A file as one JSON value, or as JSON Lines when it is not one. */
function parseFile(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const values: unknown[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      values.push(JSON.parse(line));
    }
    return values;
  }
}

/** owner/name from a git remote such as git@github.com:acme/api.git or https://github.com/acme/api. */
export function repoSlug(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const match = /[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

const AGENT_NAMES: Record<string, AgentVendor> = {
  claude: "claude_code",
  claude_code: "claude_code",
  "claude-code": "claude_code",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
};

/** The agent from the session's agent name, else from its model id. */
export function conductorVendor(agent: string | undefined, model: string | undefined): AgentVendor {
  const named = agent ? AGENT_NAMES[agent.trim().toLowerCase()] : undefined;
  if (named) return named;
  if (!model) return "other";
  if (/claude|opus|sonnet|haiku|fable/i.test(model)) return "claude_code";
  if (/gpt|codex|^o\d/i.test(model)) return "codex";
  if (/composer|grok|^auto$/i.test(model)) return "cursor";
  return "other";
}

/** The text of a prompt message, from a string or the usual { text } and content-part shapes. */
function textOf(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (depth > 4) return undefined;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) =>
        isObject(part) && typeof part.type === "string" && part.type !== "text"
          ? undefined
          : textOf(part, depth + 1),
      )
      .filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (!isObject(value)) return undefined;
  for (const key of ["text", "message", "prompt", "content"]) {
    const text = textOf(value[key], depth + 1);
    if (text !== undefined) return text;
  }
  return undefined;
}

function byTime(a: Message, b: Message): number {
  if (a.index !== undefined && b.index !== undefined && a.index !== b.index) {
    return a.index - b.index;
  }
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
}

function sessionEvents(
  collector: Collector,
  session: Session,
  person: Actor,
  logPrompts: boolean,
): LedgerEvent[] | undefined {
  const messages = [...session.messages.values()].sort(byTime);
  const times = [session.createdAt, session.updatedAt, ...messages.map((m) => m.ts)]
    .filter((ts): ts is string => ts !== undefined)
    .sort();
  const start = times[0];
  const end = times[times.length - 1];
  if (!start || !end) return undefined;
  const workspace = session.workspaceId ? collector.workspaces.get(session.workspaceId) : undefined;
  const remote =
    workspace?.repoUrl ??
    (workspace?.projectId ? collector.projectRemotes.get(workspace.projectId) : undefined);
  const repo = repoSlug(remote);
  const model = session.resolvedModel ?? session.model;
  const vendor = conductorVendor(session.agent, model);
  const prompts = messages.filter((m) => USER_MESSAGE_TYPES.has(m.type));
  const base = {
    source: "local_log" as const,
    agent: { vendor },
    session_id: session.id,
    ...(session.workspaceId ? { run_id: `conductor:${session.workspaceId}` } : {}),
    ...(repo ? { repo } : {}),
    ...(model ? { model } : {}),
  };
  const event = (
    kind: EventKind,
    identity: string,
    ts: string,
    fields: Partial<LedgerEvent> = {},
  ): LedgerEvent => ({
    id: deterministicUuidv7(`conductor\n${session.id}\n${kind}\n${identity}`, Date.parse(ts)),
    schema: EVENT_SCHEMA,
    ts,
    kind,
    actor: person,
    ...base,
    ...fields,
  });
  const data = {
    via: "conductor",
    ...(workspace?.name ? { workspace: workspace.name } : {}),
    ...(session.workspaceId ? { workspace_id: session.workspaceId } : {}),
    ...(workspace?.state ? { workspace_state: workspace.state } : {}),
    ...(session.name ? { session_name: session.name } : {}),
    messages: messages.length,
    prompts: prompts.length,
  };
  const events = [
    event("session.started", "start", start, { data }),
    event("session.ended", "end", end, { data: { via: "conductor" } }),
  ];
  if (!logPrompts) return events;
  for (const message of prompts) {
    const text = textOf(message.content);
    if (text === undefined) continue;
    const prompt = promptData(text);
    events.push(
      event("prompt.submitted", message.id, message.ts, {
        data: prompt.data,
        ...(prompt.masked ? { redacted: ["data.prompt"] } : {}),
      }),
    );
  }
  return events;
}

/**
 * Reads a Conductor history export: a folder (searched for .json, .jsonl and .ndjson files)
 * or one file. Reads only; nothing is written. A zip archive has to be unpacked first.
 */
export async function readConductorExport(
  path: string,
  opts: ConductorHistoryOptions = {},
): Promise<ConductorHistory> {
  if (extname(path).toLowerCase() === ".zip") {
    throw new Error(
      `${path} is a zip archive. Unpack it first (unzip "${path}" -d conductor-export) and pass the folder.`,
    );
  }
  const collector = new Collector();
  const skipped: ConductorHistory["skipped"] = [];
  const files = await listFiles(path);
  let read = 0;
  for (const file of files) {
    const shown = relative(path, file) || file;
    const info = await stat(file);
    if (info.size > MAX_FILE_BYTES) {
      skipped.push({ path: shown, reason: "larger than 512 MB" });
      continue;
    }
    let value: unknown;
    try {
      value = parseFile(await readFile(file, "utf8"));
    } catch {
      skipped.push({ path: shown, reason: "not JSON or JSON Lines" });
      continue;
    }
    read++;
    collector.visit(value, "");
  }
  const person: Actor = { kind: "person", id: opts.actorId ?? defaultActorId() };
  const events: LedgerEvent[] = [];
  let messages = 0;
  for (const session of collector.sessions.values()) {
    messages += session.messages.size;
    const mapped = sessionEvents(collector, session, person, opts.logPrompts === true);
    if (mapped) events.push(...mapped);
    else skipped.push({ path: `session ${session.id}`, reason: "no timestamp in the export" });
  }
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  return {
    files: read,
    workspaces: collector.workspaces.size,
    sessions: collector.sessions.size,
    messages,
    skipped,
    events,
  };
}

/** Reads a Conductor history export and appends its events. A second run adds nothing. */
export async function importConductorExport(
  writer: LedgerWriter,
  path: string,
  opts: ConductorHistoryOptions = {},
): Promise<ConductorHistory & WriteResult> {
  const history = await readConductorExport(path, opts);
  return { ...history, ...(await writeEvents(writer, history.events)) };
}
