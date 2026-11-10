import { join } from "node:path";
import { CLAUDE_CODE_HOOK_EVENTS, CODEX_HOOK_EVENTS } from "@selfhost/schema";
import type { AgentLocations } from "../locations.js";
import type { AgentId } from "../types.js";
import { deepEqual, isPlainObject, type Plain } from "./docs.js";
import {
  claudeMcpServer,
  codexMcpTable,
  cursorMcpServer,
  gooseExtension,
  mcpTransport,
  opencodeMcpServer,
} from "./mcp.js";
import { tomlKey, tomlTable, tomlValue } from "./toml.js";
import type {
  AgentConfigInput,
  DesiredItem,
  Edit,
  GatewaySpec,
  McpServerSpec,
  OtelSpec,
  PlanItem,
  Target,
  TomlBlock,
  TomlItem,
} from "./types.js";

/** Cursor hook events, from https://cursor.com/docs/hooks. */
export const CURSOR_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "stop",
] as const;

/**
 * The events whose answer can stop a tool call, by agent: what `events: "pre_tool"` hooks.
 * Cursor sends Shell, Read and MCP calls to preToolUse and then to their own event.
 */
export const PRE_TOOL_HOOK_EVENTS = {
  claude_code: ["PreToolUse"],
  codex: ["PreToolUse"],
  cursor: ["preToolUse", "beforeShellExecution", "beforeReadFile", "beforeMCPExecution"],
} as const;

/** Where selfhost puts its OpenCode plugin, inside OpenCode's config folder. */
export const OPENCODE_PLUGIN_FILE = join("plugins", "selfhost.js");

export interface VendorTargets {
  targets: Target[];
  /** Items the agent has no place for, and items that are invalid. */
  other: PlanItem[];
}

const unsupported = (item: string, message: string): PlanItem => ({
  item,
  status: "unsupported",
  path: null,
  message,
});

function hookCommand(command: string, agent: AgentId): string {
  return command.replaceAll("{agent}", agent);
}

function trimEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

/** The per-signal OTLP/HTTP url, for agents that want the full path. */
function signalUrl(endpoint: string, signal: "logs" | "traces"): string {
  const base = trimEndpoint(endpoint);
  return /\/v1\/(logs|traces|metrics)$/.test(base)
    ? base.replace(/(logs|traces|metrics)$/, signal)
    : `${base}/v1/${signal}`;
}

/** Splits MCP servers into valid ones and error items for the rest. */
function mcpEntries(input: AgentConfigInput, other: PlanItem[]): [string, McpServerSpec][] {
  return Object.entries(input.mcpServers ?? {}).filter(([name, spec]) => {
    if (mcpTransport(spec)) return true;
    other.push({
      item: `mcp:${name}`,
      status: "error",
      path: null,
      message: "an MCP server needs either a command or a url",
    });
    return false;
  });
}

function claudeOtelEnv(otel: OtelSpec): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: otel.protocol ?? "http/protobuf",
    OTEL_EXPORTER_OTLP_ENDPOINT: trimEndpoint(otel.endpoint),
  };
  const headers = Object.entries(otel.headers ?? {});
  if (headers.length > 0) {
    env.OTEL_EXPORTER_OTLP_HEADERS = headers.map(([key, value]) => `${key}=${value}`).join(",");
  }
  if (otel.logUserPrompts) env.OTEL_LOG_USER_PROMPTS = "1";
  if (otel.traces) {
    env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = "1";
    env.OTEL_TRACES_EXPORTER = "otlp";
  }
  return env;
}

const envEdits = (vars: Record<string, string>): Edit[] =>
  Object.entries(vars).map(([key, value]) => ({ kind: "key", path: ["env", key], value }));

// The AI gateway, from each vendor's docs, checked 2026-11-09:
// - Claude Code: ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN (Authorization: Bearer) in the env
//   block of ~/.claude/settings.json; ANTHROPIC_API_KEY and apiKeyHelper would send a second
//   credential: https://code.claude.com/docs/en/llm-gateway-connect
// - Codex: model_provider and model_providers.<id> with base_url, wire_api and
//   experimental_bearer_token; built-in provider ids can't be overridden:
//   https://developers.openai.com/codex/config-reference
// - OpenCode: provider.<id>.options.baseURL and apiKey: https://opencode.ai/docs/providers/
// - Goose: a custom provider file in custom_providers/, with requires_auth false and the key in
//   headers, since Goose reads no key from its config files:
//   https://goose-docs.ai/docs/getting-started/providers

/** The provider id selfhost adds to Codex and Goose. */
export const GATEWAY_PROVIDER = "selfhost";

