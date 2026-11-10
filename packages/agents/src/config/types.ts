import type { AgentId, Env } from "../types.js";

export interface McpServerSpec {
  /** The transport for a url: streamable HTTP (the default) or the older SSE. */
  type?: "stdio" | "http" | "sse";
  /** A stdio server: the executable and its arguments. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** A streamable HTTP server. */
  url?: string;
  headers?: Record<string, string>;
}

export type OtlpProtocol = "http/protobuf" | "http/json" | "grpc";

export interface OtelSpec {
  /** Base OTLP endpoint, such as http://127.0.0.1:4318. */
  endpoint: string;
  /** Defaults to http/protobuf. */
  protocol?: OtlpProtocol;
  headers?: Record<string, string>;
  /** Export prompt text. Off unless set. */
  logUserPrompts?: boolean;
  /** Export traces as well as metrics and logs, where the agent supports it. */
  traces?: boolean;
}

export interface HooksSpec {
  /**
   * The command each agent runs on its hook events, with the event JSON on stdin.
   * `{agent}` is replaced with the agent id, for example `selfhost hook --agent {agent}`.
   */
  command: string;
  /**
   * all (the default) hooks every event selfhost reads; pre_tool only the events whose answer
   * can stop a tool call, as the guardrails pack needs.
   */
  events?: "all" | "pre_tool";
  /**
   * An OpenCode plugin, as JavaScript source. OpenCode has no hook settings, so with this the
   * hooks item for OpenCode is this file in its plugins folder; without it OpenCode's hooks
   * are unsupported.
   */
  opencodePlugin?: string;
}

/** An AI gateway that takes the agent's model traffic, with the person's virtual key. */
export interface GatewaySpec {
  /** Base URL for Anthropic-style clients, without /v1, such as https://host/llm/anthropic. */
  anthropic: string;
  /** Base URL for OpenAI-style clients, ending in /v1. */
  openai: string;
  /** The virtual key the gateway issued: never a provider key. */
  key: string;
  /**
   * The gateway's model names, for agents that list them (Goose). Default:
   * DEFAULT_GATEWAY_MODELS.
   */
  models?: string[];
}

export interface AgentConfigInput {
  hooks?: HooksSpec;
  /** Environment variables for the agent's own process. */
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerSpec>;
  otel?: OtelSpec;
  /** Send the agent's model traffic through an AI gateway. Use it with the gateway profile. */
  gateway?: GatewaySpec;
}

export interface PlanOptions extends AgentConfigInput {
  home: string;
  /**
   * Which of selfhost's setups the plan is for. Each keeps its own record of what it wrote (and
   * its own block in a TOML file), so the guardrails pack and `agents configure` are added and
   * removed apart. Default: the main setup.
   */
  profile?: string;
  /** Process environment, read for CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_* and similar. */
  processEnv?: Env;
  platform?: NodeJS.Platform;
}

export type ItemStatus =
  | "create"
  | "update"
  | "unchanged"
  | "remove"
  | "conflict"
  | "unsupported"
  | "error";

export interface PlanItem {
  /** env, otel, hooks or mcp:<name>. */
  item: string;
  status: ItemStatus;
  /** The file the item lives in, or null when the agent has no place for it. */
  path: string | null;
  message: string | null;
}

export interface FileChange {
  path: string;
  /** config is an agent's own file; state is selfhost's record of what it owns. */
  role: "config" | "state";
  /** Content when the plan was made; null when the file did not exist. */
  before: string | null;
  /** Content to write; null deletes the file. */
  after: string | null;
}

export interface AgentConfigPlan {
  agent: AgentId;
  items: PlanItem[];
  /** Only files whose content changes. */
  changes: FileChange[];
}

export type HookStyle = "claude" | "cursor";

/** One change selfhost makes inside a settings file. */
export type Edit =
  | { kind: "key"; path: string[]; value: unknown }
  | { kind: "hook"; path: string[]; style: HookStyle; command: string };

/** What selfhost recorded as its own in a file, so a re-run or removal touches only that. */
export type Owned =
  | { kind: "key"; item: string; path: string[] }
  | { kind: "container"; path: string[] }
  | { kind: "hook"; item: string; path: string[]; style: HookStyle; command: string }
  | { kind: "file"; item: string };

export interface ManifestFile {
  /** text is a whole file selfhost wrote, such as an OpenCode plugin. */
  format: "json" | "yaml" | "toml" | "text";
  /** True when selfhost created the file, so removal may delete it once it is empty. */
  created: boolean;
  owned: Owned[];
}

export interface Manifest {
  schema: "selfhost.agent_config/v1";
  agent: AgentId;
  files: Record<string, ManifestFile>;
}

export interface DesiredItem {
  item: string;
  edits: Edit[];
  /** Shown with the item's status, such as a follow-up step in the agent. */
  note?: string;
}

/** A JSON or YAML settings file, merged key by key. */
export interface TreeTarget {
  kind: "tree";
  path: string;
  format: "json" | "yaml";
  items: DesiredItem[];
}

export interface TomlItem {
  item: string;
  /** The TOML for this item inside selfhost's block. Empty when it is already set. */
  snippet(base: Record<string, unknown>): string;
  /** A reason the item can't be written next to what the file already has. */
  conflict(base: Record<string, unknown>): string | undefined;
  /** Whether a parsed TOML document holds this item. */
  presentIn(doc: Record<string, unknown>): boolean;
  note?: string;
}

/** The marker lines around selfhost's block in a TOML file, one pair per profile. */
export interface TomlBlock {
  start: string;
  end: string;
  note: string;
  /** start puts the block before everything else, so it can hold top-level keys. Default: end. */
  at?: "start";
}

/** A TOML file, where selfhost keeps its settings in one marked block. */
export interface TomlTarget {
  kind: "toml";
  path: string;
  items: TomlItem[];
  /** Default: the main setup's markers. */
  block?: TomlBlock;
}

/** A whole file that selfhost owns, such as a plugin. */
export interface FileTarget {
  kind: "file";
  path: string;
  /** At most one: the item and the content the file should have. */
  items: { item: string; content: string; note?: string }[];
}

export type Target = TreeTarget | TomlTarget | FileTarget;
