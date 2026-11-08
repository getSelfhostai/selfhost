import {
  claudeMcpServer,
  codexMcpTable,
  cursorMcpServer,
  type McpServerSpec,
  mcpTransport,
  opencodeMcpServer,
  type Plain,
  tomlKey,
  tomlTable,
} from "@selfhost/agents";
import type { ContextAgent } from "@selfhost/schema";
import type { ContextMcpServer } from "../types.js";
import { listed } from "./agents.js";
import type { Builder, Placement } from "./output.js";

// MCP servers. The source is the mcpServers shape Claude Code and Cursor share, with ${VAR}
// (or ${VAR:-default}) for environment variables. The entry shapes come from @selfhost/agents.
// - Claude Code: .mcp.json, type stdio, http or sse, ${VAR} and ${VAR:-default}.
//   https://code.claude.com/docs/en/mcp
// - Copilot: the CLI and VS Code read the same .mcp.json; the cloud agent takes servers only
//   from the repository's Copilot settings on GitHub.
//   https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
// - Cursor: .cursor/mcp.json, ${env:VAR}, no defaults. https://cursor.com/docs/context/mcp
// - Codex: [mcp_servers.<name>] in .codex/config.toml (trusted projects only), stdio and
//   streamable HTTP, no ${VAR}: env_vars passes variables through, bearer_token_env_var and
//   env_http_headers read headers from the environment. https://learn.chatgpt.com/docs/extend/mcp
// - Gemini CLI: mcpServers in .gemini/settings.json, httpUrl for streamable HTTP, url for SSE,
//   ${VAR} and ${VAR:-default}. https://geminicli.com/docs/tools/mcp-server/
// - OpenCode: mcp in opencode.json, local and remote (streamable HTTP), {env:VAR}. The 1.x
//   layout (mcp.<name> with enabled) is read by OpenCode 1 and 2.
//   https://opencode.ai/docs/mcp-servers/ and https://opencode.ai/docs/migrate-v1/
// - Goose: extensions only in each person's ~/.config/goose/config.yaml.
//   https://goose-docs.ai/docs/guides/config-files/

const VARIABLE = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const EXACT_VARIABLE = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/;

const hasVariable = (value: string) => new RegExp(VARIABLE.source).test(value);
const hasDefault = (value: string) =>
  [...value.matchAll(VARIABLE)].some((match) => match[2] !== undefined);

/** Rewrites every string in a spec. */
function mapStrings(spec: McpServerSpec, map: (value: string) => string): McpServerSpec {
  const record = (values?: Record<string, string>) =>
    values && Object.fromEntries(Object.entries(values).map(([key, value]) => [key, map(value)]));
  return {
    ...(spec.type ? { type: spec.type } : {}),
    ...(spec.command ? { command: map(spec.command) } : {}),
    ...(spec.args ? { args: spec.args.map(map) } : {}),
    ...(spec.env ? { env: record(spec.env) } : {}),
    ...(spec.url ? { url: map(spec.url) } : {}),
    ...(spec.headers ? { headers: record(spec.headers) } : {}),
  };
}

const strings = (spec: McpServerSpec) => [
  ...(spec.command ? [spec.command] : []),
  ...(spec.args ?? []),
  ...Object.values(spec.env ?? {}),
  ...(spec.url ? [spec.url] : []),
  ...Object.values(spec.headers ?? {}),
];

/** ${env:VAR} is the source's alias for ${VAR}; Claude Code and Gemini CLI take ${VAR}. */
const plainVariables = (spec: McpServerSpec) =>
  mapStrings(spec, (value) =>
    value.replace(VARIABLE, (_match, name: string, fallback?: string) =>
      fallback === undefined ? `\${${name}}` : `\${${name}:-${fallback}}`,
    ),
  );

/** Rewrites variables into another syntax; defaults are dropped and reported. */
function variablesAs(spec: McpServerSpec, format: (name: string) => string): McpServerSpec {
  return mapStrings(spec, (value) =>
    value.replace(VARIABLE, (_match, name: string) => format(name)),
  );
}

const defaultsGap = (agent: string, spec: McpServerSpec) =>
  strings(spec).some(hasDefault)
    ? [`${agent} has no default values for environment variables, so the :- defaults are left out.`]
    : [];

/** Codex's own keys for what other agents write with ${VAR}. */
function codexTable(spec: McpServerSpec): { table: Plain; gaps: string[] } {
  const table = codexMcpTable({ ...spec, env: undefined });
  const gaps: string[] = [];
  const envVars: string[] = [];
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    const exact = EXACT_VARIABLE.exec(value);
    if (exact?.[1] === key) envVars.push(key);
    else if (!hasVariable(value)) env[key] = value;
    else dropped.push(key);
  }
  if (Object.keys(env).length > 0) table.env = env;
  if (envVars.length > 0) table.env_vars = envVars;
  if (dropped.length > 0) {
    gaps.push(
      `Codex passes environment variables through only under their own names, so ${listed(dropped)} ${dropped.length === 1 ? "is" : "are"} left out.`,
    );
  }
  const headers: Record<string, string> = {};
  const envHeaders: Record<string, string> = {};
  const droppedHeaders: string[] = [];
  for (const [name, value] of Object.entries(spec.headers ?? {})) {
    const bearer = /^Bearer \$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    const exact = EXACT_VARIABLE.exec(value);
    if (name.toLowerCase() === "authorization" && bearer?.[1])
      table.bearer_token_env_var = bearer[1];
    else if (exact?.[1]) envHeaders[name] = exact[1];
    else if (!hasVariable(value)) headers[name] = value;
    else droppedHeaders.push(name);
  }
  if (Object.keys(headers).length > 0) table.http_headers = headers;
  if (Object.keys(envHeaders).length > 0) table.env_http_headers = envHeaders;
  if (droppedHeaders.length > 0) {
    gaps.push(
      `Codex reads a header from the environment only when the whole value is one variable, so ${listed(droppedHeaders)} ${droppedHeaders.length === 1 ? "is" : "are"} left out.`,
    );
  }
  const literal = [...(spec.args ?? []), spec.command ?? "", spec.url ?? ""].filter(hasVariable);
  if (literal.length > 0) {
    gaps.push(
      "Codex does not expand environment variables in command, args or url; they are written as is.",
    );
  }
  return { table, gaps };
}

