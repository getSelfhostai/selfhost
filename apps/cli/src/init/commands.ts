import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  type AgentConfigPlan,
  type AgentId,
  type AgentStatus,
  locate,
  type PlanItem,
  type Which,
} from "@selfhost/agents";
import { discoverLogFiles } from "@selfhost/importers";
import { openLedger } from "@selfhost/ledger";
import { guardrailChecks } from "@selfhost/policy";
import { CONFIG_FILE_NAME, parseConfig } from "@selfhost/schema";
import type { Command } from "commander";
import {
  AGENT_ALIASES,
  type AgentsIo,
  agentScope,
  agentsReport,
  applyConfigure,
  type ConfigureReport,
  planConfigure,
  tilde,
} from "../agents.js";
import { findConfig } from "../find-config.js";
import { plural, table } from "../format.js";
import { drainSpool } from "../hooks/drain.js";
import { managedHooks } from "../hooks/managed-hooks.js";
import { spoolDir } from "../hooks/receive.js";
import {
  describeTarget,
  type ImportIo,
  type ImportReport,
  parseSince,
  runImport,
} from "../import.js";
import { type PolicyObserveReport, policyObserve } from "../policy/commands.js";
import { readContext } from "../scan/context/files.js";
import { repoDir } from "../scan/index.js";
import { listText } from "../scan/render-text.js";
import type { Ask } from "../scan/telemetry.js";
import { runSpend, type SpendReport } from "../spend.js";
import { type Fetch, serverUrl } from "../team/client.js";
import { joinTeam } from "../team/commands.js";
import { readMembership } from "../team/config.js";
import {
  applyContextImport,
  CONTEXT_SOURCE_DIR,
  type ContextImportPlan,
  type ImportFile,
  planContextImport,
} from "./context-import.js";
import { PRESET_NAMES, type PresetName } from "./presets.generated.js";
import {
  readRecord,
  recordApplied,
  recordCreated,
  recordPath,
  sameBytes,
  type UndoReport,
  undoInit,
} from "./record.js";
import {
  configText,
  parsePreset,
  presetModes,
  STARTER_RULES,
  writeStarterConfig,
} from "./starter.js";

/** The hosted team server, until SELFHOST_HOSTED_URL says otherwise. */
export const HOSTED_URL = "https://app.selfhost.ai";

/** Agents whose hook payloads the ledger can map. */
const HOOKED: readonly AgentId[] = ["claude_code", "codex"];
/** Every agent --agent takes, as people type them. */
const AGENT_NAMES_TEXT = "claude, codex, cursor, opencode or goose";

export interface InitIo extends AgentsIo {
  setExitCode: (code: number) => void;
  /** Where the team membership is kept. Default: ~/.selfhost/config.json. */
  configPath?: string;
  fetch?: Fetch;
  retry?: ImportIo["retry"];
  /** Asks whether to import the context files; undefined when stdin is not a terminal. */
  ask?: Ask;
  /** Read system paths (managed settings) under this folder instead; for images and tests. */
  systemRoot?: string;
}

export interface InitOptions {
  since?: string;
  team?: string;
  server?: string;
  hosted?: boolean;
  agent?: string[];
  person?: string;
  database?: string;
  dataDir?: string;
  dryRun?: boolean;
  undo?: boolean;
  yes?: boolean;
  json?: boolean;
  /** Write this preset as selfhost.toml instead of the starter rules. */
  preset?: string;
  /** true: import the context files without asking; false: do not import or ask. */
  importContext?: boolean;
  /** Treat this folder as the home directory; for fixtures and tests. */
  home?: string;
}

type HookStatus = PlanItem["status"] | "skipped";

export interface InitAgent {
  id: AgentId;
  name: string;
  installed: boolean;
  config_path: string;
  config_exists: boolean;
  /** What happened to the hooks; null for an agent that was not found. */
  hooks: HookStatus | null;
  message: string | null;
  files: ConfigureReport["agents"][number]["files"];
}

