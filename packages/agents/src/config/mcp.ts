import type { Plain } from "./docs.js";
import type { McpServerSpec } from "./types.js";

/**
 * How each agent writes one MCP server entry. `agents configure` writes them into the home
 * config, `selfhost context compile` into the repository's own files; both use these shapes.
 *
 * - Claude Code (.mcp.json, ~/.claude.json): https://code.claude.com/docs/en/mcp
 * - Cursor (.cursor/mcp.json, ~/.cursor/mcp.json): https://cursor.com/docs/context/mcp
 * - Codex ([mcp_servers.<name>] in config.toml): https://learn.chatgpt.com/docs/extend/mcp
 * - OpenCode (mcp in opencode.json): https://opencode.ai/docs/mcp-servers/
 * - Goose (extensions in config.yaml): https://goose-docs.ai/docs/guides/config-files/
 */

export type McpTransport = "stdio" | "http" | "sse";

/**
 * stdio for a command, http or sse for a url (http unless the spec says sse), undefined when
 * the spec has both or neither.
 */
export function mcpTransport(spec: McpServerSpec): McpTransport | undefined {
  if (spec.command && !spec.url) return "stdio";
  if (spec.url && !spec.command) return spec.type === "sse" ? "sse" : "http";
  return undefined;
}

export function claudeMcpServer(spec: McpServerSpec): Plain {
  const transport = mcpTransport(spec);
  return transport === "stdio"
    ? { type: "stdio", command: spec.command, args: spec.args ?? [], env: spec.env ?? {} }
    : { type: transport, url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) };
}

export function cursorMcpServer(spec: McpServerSpec): Plain {
  return mcpTransport(spec) === "stdio"
    ? { command: spec.command, args: spec.args ?? [], env: spec.env ?? {} }
    : { url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) };
}

/** The [mcp_servers.<name>] table. Headers are left out: Codex takes them in its own keys. */
export function codexMcpTable(spec: McpServerSpec): Plain {
  return mcpTransport(spec) === "stdio"
    ? {
        command: spec.command,
        ...(spec.args ? { args: spec.args } : {}),
        ...(spec.env ? { env: spec.env } : {}),
      }
    : { url: spec.url };
}

export function opencodeMcpServer(spec: McpServerSpec): Plain {
  return mcpTransport(spec) === "stdio"
    ? {
        type: "local",
        command: [spec.command, ...(spec.args ?? [])],
        ...(spec.env ? { environment: spec.env } : {}),
      }
    : { type: "remote", url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) };
}

export function gooseExtension(name: string, spec: McpServerSpec): Plain {
  return mcpTransport(spec) === "stdio"
    ? {
        name,
        type: "stdio",
        enabled: true,
        cmd: spec.command,
        args: spec.args ?? [],
        envs: spec.env ?? {},
        env_keys: [],
        timeout: 300,
      }
    : {
        name,
        type: "streamable_http",
        enabled: true,
        uri: spec.url,
        headers: spec.headers ?? {},
        envs: {},
        env_keys: [],
        timeout: 300,
      };
}