function geminiServer(spec: McpServerSpec): Plain {
  const transport = mcpTransport(spec);
  if (transport === "stdio") {
    return {
      command: spec.command,
      ...(spec.args ? { args: spec.args } : {}),
      ...(spec.env ? { env: spec.env } : {}),
    };
  }
  return {
    [transport === "sse" ? "url" : "httpUrl"]: spec.url,
    ...(spec.headers ? { headers: spec.headers } : {}),
  };
}

const sseGap = (agent: string): Omit<Placement, "agent"> => ({
  status: "not_expressible",
  files: [],
  detail: `${agent} connects to stdio and streamable HTTP servers only, not SSE.`,
});

/** Collects each MCP file's servers, then writes the files. */
export class McpCompiler {
  private entries = new Map<string, Record<string, unknown>>();
  private sources = new Map<string, string>();

  constructor(private builder: Builder) {}

  private entry(path: string, server: ContextMcpServer, value: unknown): string[] {
    const servers = this.entries.get(path) ?? {};
    servers[server.name] = value;
    this.entries.set(path, servers);
    this.sources.set(path, server.path);
    return [path];
  }

  private one(server: ContextMcpServer, agent: ContextAgent): Omit<Placement, "agent"> {
    const spec = server.spec;
    const sse = mcpTransport(spec) === "sse";
    switch (agent) {
      case "claude_code":
        return {
          status: "compiled",
          files: this.entry(".mcp.json", server, claudeMcpServer(plainVariables(spec))),
          detail: "",
        };
      case "copilot":
        return {
          status: "partial",
          files: this.entry(".mcp.json", server, claudeMcpServer(plainVariables(spec))),
          detail:
            "The Copilot CLI and VS Code read .mcp.json; the cloud agent takes MCP servers only from the repository's Copilot settings on GitHub.",
        };
      case "cursor": {
        const gaps = defaultsGap("Cursor", spec);
        const value = cursorMcpServer(variablesAs(spec, (name) => `\${env:${name}}`));
        return {
          status: gaps.length > 0 ? "partial" : "compiled",
          files: this.entry(".cursor/mcp.json", server, value),
          detail: gaps.join(" "),
        };
      }
      case "codex": {
        if (sse) return sseGap("Codex");
        const { table, gaps } = codexTable(spec);
        return {
          status: gaps.length > 0 ? "partial" : "compiled",
          files: this.entry(".codex/config.toml", server, table),
          detail: gaps.join(" "),
        };
      }
      case "gemini":
        return {
          status: "compiled",
          files: this.entry(".gemini/settings.json", server, geminiServer(plainVariables(spec))),
          detail: "",
        };
      case "opencode": {
        if (sse) return sseGap("OpenCode");
        const gaps = defaultsGap("OpenCode", spec);
        const value = {
          ...opencodeMcpServer(variablesAs(spec, (name) => `{env:${name}}`)),
          enabled: true,
        };
        return {
          status: gaps.length > 0 ? "partial" : "compiled",
          files: this.entry("opencode.json", server, value),
          detail: gaps.join(" "),
        };
      }
      case "goose":
        return {
          status: "not_expressible",
          files: [],
          detail:
            "Goose reads MCP extensions only from each person's ~/.config/goose/config.yaml; selfhost agents configure --agent goose --mcp <name>=<command> writes it there.",
        };
    }
  }

  add(server: ContextMcpServer, targets: readonly ContextAgent[]): void {
    for (const agent of server.agents.filter((candidate) => targets.includes(candidate))) {
      this.builder.place(server, { agent, ...this.one(server, agent) });
    }
  }

  finish(): void {
    for (const [path, servers] of this.entries) {
      const sources = [this.sources.get(path) as string];
      if (path === ".codex/config.toml") {
        const body = Object.entries(servers)
          .map(([name, table]) => tomlTable(`[mcp_servers.${tomlKey(name)}]`, table as Plain))
          .join("\n\n");
        this.builder.add({ path, sources, header: "block", content: { kind: "toml_block", body } });
      } else if (path === ".gemini/settings.json") {
        this.builder.add({
          path,
          sources,
          header: "lock",
          content: { kind: "json_key", key: ["mcpServers"], value: servers },
        });
      } else if (path === "opencode.json") {
        this.builder.add({
          path,
          sources,
          header: "lock",
          content: { kind: "json_key", key: ["mcp"], value: servers },
        });
      } else {
        const text = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
        this.builder.add({ path, sources, header: "lock", content: { kind: "text", text } });
      }
    }
  }
}
