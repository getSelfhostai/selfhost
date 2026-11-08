import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MCP_SERVER_NAME, MCP_WAIT_MAX_SECONDS } from "@selfhost/schema";
import { McpToolError } from "./errors.js";
import { INSTRUCTIONS } from "./server.js";

export interface ProxyOptions {
  /** The team server's MCP endpoint, such as https://selfhost.example.com/v1/mcp. */
  url: URL;
  /** The person token from `selfhost join`. It never leaves this process except to `url`. */
  token: string;
  version: string;
  fetch?: FetchLike;
  /** Changes a tool's result on its way back, such as adding this machine's grant. */
  onResult?: (name: string, result: CallToolResult) => Promise<CallToolResult>;
}

/**
 * Names the agent behind the proxy to the team server, which serves each request on its own and
 * so never sees the agent's initialize.
 */
export const CLIENT_HEADER = "x-selfhost-client";

/** A tool call that waits for an answer gets this much past its longest wait. */
const CALL_TIMEOUT_MS = (MCP_WAIT_MAX_SECONDS + 30) * 1000;

const failed = (code: "unavailable", message: string): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(new McpToolError(code, message).toJSON()) }],
  isError: true,
});

/**
 * A stdio server that hands every call to the team server's /v1/mcp with the person token, for
 * team mode: agents keep one local `selfhost mcp` entry and no token sits in their configs. The
 * tool list and every answer come from the server, so its permissions apply unchanged. The
 * connection opens on first use, with the agent's own client name, and opens again after a
 * failure.
 */
export function createProxyServer(options: ProxyOptions): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: options.version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  let connecting: Promise<Client> | undefined;
  const upstream = () => {
    connecting ??= (async () => {
      const agent = server.getClientVersion();
      const client = new Client({
        name: agent?.name ?? "selfhost-mcp",
        version: agent?.version ?? options.version,
      });
      const transport = new StreamableHTTPClientTransport(options.url, {
        requestInit: {
          headers: {
            authorization: `Bearer ${options.token}`,
            ...(agent ? { [CLIENT_HEADER]: `${agent.name}/${agent.version}` } : {}),
          },
        },
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      await client.connect(transport);
      return client;
    })().catch((error: unknown) => {
      connecting = undefined;
      throw error;
    });
    return connecting;
  };
  const unreachable = (error: unknown) =>
    `Could not reach the team server at ${options.url.origin}: ${error instanceof Error ? error.message : String(error)}`;

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const client = await upstream();
    return client.listTools(request.params);
  });
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    let result: CallToolResult;
    try {
      const client = await upstream();
      result = (await client.callTool(request.params, undefined, {
        timeout: CALL_TIMEOUT_MS,
      })) as CallToolResult;
    } catch (error) {
      connecting = undefined;
      return failed("unavailable", unreachable(error));
    }
    return options.onResult ? options.onResult(request.params.name, result) : result;
  });
  return server;
}
