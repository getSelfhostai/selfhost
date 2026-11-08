import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentRef, AgentVendor } from "@selfhost/schema";
import { MCP_SERVER_NAME } from "@selfhost/schema";
import contract from "@selfhost/schema/mcp-tools.json" with { type: "json" };
import type { CallContext, McpData } from "./data.js";
import { McpToolError } from "./errors.js";
import { runTool } from "./tools.js";

/** The tools as mcp-tools.json lists them: the contract is what tools/list serves. */
export const TOOLS = contract.tools as unknown as Tool[];

export const INSTRUCTIONS = [
  "selfhost holds your team's rules, budget, review list and the history of agent runs.",
  "Before an action a rule may block, read get_policy. Before asking a person, search_decisions for an earlier answer.",
  "Before a large change to a file, list_active_on_file shows who else is working on it.",
  "When selfhost blocks a call and names an exception id, request_exception asks a person to allow it once; ask_human asks anything else. Both return an item_id at once: call get_answer with wait_seconds to wait for the answer.",
].join(" ");

export interface McpServerOptions {
  version: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Where an unexpected failure is reported. The agent gets an internal error, with the
   * message only when exposeErrors is set (this machine's own server); default: console.error.
   */
  onError?: (error: unknown) => void;
  exposeErrors?: boolean;
  /**
   * The client when the session cannot say: a stateless HTTP request has no initialize of its
   * own, so the server passes what the request's headers name.
   */
  client?: { name: string; version: string };
}

const VENDORS: [RegExp, AgentVendor][] = [
  [/claude/i, "claude_code"],
  [/codex/i, "codex"],
  [/cursor/i, "cursor"],
  [/opencode/i, "opencode"],
  [/goose/i, "goose"],
  [/copilot/i, "copilot"],
];

/** The agent behind an MCP client, from the name it gives in initialize. */
export function agentOf(
  client: { name: string; version: string } | undefined,
): AgentRef | undefined {
  if (!client) return undefined;
  const vendor = VENDORS.find(([pattern]) => pattern.test(client.name))?.[1];
  if (!vendor) return undefined;
  return { vendor, ...(client.version ? { version: client.version } : {}) };
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function errorResult(error: McpToolError): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(error.toJSON()) }], isError: true };
}

/**
 * The selfhost MCP server over `data`: tools/list serves mcp-tools.json and tools/call runs the
 * tool for the data's person. A tool that fails for a reason the agent can act on (a permission,
 * a missing item, a bad input) answers with isError and an ApiError body, never with data.
 */
export function createMcpServer(data: McpData, options: McpServerOptions): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: options.version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    if (!TOOLS.some((tool) => tool.name === name)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    const agent = agentOf(server.getClientVersion() ?? options.client);
    const context: CallContext = agent ? { agent } : {};
    try {
      const result = await runTool(name, args, {
        data,
        context,
        now: options.now ?? (() => new Date()),
        sleep: options.sleep ?? sleep,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (error) {
      if (error instanceof McpToolError) return errorResult(error);
      (options.onError ?? console.error)(error);
      const message =
        options.exposeErrors && error instanceof Error ? error.message : "Internal error";
      return errorResult(new McpToolError("internal", message));
    }
  });
  return server;
}
