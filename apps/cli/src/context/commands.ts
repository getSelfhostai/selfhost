import { dirname, relative, resolve } from "node:path";
import {
  AGENT_NAMES,
  applyContextPlan,
  buildContext,
  CONTEXT_DIR,
  type Conflict,
  type ContextError,
  type Drift,
  type FileAction,
  formatContextError,
  LOCK_PATH,
} from "@selfhost/context";
import {
  CONTEXT_AGENTS,
  type ContextAgent,
  type ContextConflict,
  type ContextCoverage,
  type ContextItemCoverage,
  type ContextLayerKind,
} from "@selfhost/schema";
import type { Command } from "commander";
import { findConfig } from "../find-config.js";
import { plural, table } from "../format.js";
import { repoDir } from "../scan/index.js";
import type { Fetch } from "../team/client.js";
import { localLayers, rememberRepo } from "./layers.js";
import { registerContextTeam } from "./team-commands.js";

export interface ContextIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  setExitCode: (code: number) => void;
  /** ~/.selfhost/config.json: the org, team and personal layers sit next to it. */
  configPath: string;
  fetch: Fetch;
  /**
   * The agents found on this machine, for a first compile with no --agent. Default: none found,
   * so a first compile writes for every agent.
   */
  detect?: () => ContextAgent[];
}

export interface ContextCompileOptions {
  agent?: string[];
  out?: string;
  check?: boolean;
  force?: boolean;
  json?: boolean;
  config?: string;
  /** false (--no-layers): the repository's .selfhost/context only, as CI checks it. */
  layers?: boolean;
}

/** `selfhost context compile --json` and `selfhost context check --json`. */
export interface ContextCompileReport {
  schema: "selfhost.context_compile/v1";
  /** The folder that holds .selfhost/context, next to selfhost.toml. */
  root: string;
  /** Where the files go: root, or --out. */
  target: string;
  check: boolean;
  /** False when the source is invalid, a file conflicts, or (with check) a file drifted. */
  ok: boolean;
  agents: ContextAgent[];
  /** Problems in the source, by file and line. */
  errors: ContextError[];
  /**
   * The layers merged, in order: the org's and team's as pulled on the last sync, the
   * repository's own and the person's.
   */
  layers: { kind: ContextLayerKind; name: string }[];
  /** Items a later layer defined again; the earlier layer's item is used. */
  layer_conflicts: ContextConflict[];
  coverage: ContextCoverage | null;
  files: { path: string; action: FileAction; sources: string[] }[];
  /** Files that differ from what the source compiles to. */
  drift: Drift[];
  /** Files the compile would replace that selfhost did not write. Nothing is written then. */
  conflicts: Conflict[];
  warnings: string[];
  /** The lock that records what each agent received, or null when nothing was compiled. */
  lock: string | null;
}

const AGENT_ALIASES: Record<string, ContextAgent> = {
  claude: "claude_code",
  "claude-code": "claude_code",
  "gemini-cli": "gemini",
  gemini_cli: "gemini",
};

export function parseContextAgent(value: string): ContextAgent {
  const name = value.trim().toLowerCase();
  const agent =
    AGENT_ALIASES[name] ??
    CONTEXT_AGENTS.find((candidate) => candidate === name.replaceAll("-", "_"));
  if (!agent) {
    throw new Error(
      `--agent: expected claude, codex, cursor, copilot, gemini, opencode or goose, got "${value}"`,
    );
  }
  return agent;
}

/** The folder with .selfhost/context: next to selfhost.toml, else the git root, else cwd. */
export function contextRoot(
  cwd: string,
  config: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const found = findConfig(cwd, config, env);
  if (found) return dirname(found.path);
  return repoDir(undefined, cwd) ?? resolve(cwd);
}

const CELL: Record<ContextItemCoverage["status"], string> = {
  compiled: "compiled",
  partial: "partial",
  not_expressible: "none",
  not_applicable: "n/a",
};