/** The offer to import the context files into `.selfhost/context/`. */
export interface InitContext {
  /** Context files found in the repository and the home folder. */
  found: number;
  dir: string;
  /**
   * imported: written now. would_import: --dry-run with --import-context. offered: found, not
   * imported; --import-context imports them. declined: the answer was no, or
   * --no-import-context. nothing: nothing new to import.
   */
  status: "imported" | "would_import" | "offered" | "declined" | "nothing";
  /** What the import writes (or wrote), and the files each came from. */
  files: { path: string; from: string[]; action: ImportFile["action"] }[];
  skipped: ContextImportPlan["skipped"];
  notes: string[];
}

/** `selfhost init --json`. */
export interface InitReport {
  schema: "selfhost.init/v1";
  dry_run: boolean;
  home: string;
  mode: "solo" | "team";
  team: { server: string; team: string | null; person: string | null; joined: boolean } | null;
  hook_command: string;
  /** Where hook events wait for the next `selfhost import`. */
  spool: string | null;
  agents: InitAgent[];
  /** How to put the agent config files back, byte for byte. */
  undo: string;
  /** preset: the preset written, null for the starter rules or when nothing was written. */
  config: { path: string | null; action: "created" | "kept" | "none"; preset: PresetName | null };
  /** Context files and the offer to import them; null outside a git repository. */
  context: InitContext | null;
  /** Dry run: what would be imported. */
  sources: { log_files: number; hook_lines: number; ledger: string } | null;
  import: ImportReport | null;
  spend: SpendReport | null;
  observe: PolicyObserveReport | null;
  warnings: string[];
}

const UNDO_COMMAND = "selfhost init --undo";

/**
 * The invite as --team <invite> with --server or --hosted, or the whole line `selfhost team
 * init` prints (`selfhost join <server> <invite>`), or just `<server> <invite>`.
 */
export function parseInvite(
  options: Pick<InitOptions, "team" | "server" | "hosted">,
  env: NodeJS.ProcessEnv,
): { server: string; invite: string } | undefined {
  if (options.hosted && options.server) throw new Error("pass --server or --hosted, not both");
  if (options.team === undefined) {
    if (options.hosted || options.server) {
      throw new Error(`${options.hosted ? "--hosted" : "--server"} needs --team <invite>`);
    }
    return undefined;
  }
  const words = options.team.trim().split(/\s+/);
  if (words[0] === "selfhost" && words[1] === "join") words.splice(0, 2);
  const [pastedServer, invite] = words.length === 2 ? words : [undefined, words[0]];
  if (words.length > 2 || !invite) {
    throw new Error(
      '--team: expected the invite, "<server> <invite>" or "selfhost join <server> <invite>"',
    );
  }
  const flag = options.hosted ? env.SELFHOST_HOSTED_URL?.trim() || HOSTED_URL : options.server;
  if (pastedServer && flag && serverUrl(pastedServer) !== serverUrl(flag)) {
    throw new Error(`--team names ${serverUrl(pastedServer)} but the server flag is ${flag}`);
  }
  const server = pastedServer ?? flag;
  if (!server) {
    throw new Error(
      "--team needs the server: pass --server <url> or --hosted, or paste the whole selfhost join line",
    );
  }
  return { server: serverUrl(server), invite };
}

/** Which built-in guardrails block, under the preset or starter file init writes. */
export function guardrailLine(preset: PresetName | undefined): string {
  const result = parseConfig(configText(preset));
  if (!result.ok) throw new Error("the selfhost.toml init writes does not validate");
  const checks = guardrailChecks(result.config);
  const blocking = checks.filter((check) => check.mode === "enforce").map((check) => check.id);
  if (blocking.length === 0) return "none block; the hooks only record what they catch.";
  return `${blocking.join(", ")} block in every hook from the start, whatever the rules' modes. [guardrails] in selfhost.toml changes that.`;
}

const shellQuote = (text: string) =>
  /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * `selfhost hook {agent}` when selfhost is on PATH, as compiled managed settings call it.
 * Otherwise a command that finds selfhost each time the hook runs: `selfhost` on PATH by then,
 * else the node and script running now while both still exist, else `npx selfhostai`. So a node
 * version switch, which takes the node binary or the global install off PATH, does not break
 * the hooks.
 */
