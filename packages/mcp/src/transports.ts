import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/**
 * The client a stateless request comes from: the proxy's x-selfhost-client header, else the
 * User-Agent, as name/version.
 */
export function clientOf(request: Request): { name: string; version: string } | undefined {
  const value = request.headers.get("x-selfhost-client") ?? request.headers.get("user-agent");
  const match = /^([^/\s]+)(?:\/(\S+))?/.exec(value?.trim() ?? "");
  return match?.[1] ? { name: match[1], version: match[2] ?? "" } : undefined;
}

/** A JSON-RPC error body for a request the transport never sees. */
function rpcError(status: number, message: string, headers: Record<string, string> = {}) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
}

/**
 * Answers one Streamable HTTP request, stateless: a fresh server and transport per request,
 * JSON responses instead of an SSE stream, and no session id. So any server process can answer
 * any request. GET (the server-to-client stream) and DELETE (ending a session) are not offered.
 */
export async function handleMcpHttp(
  request: Request,
  createServer: () => Server,
  parsedBody?: unknown,
): Promise<Response> {
  if (request.method !== "POST") {
    return rpcError(405, "Method not allowed: this server takes POST only", { allow: "POST" });
  }
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(
      request,
      parsedBody === undefined ? undefined : { parsedBody },
    );
  } finally {
    await server.close();
  }
}

/** Serves the server on stdin and stdout until stdin closes. */
export async function serveStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
}