function printCoverage(
  coverage: ContextCoverage,
  versions: Map<string, string>,
  write: (line: string) => void,
) {
  const agents = coverage.agents.map((entry) => entry.agent);
  const byItem = new Map<string, ContextItemCoverage[]>();
  for (const entry of coverage.items)
    byItem.set(entry.item, [...(byItem.get(entry.item) ?? []), entry]);
  const rows = [...byItem].map(([item, entries]) => [
    versions.has(item) ? `${item}@${versions.get(item)}` : item,
    ...agents.map((agent) => {
      const entry = entries.find((candidate) => candidate.agent === agent);
      if (!entry) return "";
      return `${CELL[entry.status]}${entry.status === "not_applicable" && entry.files.length > 0 ? "*" : ""}`;
    }),
  ]);
  table([["item", ...agents], ...rows], write);
  write("");
  write(
    "compiled: the agent loads the item as written. partial: some of it. none: the agent can't express it. n/a: not for this agent; n/a*: not for it, but it reads the item anyway.",
  );
  const section = (title: string, entries: ContextItemCoverage[]) => {
    if (entries.length === 0) return;
    write("");
    write(title);
    for (const entry of entries) write(`  ${entry.agent} ${entry.item}: ${entry.detail}`);
  };
  section(
    "Gaps:",
    coverage.items.filter(
      (entry) => entry.status === "partial" || entry.status === "not_expressible",
    ),
  );
  section(
    "Read by agents they are not for:",
    coverage.items.filter((entry) => entry.status === "not_applicable" && entry.files.length > 0),
  );
  const notes = coverage.agents.filter((entry) => entry.notes.length > 0);
  if (notes.length > 0) {
    write("");
    write("Agent notes:");
    for (const entry of notes) for (const note of entry.notes) write(`  ${entry.agent}: ${note}`);
  }
}

/**
 * Compiles .selfhost/context into each agent's files in the repository (or --out), and prints
 * what every agent gets per item. With `check`, writes nothing and fails when a generated file
 * differs from what the source compiles to.
 */
export async function contextCompile(
  options: ContextCompileOptions,
  io: ContextIo,
): Promise<ContextCompileReport> {
  const root = contextRoot(io.cwd, options.config, io.env);
  const agents = options.agent?.length
    ? [...new Set(options.agent.map(parseContextAgent))]
    : undefined;
  const out = options.out === undefined ? undefined : resolve(io.cwd, options.out);
  const check = options.check === true;
  const local = options.layers === false ? { layers: [], errors: [] } : localLayers(io.configPath);
  const built =
    local.errors.length > 0
      ? ({ ok: false, errors: local.errors } as const)
      : await buildContext(root, {
          agents,
          out,
          force: options.force,
          layers: local.layers,
          ...(agents === undefined && io.detect ? { detected: io.detect() } : {}),
        });
  const report: ContextCompileReport = {
    schema: "selfhost.context_compile/v1",
    root,
    target: out ?? root,
    check,
    ok: false,
    agents: built.ok ? built.result.agents : [],
    errors: built.ok ? [] : built.errors,
    layers: built.ok ? built.layers : [],
    layer_conflicts: built.ok ? built.conflicts : [],
    coverage: built.ok ? built.result.coverage : null,
    files: built.ok
      ? built.plan.files.map(({ path, action, sources }) => ({ path, action, sources }))
      : [],
    drift: built.ok ? built.plan.drift : [],
    conflicts: built.ok && !check ? built.plan.conflicts : [],
    warnings: built.ok ? built.warnings : [],
    lock: built.ok ? LOCK_PATH : null,
  };
  if (built.ok) {
    report.ok = check ? report.drift.length === 0 : report.conflicts.length === 0;
    if (!check && report.ok) {
      applyContextPlan(report.target, built.plan);
      if (out === undefined && local.layers.some((layer) => layer.kind !== "personal")) {
        rememberRepo(io.configPath, root);
      }
    }
  }
  if (!report.ok) io.setExitCode(1);
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return report;
  }
  const versions = new Map(
    built.ok ? built.source.skills.map((skill) => [`skill:${skill.name}`, skill.version]) : [],
  );
  print(report, versions, io);
  return report;
}