export function hookCommand(which: Which | undefined): { command: string; warning?: string } {
  if (which?.("selfhost")) return { command: "selfhost hook {agent}" };
  const script = process.argv[1];
  const self =
    script && /\.[cm]?js$/.test(script) && existsSync(script)
      ? [process.execPath, script]
      : [process.execPath];
  const exists = self.map((path, i) => `[ ${i === 0 ? "-x" : "-f"} ${shellQuote(path)} ]`);
  const command = [
    "if command -v selfhost >/dev/null 2>&1; then exec selfhost hook {agent};",
    `elif ${exists.join(" && ")}; then exec ${self.map(shellQuote).join(" ")} hook {agent};`,
    "else exec npx -y selfhostai hook {agent}; fi",
  ].join(" ");
  return {
    command,
    warning:
      "selfhost is not on PATH, so each hook looks for it when it runs: on PATH, then where it runs now, then npx selfhostai. Install it (npm install -g selfhostai) and run selfhost init again for the plain selfhost hook command.",
  };
}

function hookAgents(names: string[] | undefined, detected: AgentStatus[]): AgentId[] {
  if (!names?.length) {
    return detected
      .filter((agent) => HOOKED.includes(agent.id) && (agent.installed || agent.configExists))
      .map((agent) => agent.id);
  }
  return names.map((name) => {
    const id = AGENT_ALIASES[name.trim().toLowerCase()];
    if (!id) throw new Error(`--agent: expected ${AGENT_NAMES_TEXT}, got "${name}"`);
    return id;
  });
}

/** Reasons to leave an agent's files alone, found before anything is written. */
function screen(plan: AgentConfigPlan): string | undefined {
  if (!HOOKED.includes(plan.agent)) {
    return "init hooks Claude Code and Codex; selfhost guard install adds the guardrail hook to this agent";
  }
  if (plan.items.some((item) => item.status === "remove")) {
    return "selfhost agents configure set other settings here; left as is so they stay (add hooks with selfhost agents configure)";
  }
  const unsafe = plan.changes.find(
    (change) =>
      change.role === "config" && change.before !== null && !sameBytes(change.path, change.before),
  );
  if (unsafe) return `${unsafe.path} is not UTF-8 text, so it could not be restored byte for byte`;
  return undefined;
}

function agentRow(
  agent: AgentStatus,
  plan: AgentConfigPlan | undefined,
  skipped: string | undefined,
  configured: ConfigureReport | undefined,
): InitAgent {
  const item = plan?.items.find((entry) => entry.item === "hooks");
  const wanted = plan !== undefined || skipped !== undefined;
  const found = agent.installed || agent.configExists;
  return {
    id: agent.id,
    name: agent.name,
    installed: agent.installed,
    config_path: agent.configPath,
    config_exists: agent.configExists,
    hooks: skipped ? "skipped" : (item?.status ?? (found || wanted ? "skipped" : null)),
    message:
      skipped ??
      item?.message ??
      (found && !wanted ? "selfhost has no hook mapping for this agent yet" : null),
    files:
      configured?.agents
        .find((entry) => entry.agent === agent.id)
        ?.files.filter((file) => file.role === "config") ?? [],
  };
}

const HOOK_WORDS: Record<HookStatus, string> = {
  create: "added",
  update: "updated",
  unchanged: "already set",
  remove: "removed",
  conflict: "conflict",
  unsupported: "unsupported",
  error: "error",
  skipped: "skipped",
};

/** Relative to cwd when the file is under it. */
const shown = (cwd: string, path: string) => {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
};

