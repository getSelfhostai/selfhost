import type { CompileVendor, RuleMatch } from "@selfhost/schema";
import { ownName, type ToolKind, toolKind } from "./tools.js";

export const VENDOR_NAMES: Record<CompileVendor, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
};

/** What a rule's match means on one vendor, before any native syntax. */
export type Target =
  | { kind: "command"; pattern: string }
  /** access: any when no tool is named, else the kind of the named tool. */
  | { kind: "path"; glob: string; access: "any" | "read" | "edit" }
  | { kind: "url"; glob: string }
  | { kind: "tool"; tool: string; toolKind: ToolKind }
  /** Several conditions on one call: no vendor's native rules combine them. */
  | { kind: "combined"; fields: string[] }
  /** The rule can't match a call on this vendor. */
  | { kind: "never"; reason: string };

/**
 * Reads a rule's match the way evaluate does: every field must match, tool names are exact,
 * and a field the call does not carry (a command on a file tool) never matches.
 */
export function targetOf(vendor: CompileVendor, match: RuleMatch): Target {
  const name = VENDOR_NAMES[vendor];
  const tool = match.tool;
  const kind = tool === undefined ? undefined : toolKind(vendor, tool);
  if (tool !== undefined && kind === "foreign") {
    const own = ownName(vendor, tool);
    return {
      kind: "never",
      reason: own
        ? `${tool} is another agent's tool name: ${name} reports this tool as ${own}`
        : `${tool} is another agent's tool name, and ${name} has no such tool`,
    };
  }
  const fields = (["command", "path", "url"] as const).filter(
    (field) => match[field] !== undefined,
  );
  if (fields.length > 1) return { kind: "combined", fields: [...fields] };
  const [field] = fields;
  if (field === undefined) {
    return { kind: "tool", tool: tool as string, toolKind: kind as ToolKind };
  }
  if (field === "command") {
    if (kind !== undefined && kind !== "shell") {
      return { kind: "never", reason: `only shell calls carry a command, and ${tool} is not one` };
    }
    return { kind: "command", pattern: match.command as string };
  }
  if (field === "path") {
    const glob = match.path as string;
    if (kind === undefined) return { kind: "path", glob, access: "any" };
    if (kind === "read" || kind === "edit") return { kind: "path", glob, access: kind };
    if (kind === "other") return { kind: "combined", fields: ["tool", "path"] };
    return { kind: "never", reason: `${tool} calls carry no file path` };
  }
  const url = match.url as string;
  if (kind === undefined || kind === "fetch") return { kind: "url", glob: url };
  if (kind === "other" || kind === "mcp") return { kind: "combined", fields: ["tool", "url"] };
  return { kind: "never", reason: `${tool} calls carry no URL` };
}