const conflict = (item: string, path: string, message: string): PlanItem => ({
  item,
  status: "conflict",
  path,
  message: `left as is: ${message}`,
});

/** Settings that would send Claude Code's requests elsewhere, or with a second credential. */
const CLAUDE_GATEWAY_RIVALS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

function claudeGateway(
  gateway: GatewaySpec,
  path: string,
  readJson: (path: string) => unknown,
): DesiredItem | PlanItem {
  const settings = readJson(path);
  const env = isPlainObject(settings) && isPlainObject(settings.env) ? settings.env : {};
  const rivals = CLAUDE_GATEWAY_RIVALS.filter((name) => env[name] !== undefined).map(
    (name) => `env.${name}`,
  );
  if (isPlainObject(settings) && settings.apiKeyHelper !== undefined) rivals.push("apiKeyHelper");
  if (rivals.length > 0) {
    return conflict(
      "gateway",
      path,
      `${rivals.join(" and ")} ${rivals.length > 1 ? "are" : "is"} set, which would send Claude Code past the gateway or with another key; take ${rivals.length > 1 ? "them" : "it"} out and run again`,
    );
  }
  return {
    item: "gateway",
    edits: envEdits({ ANTHROPIC_BASE_URL: gateway.anthropic, ANTHROPIC_AUTH_TOKEN: gateway.key }),
  };
}

/** Top-level keys, so this goes in a block at the start of config.toml (the gateway profile). */
function codexGatewayItem(gateway: GatewaySpec): TomlItem {
  const provider = {
    name: "selfhost gateway",
    base_url: gateway.openai,
    wire_api: "responses",
    experimental_bearer_token: gateway.key,
  };
  return {
    item: "gateway",
    conflict(base) {
      if (base.model_provider !== undefined) {
        return `config.toml already sets model_provider = ${tomlValue(base.model_provider)}`;
      }
      if (base.model_providers !== undefined && !isPlainObject(base.model_providers)) {
        return "model_providers is not a table";
      }
      if (isPlainObject(base.model_providers) && GATEWAY_PROVIDER in base.model_providers) {
        return `config.toml already has [model_providers.${GATEWAY_PROVIDER}]`;
      }
      return undefined;
    },
    snippet: () =>
      [
        `model_provider = ${tomlValue(GATEWAY_PROVIDER)}`,
        `model_providers.${GATEWAY_PROVIDER} = ${tomlValue(provider)}`,
      ].join("\n"),
    presentIn: (doc) => doc.model_provider !== undefined,
  };
}

/**
 * The models Goose lists for the gateway when the gateway's own list is not known: names a
 * LiteLLM proxy commonly routes. Bifrost needs the provider in front (openai/gpt-5.5).
 */
export const DEFAULT_GATEWAY_MODELS = ["claude-sonnet-4-5", "gpt-5.5"];

/** The context window Goose assumes for each listed model; it trims history to fit. */
export const GOOSE_CONTEXT_LIMIT = 128_000;

/** Goose's custom provider: the gateway's OpenAI-style chat completions, with its models. */
export function gooseGatewayProvider(gateway: GatewaySpec): string {
  const models = gateway.models?.length ? gateway.models : DEFAULT_GATEWAY_MODELS;
  const provider = {
    name: GATEWAY_PROVIDER,
    engine: "openai",
    display_name: "selfhost gateway",
    description: "Model traffic through the team's AI gateway, with your selfhost key",
    base_url: `${gateway.openai}/chat/completions`,
    models: models.map((name) => ({ name, context_limit: GOOSE_CONTEXT_LIMIT })),
    headers: { Authorization: `Bearer ${gateway.key}` },
    supports_streaming: true,
    requires_auth: false,
  };
  return `${JSON.stringify(provider, null, 2)}\n`;
}