function printHeader(
  report: InitReport,
  write: (line: string) => void,
  cwd: string,
  undoable: boolean,
): void {
  const { home } = report;
  if (report.dry_run) write("Dry run: nothing is written and no server is contacted.");
  if (report.team) {
    const { server, team, person, joined } = report.team;
    if (report.dry_run && joined) write(`Would join a team on ${server} with the invite.`);
    else if (joined) write(`Joined team ${team} on ${server} as ${person}.`);
    else write(`Already in team ${team} on ${server} as ${person}.`);
    write("");
  }

  write("Agents");
  const status = (agent: InitAgent) =>
    agent.installed ? "installed" : agent.config_exists ? "config only" : "not found";
  table(
    report.agents.map((agent) => [
      `  ${agent.name}`,
      status(agent),
      tilde(agent.config_path, home) + (agent.config_exists ? "" : " (none yet)"),
    ]),
    write,
  );
  write("");

  const hooked = report.agents.filter((agent) => agent.hooks !== null);
  write(`Hooks: ${report.hook_command.replace("{agent}", "<agent>")}`);
  if (hooked.length === 0) write("  No Claude Code or Codex found: no hooks to add.");
  table(
    hooked.map((agent) => {
      const file = agent.files[0];
      const where = file ? tilde(file.path, home) : "";
      const backup = file?.backup ? `backup ${tilde(file.backup, home)}` : "";
      const word = HOOK_WORDS[agent.hooks ?? "skipped"];
      return [
        `  ${agent.name}`,
        report.dry_run && file ? `would be ${word}` : word,
        [where, backup, agent.message ?? ""].filter(Boolean).join("  "),
      ];
    }),
    write,
  );
  if (undoable) {
    write(
      `  Undo: ${UNDO_COMMAND} puts each file back byte for byte from its backup` +
        " (agents configure --remove takes the hooks out but rewrites the file).",
    );
  }
  write("");

  const { config } = report;
  const file = config.path ? shown(cwd, config.path) : "";
  if (config.action === "kept") write(`Policy: kept ${file}.`);
  else if (config.action === "created" && config.preset) {
    const verb = report.dry_run ? "would write" : "wrote";
    const modes = presetModes(config.preset);
    const rules = modes.enforce + modes.observe + modes.off;
    write(
      `Policy: ${verb} ${file} from the ${config.preset} preset, ${rules} rules ` +
        `(${modes.enforce} enforce, ${modes.observe} observe).`,
    );
  } else if (config.action === "created") {
    const verb = report.dry_run ? "would write" : "wrote";
    write(
      `Policy: ${verb} ${file}, ${STARTER_RULES} rules, all in observe mode: they record and block nothing yet.`,
    );
  } else if (report.mode === "team") {
    write(
      "Policy: the team's policy applies here, so no selfhost.toml was written. A repository file adds rules on top of it (selfhost init --preset); the team's rules stay the floor.",
    );
  } else write("Policy: not in a git repository, so no selfhost.toml was written.");
  if (config.action !== "kept") {
    write(`Guardrails: ${guardrailLine(config.preset ?? undefined)}`);
  }
  write("");
}

function printFooter(report: InitReport, write: (line: string) => void): void {
  write("");
  for (const warning of report.warnings) write(`Note: ${warning}`);
  if (report.spool) {
    write(
      `Hook events wait in ${tilde(report.spool, report.home)} until the next selfhost import;` +
        " keep `selfhost import --watch` running to see them live.",
    );
  }
  write(
    report.mode === "team"
      ? `Team mode: each selfhost import also sends the ledger to ${report.team?.server}.`
      : "Solo mode: everything stays on this laptop; no request went to any server.",
  );
}

function printUndo(report: UndoReport, home: string, write: (line: string) => void): void {
  if (report.files.length === 0) {
    write(`Nothing to undo: ${tilde(report.record, home)} lists no files from selfhost init.`);
    return;
  }
  const dry = report.dry_run;
  for (const file of report.files.filter((entry) => entry.role === "config")) {
    const path = tilde(file.path, home);
    if (file.action === "restored") {
      const from = file.backup ? tilde(file.backup, home) : "";
      write(`${dry ? "Would restore" : "Restored"} ${path} byte for byte from ${from}.`);
    } else if (file.action === "deleted") {
      write(`${dry ? "Would delete" : "Deleted"} ${path}, which selfhost init created.`);
    } else {
      write(`Left ${path} as is: ${file.message}.`);
    }
  }
  const imported = report.files.filter((entry) => entry.role === "context");
  const deleted = imported.filter((entry) => entry.action === "deleted");
  if (deleted.length > 0) {
    write(
      `${dry ? "Would delete" : "Deleted"} ${plural(deleted.length, "context file")} selfhost init imported into ${CONTEXT_SOURCE_DIR}/.`,
    );
  }
  for (const file of imported.filter((entry) => entry.action === "left")) {
    write(`Left ${file.path} as is: ${file.message}.`);
  }
  write(
    "Kept: the ledger, selfhost.toml, the context files init copied from and any team membership (selfhost team leave ends it).",
  );
}