function print(report: ContextCompileReport, versions: Map<string, string>, io: ContextIo): void {
  const shown = (path: string) => {
    const rel = relative(io.cwd, path);
    return rel === "" ? "." : rel.startsWith("..") ? path : rel;
  };
  if (report.errors.length > 0) {
    const layered = report.errors.some((error) => !error.file.startsWith(CONTEXT_DIR));
    io.write(
      `${layered ? "The context layers on this machine have" : `${CONTEXT_DIR} has`} ${plural(report.errors.length, "problem")}:`,
    );
    for (const error of report.errors) io.write(`  ${formatContextError(error)}`);
    io.write("");
    io.write(
      `Nothing was ${report.check ? "checked" : "written"}. Fix the source, then run the command again.`,
    );
    return;
  }
  const names = report.agents.map((agent) => AGENT_NAMES[agent]).join(", ");
  if (report.check) {
    if (report.drift.length === 0) {
      io.write(
        `${CONTEXT_DIR} compiles to the files in ${shown(report.target)} for ${names}: ${plural(report.files.length, "file")} match.`,
      );
    } else {
      io.write(
        `${plural(report.drift.length, "generated file")} in ${shown(report.target)} ${report.drift.length === 1 ? "differs" : "differ"} from ${CONTEXT_DIR}:`,
      );
      for (const drift of report.drift) io.write(`  ${drift.message}`);
    }
    for (const warning of report.warnings) io.write(`Warning: ${warning}`);
    return;
  }
  io.write(`Compiled ${CONTEXT_DIR} for ${names} into ${shown(report.target)}.`);
  if (report.layers.length > 1) {
    const named = report.layers.map(({ kind, name }) =>
      kind === "repo" ? "this repository" : kind === "personal" ? "yours" : `${kind} ${name}`,
    );
    io.write(`Layers, earliest first (an earlier layer's item wins): ${named.join(", ")}.`);
  }
  if (report.layer_conflicts.length > 0) {
    io.write("");
    io.write(`${plural(report.layer_conflicts.length, "item")} lost to an earlier layer:`);
    for (const conflict of report.layer_conflicts) io.write(`  ${conflict.message}`);
  }
  io.write("");
  if (report.coverage) printCoverage(report.coverage, versions, io.write);
  if (report.warnings.length > 0) {
    io.write("");
    io.write("Warnings:");
    for (const warning of report.warnings) io.write(`  ${warning}`);
  }
  io.write("");
  if (report.conflicts.length > 0) {
    io.write(
      `Nothing was written: ${plural(report.conflicts.length, "file")} would be replaced that selfhost did not write.`,
    );
    for (const conflict of report.conflicts) io.write(`  ${conflict.message}`);
    return;
  }
  const count = (action: FileAction) =>
    report.files.filter((file) => file.action === action).length;
  const changed = report.files.length - count("unchanged");
  io.write(
    changed === 0
      ? `All ${plural(report.files.length, "file")} were already up to date.`
      : `Wrote ${plural(changed, "file")} (${count("create")} created, ${count("update")} updated, ${count("delete")} removed); ${count("unchanged")} unchanged. ${LOCK_PATH} records the skill version each agent received.`,
  );
}

/** Adds `context compile` and `context check`. */
export function registerContext(
  program: Command,
  io: () => ContextIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const context = program
    .command("context")
    .description(
      "compile the rules, skills, commands, subagents and MCP servers in .selfhost/context, merged with the org, team and personal layers, into each agent's own files",
    );

  context
    .command("compile")
    .description(
      "write each agent's files from .selfhost/context and print what every agent gets per item",
    )
    .option(
      "--agent <name...>",
      "claude, codex, cursor, copilot, gemini, opencode or goose (default: the agents of the last compile, else those found on this machine and those an item names)",
    )
    .option("--out <dir>", "write into this folder instead of the repository")
    .option("--check", "write nothing; exit 1 when a generated file differs from the source")
    .option("--force", "replace files selfhost did not write")
    .option(
      "--no-layers",
      "the repository's .selfhost/context only, without the org, team and personal layers",
    )
    .option("-c, --config <path>", "path to selfhost.toml; .selfhost/context sits next to it")
    .option("--json", "print JSON")
    .action(async (options: ContextCompileOptions) => {
      try {
        await contextCompile(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });

  context
    .command("check")
    .description(
      "exit 1 when a generated file differs from what .selfhost/context compiles to (for CI)",
    )
    .option(
      "--no-layers",
      "the repository's .selfhost/context only, without the org, team and personal layers",
    )
    .option("-c, --config <path>", "path to selfhost.toml; .selfhost/context sits next to it")
    .option("--json", "print JSON")
    .action(async (options: Pick<ContextCompileOptions, "config" | "json" | "layers">) => {
      try {
        await contextCompile({ ...options, check: true }, io());
      } catch (error) {
        fail(error, options.json);
      }
    });

  registerContextTeam(context, io, fail);
}