function claudeCode(
  input: AgentConfigInput,
  loc: AgentLocations,
  readJson: (path: string) => unknown,
): VendorTargets {
  const paths = loc.claude_code;
  const other: PlanItem[] = [];
  const settings: DesiredItem[] = [];
  if (input.gateway) {
    const gateway = claudeGateway(input.gateway, paths.settings, readJson);
    if ("edits" in gateway) settings.push(gateway);
    else other.push(gateway);
  }
  if (input.env && Object.keys(input.env).length > 0) {
    settings.push({ item: "env", edits: envEdits(input.env) });
  }
  if (input.otel) settings.push({ item: "otel", edits: envEdits(claudeOtelEnv(input.otel)) });
  if (input.hooks) {
    const command = hookCommand(input.hooks.command, "claude_code");
    const events =
      input.hooks.events === "pre_tool"
        ? PRE_TOOL_HOOK_EVENTS.claude_code
        : CLAUDE_CODE_HOOK_EVENTS;
    settings.push({
      item: "hooks",
      edits: events.map((event) => ({
        kind: "hook",
        path: ["hooks", event],
        style: "claude",
        command,
      })),
    });
  }
  const mcp: DesiredItem[] = mcpEntries(input, other).map(([name, spec]) => ({
    item: `mcp:${name}`,
    edits: [
      {
        kind: "key",
        path: ["mcpServers", name],
        value: claudeMcpServer(spec),
      },
    ],
  }));
  return {
    targets: [
      { kind: "tree", path: paths.settings, format: "json", items: settings },
      { kind: "tree", path: paths.globalConfig, format: "json", items: mcp },
    ],
    other,
  };
}

function codexOtelTable(otel: OtelSpec): Plain {
  const headers =
    otel.headers && Object.keys(otel.headers).length > 0 ? { headers: otel.headers } : {};
  const exporter = (signal: "logs" | "traces") =>
    otel.protocol === "grpc"
      ? { "otlp-grpc": { endpoint: trimEndpoint(otel.endpoint), ...headers } }
      : {
          "otlp-http": {
            endpoint: signalUrl(otel.endpoint, signal),
            protocol: otel.protocol === "http/json" ? "json" : "binary",
            ...headers,
          },
        };
  return {
    ...(otel.logUserPrompts === undefined ? {} : { log_user_prompt: otel.logUserPrompts }),
    exporter: exporter("logs"),
    ...(otel.traces ? { trace_exporter: exporter("traces") } : {}),
  };
}

/** A TOML item that owns one whole table, such as [otel] or [mcp_servers.selfhost]. */
function tomlTableItem(item: string, path: string[], table: Plain, note?: string): TomlItem {
  const header = `[${path.map(tomlKey).join(".")}]`;
  const existing = (doc: Plain) => {
    let node: unknown = doc;
    for (const key of path) node = isPlainObject(node) ? node[key] : undefined;
    return node;
  };
  return {
    item,
    note,
    conflict(base) {
      const parent = path.length > 1 ? base[path[0] ?? ""] : undefined;
      if (parent !== undefined && !isPlainObject(parent)) return `${path[0]} is not a table`;
      const current = existing(base);
      if (current !== undefined && !deepEqual(current, table)) {
        return `config.toml already has ${header} with other settings`;
      }
      return undefined;
    },
    snippet: (base) => (deepEqual(existing(base), table) ? "" : tomlTable(header, table)),
    presentIn: (doc) => existing(doc) !== undefined,
  };
}

function codexHooksItem(command: string, events: readonly string[]): TomlItem {
  const hooksOf = (doc: Plain) => (isPlainObject(doc.hooks) ? doc.hooks : {});
  const hasCommand = (list: unknown) =>
    Array.isArray(list) &&
    list.some(
      (group) =>
        isPlainObject(group) &&
        Array.isArray(group.hooks) &&
        group.hooks.some((handler) => isPlainObject(handler) && handler.command === command),
    );
  return {
    item: "hooks",
    note: "Codex asks you to review new hooks with /hooks before they run",
    conflict(base) {
      if (base.hooks !== undefined && !isPlainObject(base.hooks)) return "hooks is not a table";
      const hooks = hooksOf(base);
      const bad = events.find(
        (event) => hooks[event] !== undefined && !Array.isArray(hooks[event]),
      );
      if (bad) return `hooks.${bad} is not a list of tables`;
      if (isPlainObject(base.features) && base.features.hooks === false) {
        return "hooks are turned off in config.toml ([features] hooks = false)";
      }
      return undefined;
    },
    snippet(base) {
      const hooks = hooksOf(base);
      return events
        .filter((event) => !hasCommand(hooks[event]))
        .map(
          (event) =>
            `[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}`,
        )
        .join("\n\n");
    },
    presentIn: (doc) => doc.hooks !== undefined,
  };
}