const contextQuestion = (count: number) =>
  `Import ${plural(count, "file")} of agent context from this repository into ${CONTEXT_SOURCE_DIR}/? The originals stay as they are. [y/N] `;

/**
 * The offer to import the repository's context files into `.selfhost/context/`: --import-context
 * imports, --no-import-context does not, and otherwise init asks in a terminal. It never asks
 * with --json, --yes or --dry-run, or without a terminal; then the files are only listed.
 */
async function offerContext(
  plan: ContextImportPlan,
  found: number,
  options: InitOptions,
  io: InitIo,
  home: string,
): Promise<InitContext> {
  const creates = plan.files.filter((file) => file.action === "create");
  let status: InitContext["status"];
  if (creates.length === 0) status = "nothing";
  else if (options.importContext === false) status = "declined";
  else if (options.importContext === true) status = options.dryRun ? "would_import" : "imported";
  else if (options.dryRun || options.json || options.yes || !io.ask) status = "offered";
  else status = (await io.ask(contextQuestion(creates.length))) ? "imported" : "declined";
  if (status === "imported") {
    const written = await applyContextImport(plan);
    if (written.length > 0) recordCreated(recordPath(home), written);
  }
  return {
    found,
    dir: plan.dir,
    status,
    files: plan.files.map((file) => ({ path: file.path, from: file.from, action: file.action })),
    skipped: plan.skipped,
    notes: plan.notes,
  };
}

/** "4 rules, 1 skill and mcp.json". */
function sourceSummary(context: InitContext): string {
  const created = context.files.filter((file) => file.action === "create");
  const parts = created.map((file) => relative(context.dir, file.path).split(/[\\/]/));
  const count = (folder: string, word: string) => {
    const names = new Set(parts.filter((part) => part[0] === folder).map((part) => part[1]));
    return names.size > 0 ? [plural(names.size, word)] : [];
  };
  return listText([
    ...count("rules", "rule"),
    ...count("skills", "skill"),
    ...count("commands", "command"),
    ...count("agents", "subagent"),
    ...(parts.some((part) => part[0] === "mcp.json") ? ["mcp.json"] : []),
  ]);
}

function printContext(context: InitContext, cwd: string, write: (line: string) => void): void {
  const dir = `${shown(cwd, context.dir)}/`;
  const what = sourceSummary(context);
  const found = plural(context.found, "context file");
  const lines: Record<InitContext["status"], string> = {
    nothing: `Context: ${found} found; nothing new to import into ${dir}.`,
    offered: `Context: ${found} found. selfhost init --import-context copies ${what} into ${dir}; the originals stay as they are.`,
    would_import: `Context: would import ${what} into ${dir}; the originals stay as they are.`,
    imported: `Context: imported ${what} into ${dir}. The originals are unchanged; ${UNDO_COMMAND} deletes the copies.`,
    declined: `Context: not imported. selfhost init --import-context copies ${what} into ${dir} later.`,
  };
  write(lines[context.status]);
  if (context.status !== "declined") {
    table(
      context.files.map((file) => [
        `  ${shown(cwd, file.path)}`,
        file.action === "create"
          ? ""
          : file.action === "same"
            ? "(already there)"
            : "(kept, a different file is there)",
        file.from.length > 0 ? `from ${file.from.join(", ")}` : "",
      ]),
      write,
    );
  }
  const home = context.skipped.filter((entry) => entry.path.startsWith("~"));
  for (const entry of context.skipped.filter((item) => !item.path.startsWith("~"))) {
    write(`  Left out: ${entry.path} (${entry.reason})`);
  }
  if (home.length > 0) {
    write(
      `  Left out: ${plural(home.length, "file")} in the home folder (personal, they stay there)`,
    );
  }
  for (const note of context.notes) write(`  Note: ${note}`);
  write("");
}

