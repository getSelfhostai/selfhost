import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { AgentVendor, LedgerEvent } from "@selfhost/schema";

/** One tool call, in the terms rules match on. */
export interface ToolCall {
  agent?: AgentVendor;
  /** Tool name as the agent reports it, for example Bash, exec_command or mcp__github__get_issue. */
  tool: string;
  /**
   * Shell command. Read from the ledger it is the stored summary: the first line, with secrets
   * masked, at most 120 characters.
   */
  command?: string;
  /** File path relative to the repository root, with `/` separators. */
  path?: string;
  url?: string;
  /** Server part of an MCP tool name. */
  mcpServer?: string;
  model?: string;
}

const MCP_PREFIX = "mcp__";
const MCP_DELIMITER = "__";

/**
 * The MCP server a tool name points at. Claude Code and Codex both name MCP tools
 * `mcp__<server>__<tool>`. A name with no second delimiter (agents shorten very long tool
 * names) keeps the rest of the name as the server, so it still fails an allow list that does
 * not name it instead of passing unchecked.
 */
export function mcpServerOf(tool: string): string | undefined {
  if (!tool.startsWith(MCP_PREFIX)) return undefined;
  const rest = tool.slice(MCP_PREFIX.length);
  const end = rest.indexOf(MCP_DELIMITER);
  const server = end === -1 ? rest : rest.slice(0, end);
  return server === "" ? undefined : server;
}

/** A relative path with `/` separators and no `./` segments, as rule globs expect it. */
export function normalizePath(path: string): string {
  const normalized = posix.normalize(path.split(sep).join("/"));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

/** `path` relative to `root` with `/` separators, "" for root itself, undefined outside it. */
function inside(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/**
 * Maps a `tool.called` event to the call rules see. Undefined for any other event.
 *
 * With `repoRoot`, the call must belong to the repository: either its session ran inside it
 * (`cwd`, from the session's `session.started` event) or it touched a file inside it by
 * absolute path. File paths become relative to the root; a file outside the root drops the
 * path but keeps the call when the session ran inside. Relative paths in the ledger are
 * relative to the session's starting folder, so without `cwd` they cannot be placed and the
 * call is left out.
 */
export function toolCallFromEvent(
  event: LedgerEvent,
  repoRoot?: string,
  cwd?: string,
): ToolCall | undefined {
  if (event.kind !== "tool.called" || !event.tool) return undefined;
  const { target } = event;
  let path = target?.type === "file" ? target.value : undefined;
  if (repoRoot !== undefined) {
    const root = resolve(repoRoot);
    const base = cwd === undefined ? undefined : resolve(cwd);
    const sessionInside = base !== undefined && inside(root, base) !== undefined;
    if (path !== undefined) {
      const absolute = isAbsolute(path) ? path : base && resolve(base, path);
      const rel = absolute === undefined ? undefined : inside(root, absolute);
      path = rel === "" ? undefined : rel;
    }
    if (!sessionInside && path === undefined) return undefined;
  } else if (path !== undefined) {
    path = normalizePath(path);
  }
  const tool = event.tool.name;
  const mcpServer = mcpServerOf(tool);
  const command = target?.type === "command" ? target.value : undefined;
  const url = target?.type === "url" ? target.value : undefined;
  return {
    ...(event.agent ? { agent: event.agent.vendor } : {}),
    tool,
    ...(command !== undefined ? { command } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(mcpServer !== undefined ? { mcpServer } : {}),
    ...(event.model ? { model: event.model } : {}),
  };
}