function codex(
  input: AgentConfigInput,
  loc: AgentLocations,
  block: TomlBlock,
  exists: (path: string) => boolean,
): VendorTargets {
  const paths = loc.codex;
  const other: PlanItem[] = [];
  if (input.env && Object.keys(input.env).length > 0) {
    other.push(
      unsupported(
        "env",
        "Codex has no setting for its own environment ([shell_environment_policy] only covers the commands it runs); OpenTelemetry goes in [otel]",
      ),
    );
  }
  const items: TomlItem[] = [];
  const targets: Target[] = [];
  if (input.gateway) {
    other.push({
      item: "gateway",
      status: "error",
      path: paths.config,
      message: "the gateway's settings are top-level keys: plan them with the gateway profile",
    });
  }
  if (input.otel) items.push(tomlTableItem("otel", ["otel"], codexOtelTable(input.otel)));
  if (input.hooks) {
    const command = hookCommand(input.hooks.command, "codex");
    const events =
      input.hooks.events === "pre_tool" ? PRE_TOOL_HOOK_EVENTS.codex : CODEX_HOOK_EVENTS;
    // Codex warns when one layer has both hooks.json and [hooks]; follow the user's choice.
    if (exists(paths.hooks)) {
      targets.push({
        kind: "tree",
        path: paths.hooks,
        format: "json",
        items: [
          {
            item: "hooks",
            note: "Codex asks you to review new hooks with /hooks before they run",
            edits: events.map((event) => ({
              kind: "hook",
              path: ["hooks", event],
              style: "claude",
              command,
            })),
          },
        ],
      });
    } else {
      items.push(codexHooksItem(command, events));
    }
  }
  for (const [name, spec] of mcpEntries(input, other)) {
    const table = codexMcpTable(spec);
    const note = spec.headers
      ? "headers are not written for Codex; set bearer_token_env_var on the server by hand"
      : undefined;
    items.push(tomlTableItem(`mcp:${name}`, ["mcp_servers", name], table, note));
  }
  targets.unshift({ kind: "toml", path: paths.config, items, block });
  return { targets, other };
}

/**
 * Codex with a block at the start of config.toml, which holds the gateway's top-level keys. A
 * table there would take in the user's own top-level keys after it, so nothing else goes in.
 */
function codexStart(input: AgentConfigInput, loc: AgentLocations, block: TomlBlock): VendorTargets {
  const path = loc.codex.config;
  const misplaced = [
    ...(input.env ? ["env"] : []),
    ...(input.otel ? ["otel"] : []),
    ...(input.hooks ? ["hooks"] : []),
    ...Object.keys(input.mcpServers ?? {}).map((name) => `mcp:${name}`),
  ];
  const other = misplaced.map(
    (item): PlanItem => ({
      item,
      status: "error",
      path,
      message: "only the gateway's top-level keys go in this profile",
    }),
  );
  const items = input.gateway ? [codexGatewayItem(input.gateway)] : [];
  return { targets: [{ kind: "toml", path, items, block }], other };
}

/** OpenCode 1 keyed servers directly under `mcp`; OpenCode 2 uses `mcp.servers`. */
function opencodeUsesV1Layout(config: unknown): boolean {
  if (!isPlainObject(config) || !isPlainObject(config.mcp)) return false;
  return Object.entries(config.mcp).some(
    ([key, value]) =>
      key !== "servers" && key !== "timeout" && isPlainObject(value) && "type" in value,
  );
}

function opencode(
  input: AgentConfigInput,
  loc: AgentLocations,
  readJson: (path: string) => unknown,
): VendorTargets {
  const paths = loc.opencode;
  const other: PlanItem[] = [];
  if (input.env && Object.keys(input.env).length > 0) {
    other.push(unsupported("env", "opencode.json has no environment setting"));
  }
  if (input.otel) {
    other.push(
      unsupported(
        "otel",
        "OpenCode reads OpenTelemetry settings only from OTEL_* variables in its process environment, and selfhost does not edit shell profiles",
      ),
    );
  }
  const targets: Target[] = [];
  if (input.hooks?.opencodePlugin !== undefined) {
    targets.push({
      kind: "file",
      path: join(paths.configDir, OPENCODE_PLUGIN_FILE),
      items: [{ item: "hooks", content: input.hooks.opencodePlugin }],
    });
  } else if (input.hooks) {
    other.push(
      unsupported("hooks", "OpenCode has no hook settings; it runs JavaScript plugins instead"),
    );
  }
  const v1 = opencodeUsesV1Layout(readJson(paths.config));
  const items: DesiredItem[] = mcpEntries(input, other).map(([name, spec]) => {
    const value = opencodeMcpServer(spec);
    return {
      item: `mcp:${name}`,
      edits: [
        {
          kind: "key",
          path: v1 ? ["mcp", name] : ["mcp", "servers", name],
          value: v1 ? { ...value, enabled: true } : value,
        },
      ],
    };
  });
  if (input.gateway) {
    const { anthropic, openai, key } = input.gateway;
    const option = (provider: string, name: string, value: string): Edit => ({
      kind: "key",
      path: ["provider", provider, "options", name],
      value,
    });
    items.unshift({
      item: "gateway",
      edits: [
        option("anthropic", "baseURL", `${anthropic}/v1`),
        option("anthropic", "apiKey", key),
        option("openai", "baseURL", openai),
        option("openai", "apiKey", key),
      ],
    });
  }
  targets.unshift({ kind: "tree", path: paths.config, format: "json", items });
  return { targets, other };
}