interface Paths {
  home: string;
  configPath: string;
  dataDir: string | undefined;
  spool: string | undefined;
  claudeDir: string | undefined;
  codexDir: string | undefined;
}

/** --home re-roots every path under that folder; otherwise the usual defaults. */
function paths(options: InitOptions, io: InitIo): Paths {
  const scoped = agentScope(options.home, io);
  const home = scoped.home;
  const selfhost = join(home, ".selfhost");
  const loc = options.home ? locate({ home, env: scoped.env, platform: io.platform }) : undefined;
  return {
    home,
    configPath: io.configPath ?? join(selfhost, "config.json"),
    dataDir: options.dataDir ?? (options.home ? join(selfhost, "data") : undefined),
    spool: options.home ? join(selfhost, "spool") : spoolDir(io.env),
    claudeDir: loc?.claude_code.configDir,
    codexDir: loc?.codex.home,
  };
}

/** Log files and spool lines an import would read, for --dry-run. */
async function countSources(options: InitOptions, io: InitIo, where: Paths, since: Date) {
  let logFiles = 0;
  for (const file of await discoverLogFiles({
    claudeDir: where.claudeDir,
    codexDir: where.codexDir,
  })) {
    const info = await stat(file.path).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs >= since.getTime()) logFiles++;
  }
  const counting = {
    append: async (events: { id: string }[]) => ({
      accepted: events.map((e) => e.id),
      duplicates: [],
    }),
  };
  const spool = await drainSpool(counting, where.spool, { person: "", keep: true, now: io.now });
  return {
    log_files: logFiles,
    hook_lines: spool.lines,
    ledger: describeTarget({ database: options.database, dataDir: where.dataDir }, io),
  };
}

/**
 * `selfhost init`: from nothing to real data on the first screen. Joins the team first when
 * --team is given (a refused invite changes no files), adds `selfhost hook` to each agent's
 * own config with a backup of every file, writes a starter selfhost.toml at the repository
 * root when there is none, offers to copy the repository's context files into
 * `.selfhost/context/`, imports the window, runs policy observe and prints spend by agent and
 * request type. The context offer is the only question, asked only in a terminal; flags answer
 * it for scripts.
 */
