import { readFileSync } from "node:fs";
import { compilePolicy } from "@selfhost/compile";
import { validateConfig } from "@selfhost/schema";
import { managedFiles, systemPath } from "../policy/managed.js";

/** An agent whose managed settings on this machine already run `selfhost hook`. */
export interface ManagedHooks {
  agent: "claude_code" | "codex";
  /** The managed settings file that runs them. */
  path: string;
}

/** What each managed file holds when it runs selfhost's hooks. */
const MARKS: Record<ManagedHooks["agent"], { file: string; marks: string[] }> = {
  claude_code: { file: "managed-settings.d/selfhost.json", marks: ["hook claude_code"] },
  codex: { file: "requirements.toml", marks: ["selfhost-hook", "hook codex"] },
};

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The agents whose managed settings (installed by selfhost join or sync, or by device
 * management) run selfhost's hooks on this machine. A user hook for one of them would run the
 * hook a second time for every event.
 */
export function managedHooks(platform: string, root?: string): ManagedHooks[] {
  const config = validateConfig({ version: 1 });
  if (!config.ok) return [];
  const files = managedFiles(compilePolicy(config.config), platform);
  const found: ManagedHooks[] = [];
  for (const [agent, { file, marks }] of Object.entries(MARKS) as [
    ManagedHooks["agent"],
    (typeof MARKS)[ManagedHooks["agent"]],
  ][]) {
    const target = files.find((entry) => entry.vendor === agent && entry.name === file)?.target;
    if (target === undefined) continue;
    const path = systemPath(target, root);
    const text = read(path);
    if (text !== undefined && marks.some((mark) => text.includes(mark))) {
      found.push({ agent, path });
    }
  }
  return found;
}

/** Whether a user config file runs `selfhost hook` for the agent. */
export function userHookIn(path: string, agent: ManagedHooks["agent"]): boolean {
  const text = read(path);
  return text?.includes(`hook ${agent}`) === true;
}