function goose(input: AgentConfigInput, loc: AgentLocations): VendorTargets {
  const paths = loc.goose;
  const other: PlanItem[] = [];
  const items: DesiredItem[] = [];
  if (input.env && Object.keys(input.env).length > 0) {
    other.push(
      unsupported("env", "Goose's config.yaml has no environment setting for its process"),
    );
  }
  if (input.hooks) other.push(unsupported("hooks", "Goose has no hooks"));
  if (input.otel?.protocol === "grpc") {
    other.push(unsupported("otel", "Goose exports OTLP over HTTP only"));
  } else if (input.otel) {
    items.push({
      item: "otel",
      edits: [
        {
          kind: "key",
          path: ["otel_exporter_otlp_endpoint"],
          value: trimEndpoint(input.otel.endpoint),
        },
      ],
      note: input.otel.headers
        ? "headers are not written: Goose reads them only from OTEL_EXPORTER_OTLP_HEADERS"
        : undefined,
    });
  }
  for (const [name, spec] of mcpEntries(input, other)) {
    const value = gooseExtension(name, spec);
    items.push({
      item: `mcp:${name}`,
      edits: [{ kind: "key", path: ["extensions", name], value }],
    });
  }
  const targets: Target[] = [{ kind: "tree", path: paths.config, format: "yaml", items }];
  if (input.gateway) {
    targets.push({
      kind: "file",
      path: join(paths.configDir, "custom_providers", `${GATEWAY_PROVIDER}.json`),
      items: [
        {
          item: "gateway",
          content: gooseGatewayProvider(input.gateway),
          note: `pick it with goose session --provider ${GATEWAY_PROVIDER}, or make it the default in goose configure`,
        },
      ],
    });
  }
  return { targets, other };
}

function cursor(input: AgentConfigInput, loc: AgentLocations): VendorTargets {
  const paths = loc.cursor;
  const other: PlanItem[] = [];
  if (input.env && Object.keys(input.env).length > 0) {
    other.push(unsupported("env", "Cursor CLI has no environment setting"));
  }
  if (input.otel) other.push(unsupported("otel", "Cursor CLI has no OpenTelemetry export"));
  if (input.gateway) {
    other.push(
      unsupported(
        "gateway",
        "Cursor sends model traffic from its own servers, so a gateway can't take it; its usage is read from Cursor's admin API",
      ),
    );
  }
  const targets: Target[] = [];
  if (input.hooks) {
    const command = hookCommand(input.hooks.command, "cursor");
    const events =
      input.hooks.events === "pre_tool" ? PRE_TOOL_HOOK_EVENTS.cursor : CURSOR_HOOK_EVENTS;
    targets.push({
      kind: "tree",
      path: paths.hooks,
      format: "json",
      items: [
        {
          item: "hooks",
          edits: [
            { kind: "key", path: ["version"], value: 1 },
            ...events.map(
              (event): Edit => ({ kind: "hook", path: ["hooks", event], style: "cursor", command }),
            ),
          ],
        },
      ],
    });
  }
  const mcp: DesiredItem[] = mcpEntries(input, other).map(([name, spec]) => ({
    item: `mcp:${name}`,
    edits: [
      {
        kind: "key",
        path: ["mcpServers", name],
        value: cursorMcpServer(spec),
      },
    ],
  }));
  targets.push({ kind: "tree", path: paths.mcp, format: "json", items: mcp });
  return { targets, other };
}

export interface VendorIo {
  exists(path: string): boolean;
  readJson(path: string): unknown;
}

/** The files and items selfhost writes for one agent, given what the caller wants. */
export function vendorTargets(
  agent: AgentId,
  input: AgentConfigInput,
  loc: AgentLocations,
  block: TomlBlock,
  io: VendorIo,
): VendorTargets {
  switch (agent) {
    case "claude_code":
      return claudeCode(input, loc, io.readJson);
    case "codex":
      return block.at === "start"
        ? codexStart(input, loc, block)
        : codex(input, loc, block, io.exists);
    case "opencode":
      return opencode(input, loc, io.readJson);
    case "goose":
      return goose(input, loc);
    case "cursor":
      return cursor(input, loc);
  }
}
