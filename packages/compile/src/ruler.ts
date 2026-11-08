import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompileVendor } from "@selfhost/schema";

/**
 * Ruler (https://github.com/intellectronica/ruler, MIT) writes each agent's rules file from
 * the Markdown in a repository's .ruler/ folder. selfhost puts the policy text there as
 * .ruler/selfhost-policy.md and lets Ruler write the files.
 *
 * What a Ruler run writes, checked by running Ruler 0.3.46 (see test/ruler.test.ts): the rules
 * files (CLAUDE.md for Claude Code, AGENTS.md for Codex, Cursor and Copilot), and with MCP on,
 * the project MCP configs (.mcp.json, .cursor/mcp.json, and a rewrite of .codex/config.toml).
 * It refuses to write outside the project root. selfhost's managed settings, requirements.toml,
 * hooks.json and the Copilot settings all live outside the repository, so no Ruler run, ours or
 * a person's own, can overwrite them.
 */

/** Ruler's agent ids for the vendors whose rules files it writes. */
export const RULER_AGENTS: Record<CompileVendor, string> = {
  claude_code: "claude",
  codex: "codex",
  cursor: "cursor",
  copilot: "copilot",
};

/** Ruler marks each section of a file it wrote with the .ruler/ file it came from. */
const RULER_SOURCE_MARK = "<!-- Source: .ruler/";

/**
 * Rules files Ruler would replace that it did not write: an AGENTS.md or CLAUDE.md written by
 * hand in a repository that has no .ruler/ folder yet. Ruler replaces those whole.
 */
export function handWrittenRulesFiles(root: string): string[] {
  if (existsSync(join(root, ".ruler"))) return [];
  return ["AGENTS.md", "CLAUDE.md"].filter((name) => {
    const path = join(root, name);
    return existsSync(path) && !readFileSync(path, "utf8").includes(RULER_SOURCE_MARK);
  });
}

export interface RulerOptions {
  /** Let Ruler add the files it writes to .gitignore. Default: what .ruler/ruler.toml says. */
  gitignore?: boolean;
  /** Let Ruler keep a .bak copy of each file it replaces. Default: what ruler.toml says. */
  backup?: boolean;
}

type Console = Pick<typeof console, "log" | "info" | "warn" | "error">;

/**
 * Runs Ruler in `root` for the given vendors and returns what it printed. MCP propagation is
 * off, so the run writes rules files only and never rewrites an agent's MCP config. The rest
 * (skills, subagents, and by default .gitignore and backups) follows the repository's
 * .ruler/ruler.toml, as a person's own `ruler apply` would. Ruler's global config folder is
 * not read. Ruler prints through console, so its output is collected instead of printed.
 */
export async function runRuler(
  root: string,
  vendors: readonly CompileVendor[],
  options: RulerOptions = {},
): Promise<string[]> {
  return runRulerAgents(
    root,
    vendors.map((vendor) => RULER_AGENTS[vendor]),
    options,
  );
}

/**
 * runRuler for Ruler's own agent ids (claude, codex, copilot, cursor, gemini-cli, goose,
 * opencode, ...), for callers that write rules files for agents beyond the policy vendors.
 */
export async function runRulerAgents(
  root: string,
  agents: readonly string[],
  options: RulerOptions = {},
): Promise<string[]> {
  const ruler = await import("@intellectronica/ruler");
  // Ruler is CommonJS: a bundled CLI gets it back as the default export.
  const { applyAllAgentConfigs } =
    typeof ruler.applyAllAgentConfigs === "function"
      ? ruler
      : (ruler as unknown as { default: typeof ruler }).default;
  const log: string[] = [];
  const saved: Console = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const collect = (...args: unknown[]) => {
    log.push(args.map(String).join(" "));
  };
  Object.assign(console, { log: collect, info: collect, warn: collect, error: collect });
  try {
    await applyAllAgentConfigs(
      root,
      [...agents],
      undefined, // config path: root/.ruler/ruler.toml
      false, // MCP
      undefined, // MCP strategy
      options.gitignore,
      false, // verbose
      false, // dry run
      true, // local only: ignore Ruler's global config folder
      false, // nested .ruler folders
      options.backup,
    );
  } finally {
    Object.assign(console, saved);
  }
  return log;
}