export async function runInit(options: InitOptions, io: InitIo): Promise<number> {
  if (options.undo) {
    const home = agentScope(options.home, io).home;
    const report = undoInit(home, options.dryRun ?? false);
    if (options.json) io.write(JSON.stringify(report, null, 2));
    else printUndo(report, home, io.write);
    return report.left > 0 ? 1 : 0;
  }
  const now = io.now ?? new Date();
  const since = options.since ?? "30d";
  const sinceDate = parseSince(since, now) ?? now;
  const invite = parseInvite(options, io.env);
  const preset = parsePreset(options.preset);
  const where = paths(options, io);
  const { command, warning } = hookCommand(io.probes.which);
  const warnings = warning ? [warning] : [];

  // Read only: what is installed, what would change, where selfhost.toml goes.
  const detected = agentsReport({ home: options.home }, io).agents;
  const wanted = hookAgents(options.agent, detected);
  const { plans } =
    wanted.length > 0
      ? planConfigure({ home: options.home, agent: wanted, hookCommand: command }, io)
      : { plans: [] as AgentConfigPlan[] };
  const skipped = new Map<AgentId, string>();
  const managed = managedHooks(io.platform, io.systemRoot);
  for (const plan of plans) {
    const hooked = managed.find((entry) => entry.agent === plan.agent);
    const reason = hooked
      ? `the managed settings at ${hooked.path} already run selfhost's hooks for this agent; a user hook as well would run them twice`
      : screen(plan);
    if (reason) skipped.set(plan.agent, reason);
  }
  const apply = plans.filter((plan) => !skipped.has(plan.agent));
  const found = findConfig(io.cwd, undefined, io.env);
  const repo = repoDir(undefined, io.cwd);
  // In a team the pulled team policy applies with no file in the repository. A starter would
  // only add observe-mode copies of rules, so none is written unless a preset is asked for.
  const inTeam = invite !== undefined || readMembership(where.configPath) !== undefined;
  const config: InitReport["config"] =
    found && existsSync(found.path)
      ? { path: found.path, action: "kept", preset: null }
      : repo && (preset !== undefined || !inTeam)
        ? { path: join(repo, CONFIG_FILE_NAME), action: "created", preset: preset ?? null }
        : { path: null, action: "none", preset: null };
  if (preset && config.action === "kept") {
    warnings.push(
      `${shown(io.cwd, config.path ?? "")} already exists, so the ${preset} preset was not written. Move it away and run init again to start from the preset.`,
    );
  } else if (preset && config.action === "none") {
    warnings.push(`not in a git repository, so the ${preset} preset was not written.`);
  }
  // Read only: the context files and what importing them into .selfhost/context/ would write.
  const contextDocs = repo
    ? readContext({
        home: where.home,
        env: agentScope(options.home, io).env,
        platform: io.platform,
        cwd: repo,
      })
    : [];
  const contextPlan = repo ? planContextImport(contextDocs, repo) : undefined;

  // The team comes first: it is the first write, so a refused invite leaves every file as it was.
  const membership = readMembership(where.configPath);
  let team: InitReport["team"] = null;
  if (invite && membership?.server === invite.server) {
    team = {
      server: membership.server,
      team: membership.team,
      person: membership.person,
      joined: false,
    };
  } else if (invite && options.dryRun) {
    team = { server: invite.server, team: null, person: null, joined: true };
  } else if (invite) {
    const joined = await joinTeam(
      invite.server,
      invite.invite,
      { person: options.person, json: true },
      {
        env: io.env,
        write: () => {},
        configPath: where.configPath,
        fetch: io.fetch ?? ((url, init) => fetch(url, init)),
      },
    );
    team = { server: joined.server, team: joined.team.id, person: joined.person, joined: true };
  }

  const configured = applyConfigure(where.home, apply, { dryRun: options.dryRun }, io);
  const report: InitReport = {
    schema: "selfhost.init/v1",
    dry_run: options.dryRun ?? false,
    home: where.home,
    mode: team || membership ? "team" : "solo",
    team,
    hook_command: command,
    spool: where.spool ?? null,
    agents: detected.map((agent) =>
      agentRow(
        agent,
        plans.find((plan) => plan.agent === agent.id),
        skipped.get(agent.id),
        configured,
      ),
    ),
    undo: UNDO_COMMAND,
    config,
    context: null,
    sources: null,
    import: null,
    spend: null,
    observe: null,
    warnings,
  };
  if (!report.team && membership) {
    report.team = {
      server: membership.server,
      team: membership.team,
      person: membership.person,
      joined: false,
    };
  }
  const write = options.json ? () => {} : io.write;

  if (options.dryRun) {
    report.sources = await countSources(options, io, where, sinceDate);
    printHeader(
      report,
      write,
      io.cwd,
      apply.some((plan) => plan.changes.length > 0),
    );
    if (contextPlan) {
      report.context = await offerContext(contextPlan, contextDocs.length, options, io, where.home);
      printContext(report.context, io.cwd, write);
    }
    const { log_files, hook_lines, ledger } = report.sources;
    const window = /^\d+[dh]$/.test(since.trim()) ? `the last ${since}` : `since ${since}`;
    write(
      `Would import ${log_files} log files from ${window} and ${hook_lines} hook events ` +
        `into ${ledger}, run policy observe and print spend by agent and request type.`,
    );
    for (const warning of report.warnings) write(`Note: ${warning}`);
    if (options.json) io.write(JSON.stringify(report, null, 2));
    return 0;
  }

  const backups = new Map<string, string | null>();
  for (const entry of configured.agents)
    for (const file of entry.files) backups.set(file.path, file.backup);
  if (apply.some((plan) => plan.changes.length > 0))
    recordApplied(recordPath(where.home), apply, backups);
  if (config.action === "created" && config.path) {
    writeStarterConfig(config.path, configText(preset));
  }
  printHeader(report, write, io.cwd, readRecord(recordPath(where.home)).length > 0);
  if (contextPlan) {
    report.context = await offerContext(contextPlan, contextDocs.length, options, io, where.home);
    printContext(report.context, io.cwd, write);
  }

  const ledger = await openLedger({
    url: options.database ?? io.env.DATABASE_URL,
    dataDir: where.dataDir,
  });
  try {
    report.import = await runImport(
      {
        since,
        person: options.person,
        dataDir: where.dataDir,
        database: options.database,
        claudeDir: where.claudeDir,
        codexDir: where.codexDir,
        spoolDir: where.spool,
      },
      {
        env: io.env,
        write,
        now: io.now,
        configPath: where.configPath,
        fetch: io.fetch,
        retry: io.retry,
      },
      ledger,
    );
    write("");
    report.spend = await runSpend(
      { since, by: "agent,request_type" },
      { env: io.env, write, now: io.now },
      ledger,
    );
    if (config.path) {
      write("");
      try {
        report.observe = await policyObserve(
          { since, config: config.path, dataDir: where.dataDir, database: options.database },
          {
            env: io.env,
            cwd: io.cwd,
            // The ledger line is already printed above.
            write: (line) => {
              if (!line.startsWith("Ledger: ")) write(line);
            },
            setExitCode: () => {},
            now: io.now,
          },
          ledger,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.warnings.push(`policy observe skipped: ${message}`);
      }
    }
  } finally {
    await ledger.close();
  }
  if (report.import.sync?.error)
    report.warnings.push(`team sync failed: ${report.import.sync.error}`);
  printFooter(report, write);
  if (options.json) io.write(JSON.stringify(report, null, 2));
  const failed = apply.some((plan) => plan.items.some((item) => item.status === "error"));
  return failed ? 1 : 0;
}

export function registerInit(
  program: Command,
  io: () => InitIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  program
    .command("init")
    .description(
      "set up this laptop: hooks in each agent, a starter selfhost.toml, the context files offered for .selfhost/context/, the last 30 days imported",
    )
    .option("--since <when>", "how far back to import, like 30d, 12h or a date", "30d")
    .option(
      "--team <invite>",
      "join a team first: the invite, `<server> <invite>` or the whole `selfhost join` line",
    )
    .option("--server <url>", "the team's selfhost server, with --team <invite>")
    .option(
      "--hosted",
      "join on the hosted server (SELFHOST_HOSTED_URL, else https://app.selfhost.ai)",
    )
    .option(
      "--agent <name...>",
      `${AGENT_NAMES_TEXT} (default: Claude Code and Codex where found; init hooks those two, selfhost guard install the rest)`,
    )
    .option(
      "--preset <name>",
      `write selfhost.toml from a preset: ${PRESET_NAMES.join(", ")} (default: starter rules, all in observe)`,
    )
    .option("--person <id>", "who the sessions belong to (default: git email)")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option("--dry-run", "print what would change and write nothing")
    .option(
      "--import-context",
      "copy the repository's CLAUDE.md, AGENTS.md, rules, skills, commands, subagents and MCP servers into .selfhost/context/ without asking",
    )
    .option("--no-import-context", "do not import the context files and do not ask")
    .option(
      "--undo",
      "put back the agent config files init changed, byte for byte, and delete the context files it imported",
    )
    .option(
      "-y, --yes",
      "never ask; the context files are then imported only with --import-context",
    )
    .option("--json", "print one selfhost.init/v1 object")
    .option("--home <dir>", "use this folder as the home directory (for testing)")
    .action(async (options: InitOptions) => {
      const deps = io();
      try {
        deps.setExitCode(await runInit(options, deps));
      } catch (error) {
        fail(error, options.json);
      }
    });
}
