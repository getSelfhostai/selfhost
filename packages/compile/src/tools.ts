import { COMPILE_VENDORS, type CompileVendor } from "@selfhost/schema";

/**
 * Tool names each vendor reports, by what the tool does. Rules match tool names exactly, so a
 * rule that names another vendor's tool never matches on this one.
 *
 * - Claude Code: https://code.claude.com/docs/en/tools-reference
 * - Codex: hook names from https://learn.chatgpt.com/docs/hooks (Bash, apply_patch, mcp__*),
 *   plus the names in its session logs (exec_command, shell, local_shell).
 * - Cursor: preToolUse names from https://cursor.com/docs/hooks (Shell, Read, Write, Delete,
 *   MCP:<tool>).
 * - Copilot: hook tool names from
 *   https://docs.github.com/en/copilot/reference/hooks-configuration (bash, view, edit, ...).
 */
interface ToolNames {
  shell: readonly string[];
  read: readonly string[];
  edit: readonly string[];
  fetch: readonly string[];
  /** Prefix of MCP tool names, or null when the vendor's naming is not documented. */
  mcp: string | null;
}

export const TOOL_NAMES: Record<CompileVendor, ToolNames> = {
  claude_code: {
    shell: ["Bash"],
    read: ["Read"],
    edit: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
    fetch: ["WebFetch"],
    mcp: "mcp__",
  },
  codex: {
    shell: ["Bash", "exec_command", "shell", "local_shell"],
    read: [],
    edit: ["apply_patch", "Edit", "Write"],
    fetch: [],
    mcp: "mcp__",
  },
  cursor: {
    shell: ["Shell"],
    read: ["Read"],
    edit: ["Write", "Delete"],
    fetch: [],
    mcp: "MCP:",
  },
  copilot: {
    shell: ["bash", "powershell"],
    read: ["view"],
    edit: ["create", "edit"],
    fetch: ["web_fetch"],
    mcp: null,
  },
};

export type ToolKind = "shell" | "read" | "edit" | "fetch" | "mcp" | "other";

const KINDS = ["shell", "read", "edit", "fetch"] as const;

/** What a tool name is on a vendor, or "foreign" when only other vendors report it. */
export function toolKind(vendor: CompileVendor, tool: string): ToolKind | "foreign" {
  const names = TOOL_NAMES[vendor];
  for (const kind of KINDS) if (names[kind].includes(tool)) return kind;
  if (names.mcp !== null && tool.startsWith(names.mcp)) return "mcp";
  for (const other of COMPILE_VENDORS) {
    if (other === vendor) continue;
    const theirs = TOOL_NAMES[other];
    if (KINDS.some((kind) => theirs[kind].includes(tool))) return "foreign";
    if (theirs.mcp !== null && tool.startsWith(theirs.mcp) && names.mcp !== null) {
      return "foreign";
    }
  }
  return "other";
}

/** The vendor's own name for a kind of tool, for messages. */
export function ownName(vendor: CompileVendor, tool: string): string | undefined {
  const names = TOOL_NAMES[vendor];
  for (const other of COMPILE_VENDORS) {
    const theirs = TOOL_NAMES[other];
    for (const kind of KINDS) {
      if (theirs[kind].includes(tool)) {
        return names[kind].length > 0 ? names[kind].join(" or ") : undefined;
      }
    }
    if (theirs.mcp !== null && tool.startsWith(theirs.mcp)) {
      return names.mcp === null ? undefined : `${names.mcp}<tool>`;
    }
  }
  return undefined;
}
