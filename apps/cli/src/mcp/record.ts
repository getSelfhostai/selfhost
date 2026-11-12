import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Where `selfhost mcp install` records the command it wrote, for selfhost doctor. */
export const mcpCommandRecord = (home: string) => join(home, ".selfhost", "mcp-command.json");

/** The absolute files of the recorded `selfhost mcp` command that are no longer there. */
export function movedMcpPaths(home: string): { command: string[]; missing: string[] } | null {
  let command: unknown;
  try {
    command = JSON.parse(readFileSync(mcpCommandRecord(home), "utf8")).command;
  } catch {
    return null;
  }
  if (!Array.isArray(command) || !command.every((word) => typeof word === "string")) return null;
  const files = command.filter((word) => isAbsolute(word));
  return { command, missing: files.filter((file) => !existsSync(file)) };
}
