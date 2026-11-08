import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { unifiedDiff } from "@selfhost/agents";
import { type ConductorHistory, readConductorExport, writeEvents } from "@selfhost/importers";
import { openLedger } from "@selfhost/ledger";
import { CONFIG_FILE_NAME } from "@selfhost/schema";
import type { Command } from "commander";
import { table } from "../format.js";
import { defaultPerson, describeTarget } from "../import.js";
import { repoDir } from "../scan/index.js";
import { readMembership } from "../team/config.js";
import {
  type ConductorFile,
  type ConductorMapping,
  mapConductor,
  unchangedFiles,
} from "./conductor.js";
import {
  type MigrateUndoReport,
  migrateRecordPath,
  recordWrite,
  undoMigrate,
  writeChecked,
} from "./record.js";
import { type ConfigPlan, planConfig } from "./toml.js";

export interface MigrateIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  now?: Date;
  /** ~/.selfhost/config.json: the team membership, and migrate.json beside it. */
  configPath: string;
}

export interface MigrateConductorOptions {
  repo?: string[];
  history?: string;
  force?: boolean;
  dryRun?: boolean;
  undo?: boolean;
  prompts?: boolean;
  person?: string;
  database?: string;
  dataDir?: string;
  json?: boolean;
}

export interface MigrateRepoReport {
  repo: string;
  /** The Conductor file whose settings were moved; null when the repository has none. */
  source: ConductorMapping["source"];
  /** Every Conductor file found. `unchanged` is checked after selfhost.toml is written. */
  conductor_files: (ConductorFile & { unchanged: boolean })[];
  config: { path: string; action: ConfigPlan["action"]; diff: string | null } | null;
  mapped: ConductorMapping["mapped"];
  not_mapped: ConductorMapping["not_mapped"];
  unknown: string[];
  variables: ConductorMapping["variables"];
  message: string | null;
  error: string | null;
}

export interface MigrateHistoryReport {
  /** The export given with --history, or null. */
  path: string | null;
  status: "imported" | "would_import" | "none" | "empty" | "error";
  files: number;
  workspaces: number;
  sessions: number;
  messages: number;
  events: number;
  accepted: number;
  duplicates: number;
  skipped: ConductorHistory["skipped"];
  ledger: string | null;
  message: string;
}

/** `selfhost migrate conductor --json`. */
export interface MigrateConductorReport {
  schema: "selfhost.migrate_conductor/v1";
  dry_run: boolean;
  repos: MigrateRepoReport[];
  history: MigrateHistoryReport;
  /** How to put each selfhost.toml back. */
  undo: string;
}

const UNDO_COMMAND = "selfhost migrate conductor --undo";

const NO_SETTINGS =
  "No Conductor settings here: no .conductor/settings.toml, .conductor/settings.json or conductor.json. " +
  "Scripts set only in the Conductor app (Settings, the repository, Scripts) are kept by the app, not the repository: " +
  "save them to .conductor/settings.toml from there and run this again, or write [runtime] in selfhost.toml by hand.";

const NO_HISTORY =
  "No history export given, so no Conductor history was imported. To keep chats from Conductor Cloud, " +
  "export them before November 20, 2026 (in Conductor: Settings, Account, Export data), unpack the archive " +
  "and run selfhost migrate conductor --history <folder>. Sessions of local workspaces are also in Claude Code's " +
  "and Codex's own logs, which selfhost import reads.";

/** Relative to cwd when the path is under it. */
const shown = (cwd: string, path: string) => {
  const rel = relative(cwd, path);
  if (rel === "") return ".";
  return rel.startsWith("..") || isAbsolute(rel) ? path : rel;
};

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function repositories(options: MigrateConductorOptions, io: MigrateIo): string[] {
  if (options.repo?.length) {
    return [...new Set(options.repo.map((path) => repoDir(path, io.cwd) as string))];
  }
  const root = repoDir(undefined, io.cwd);
  if (!root) {
    throw new Error(
      "Not in a git repository. Run it in a repository Conductor works on, or pass --repo <path>.",
    );
  }
  return [root];
}

function emptyRepo(root: string): MigrateRepoReport {
  return {
    repo: root,
    source: null,
    conductor_files: [],
    config: null,
    mapped: [],
    not_mapped: [],
    unknown: [],
    variables: [],
    message: null,
    error: null,
  };
}

/** Reads one repository's Conductor settings and writes its [runtime] (unless dry run). */
function migrateRepo(
  root: string,
  options: MigrateConductorOptions,
  io: MigrateIo,
): MigrateRepoReport {
  const report = emptyRepo(root);
  try {
    const mapping = mapConductor(root);
    report.source = mapping.source;
    report.mapped = mapping.mapped;
    report.not_mapped = mapping.not_mapped;
    report.unknown = mapping.unknown;
    report.variables = mapping.variables;
    report.conductor_files = mapping.files.map((file) => ({ ...file, unchanged: true }));
    if (!mapping.source) {
      report.message = NO_SETTINGS;
      return report;
    }
    const path = join(root, CONFIG_FILE_NAME);
    const before = readText(path);
    const date = (io.now ?? new Date()).toISOString().slice(0, 10);
    const aliases = mapping.variables
      .filter((use) => mapping.aliases.includes(use.name))
      .map((use) => ({ name: use.name, files: use.files }));
    const plan = planConfig(
      path,
      before,
      mapping.runtime,
      { from: mapping.source.path, date, aliases },
      options.force === true,
    );
    const diff =
      plan.after === null ? null : unifiedDiff(shown(io.cwd, path), plan.before, plan.after);
    report.config = { path, action: plan.action, diff };
    report.message = plan.message;
    if (!options.dryRun && plan.after !== null) {
      writeChecked(path, plan.before, plan.after);
      recordWrite(migrateRecordPath(io.configPath), path, plan.before, plan.after);
    }
    for (const file of report.conductor_files) {
      file.unchanged = unchangedFiles(root, [file]);
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return report;
}

function emptyHistory(
  path: string | null,
  status: MigrateHistoryReport["status"],
  message: string,
) {
  return {
    path,
    status,
    files: 0,
    workspaces: 0,
    sessions: 0,
    messages: 0,
    events: 0,
    accepted: 0,
    duplicates: 0,
    skipped: [],
    ledger: null,
    message,
  } satisfies MigrateHistoryReport;
}

/** Reads the export, and unless dry run appends its events to the ledger. */
async function migrateHistory(
  options: MigrateConductorOptions,
  io: MigrateIo,
): Promise<MigrateHistoryReport> {
  if (!options.history) return emptyHistory(null, "none", NO_HISTORY);
  const exportPath = resolve(io.cwd, options.history);
  let history: ConductorHistory;
  try {
    history = await readConductorExport(exportPath, {
      actorId:
        options.person ?? readMembership(io.configPath)?.person ?? defaultPerson(io.env, io.cwd),
      logPrompts: options.prompts === true,
    });
  } catch (error) {
    return emptyHistory(
      exportPath,
      "error",
      error instanceof Error ? error.message : String(error),
    );
  }
  const ledger = describeTarget(options, io);
  const counts = {
    path: exportPath,
    files: history.files,
    workspaces: history.workspaces,
    sessions: history.sessions,
    messages: history.messages,
    events: history.events.length,
    accepted: 0,
    duplicates: 0,
    skipped: history.skipped,
    ledger,
  };
  const found =
    `${history.sessions} sessions in ${history.workspaces} workspaces ` +
    `(${history.messages} messages, ${history.files} files)`;
  if (history.events.length === 0) {
    return {
      ...counts,
      status: "empty",
      message:
        `Read ${history.files} files in ${exportPath} and found no Conductor session with a timestamp. ` +
        "Conductor does not publish its export format; selfhost reads JSON shaped like the objects of " +
        "Conductor's API (workspaces, sessions, transcript messages, rows of POST /v0/sql). Nothing was imported.",
    };
  }
  const prompts = options.prompts
    ? ""
    : " Prompts are counted, not stored; --prompts keeps their text.";
  if (options.dryRun) {
    return {
      ...counts,
      status: "would_import",
      message: `Would import ${history.events.length} events from ${found} into ${ledger}.${prompts}`,
    };
  }
  const target = await openLedger({
    url: options.database ?? io.env.DATABASE_URL,
    dataDir: options.dataDir,
    redaction: { logPrompts: options.prompts === true, patterns: [] },
  });
  try {
    const written = await writeEvents(target, history.events);
    return {
      ...counts,
      ...written,
      status: "imported",
      message:
        `Imported ${written.accepted} new events (${written.duplicates} already in the ledger) ` +
        `from ${found}. Ledger: ${ledger}.${prompts}`,
    };
  } finally {
    await target.close();
  }
}

const CONFIG_WORDS: Record<ConfigPlan["action"], [dry: string, done?: string]> = {
  created: ["Would create {file} with [runtime].", "Created {file} with [runtime]."],
  updated: ["Would add [runtime] to the end of {file}.", "Added [runtime] to the end of {file}."],
  replaced: ["Would replace [runtime] in {file}.", "Replaced [runtime] in {file}."],
  unchanged: ["No change to {file}: its [runtime] already holds these settings."],
  kept: ["Left {file} as is: it already has a different [runtime]. Pass --force to replace it."],
  none: ["Nothing to move into [runtime], so {file} is not written."],
};

function printRepo(repo: MigrateRepoReport, dryRun: boolean, io: MigrateIo): void {
  const write = io.write;
  write(shown(io.cwd, repo.repo));
  if (repo.error) {
    write(`  Error: ${repo.error}`);
    return;
  }
  if (!repo.source) {
    write(`  ${repo.message}`);
    return;
  }
  write(`  Read ${repo.source.path}.`);
  for (const file of repo.conductor_files.filter((entry) => !entry.read)) {
    const keys = file.keys.length > 0 ? ` It sets ${file.keys.join(", ")}.` : "";
    write(`  Not read: ${file.path} (${file.reason}).${keys}`);
  }
  if (repo.mapped.length > 0) {
    write("  Moved");
    table(
      repo.mapped.map((item) => [`    ${item.from}`, item.to, item.note ?? ""]),
      write,
    );
  }
  if (repo.variables.length > 0) {
    write("  Variables");
    table(
      repo.variables.map((use) => {
        const detail = use.to
          ? [
              use.where.length > 0 ? `renamed in ${use.where.join(", ")}` : "",
              use.files.length > 0 ? `kept as an alias for ${use.files.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("; ")
          : `${use.reason} (${[...use.where, ...use.files].join(", ")})`;
        return [`    ${use.name}`, use.to ?? "not set", detail];
      }),
      write,
    );
  }
  if (repo.not_mapped.length > 0) {
    write("  Not moved");
    table(
      repo.not_mapped.map((item) => [`    ${item.key}`, item.reason]),
      write,
    );
  }
  if (repo.unknown.length > 0) {
    write("  Unknown keys, not in Conductor's documented settings; not moved");
    for (const key of repo.unknown) write(`    ${key}`);
  }
  if (repo.config) {
    const [dry, done = dry] = CONFIG_WORDS[repo.config.action];
    const file = shown(io.cwd, repo.config.path);
    write(`  ${(dryRun ? dry : done).replace("{file}", file)}`);
    if (dryRun && repo.config.diff) {
      for (const line of repo.config.diff.replace(/\n$/, "").split("\n")) write(`    ${line}`);
    }
  }
  const changed = repo.conductor_files.filter((file) => !file.unchanged);
  write(
    changed.length === 0
      ? "  Conductor's files are unchanged."
      : `  Warning: ${changed.map((file) => file.path).join(", ")} changed while migrate ran.`,
  );
}

function printReport(report: MigrateConductorReport, io: MigrateIo): void {
  if (report.dry_run) io.write("Dry run: nothing is written.");
  for (const repo of report.repos) {
    io.write("");
    printRepo(repo, report.dry_run, io);
  }
  io.write("");
  io.write("History");
  io.write(`  ${report.history.message}`);
  for (const skipped of report.history.skipped) {
    io.write(`  Skipped ${skipped.path}: ${skipped.reason}.`);
  }
  const wrote = report.repos.some(
    (repo) => repo.config && ["created", "updated", "replaced"].includes(repo.config.action),
  );
  if (wrote && !report.dry_run) {
    io.write("");
    io.write(
      "Nothing is committed: review selfhost.toml with git diff. " +
        `${UNDO_COMMAND} puts each one back byte for byte.`,
    );
  }
}

function printUndo(report: MigrateUndoReport, io: MigrateIo): void {
  if (report.files.length === 0) {
    io.write("Nothing to undo: selfhost migrate has not changed any selfhost.toml.");
    return;
  }
  for (const file of report.files) {
    const path = shown(io.cwd, file.path);
    if (file.action === "restored") {
      io.write(`${report.dry_run ? "Would restore" : "Restored"} ${path} byte for byte.`);
    } else if (file.action === "deleted") {
      io.write(`${report.dry_run ? "Would delete" : "Deleted"} ${path}, which migrate created.`);
    } else io.write(`Left ${path} as is: ${file.message}.`);
  }
  io.write("Kept: the history imported into the ledger, and Conductor's own files.");
}

/**
 * `selfhost migrate conductor`: moves each repository's Conductor setup, run and archive
 * scripts into the [runtime] section of its selfhost.toml, and imports a Conductor history
 * export into the ledger when one is given. Conductor's own files are read, never written.
 * Returns the exit code.
 */
export async function runMigrateConductor(
  options: MigrateConductorOptions,
  io: MigrateIo,
): Promise<number> {
  if (options.undo) {
    const report = undoMigrate(migrateRecordPath(io.configPath), options.dryRun === true);
    if (options.json) io.write(JSON.stringify(report, null, 2));
    else printUndo(report, io);
    return report.left > 0 ? 1 : 0;
  }
  const repos = repositories(options, io).map((root) => migrateRepo(root, options, io));
  const history = await migrateHistory(options, io);
  const report: MigrateConductorReport = {
    schema: "selfhost.migrate_conductor/v1",
    dry_run: options.dryRun === true,
    repos,
    history,
    undo: UNDO_COMMAND,
  };
  if (options.json) io.write(JSON.stringify(report, null, 2));
  else printReport(report, io);
  const failed =
    repos.some((repo) => repo.error !== null || repo.config?.action === "kept") ||
    history.status === "empty" ||
    history.status === "error";
  return failed ? 1 : 0;
}

export function registerMigrate(
  program: Command,
  io: () => MigrateIo & { setExitCode: (code: number) => void },
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const migrate = program.command("migrate").description("move to selfhost from another tool");
  migrate
    .command("conductor")
    .description(
      "move Conductor's setup, run and archive scripts into selfhost.toml [runtime] and import its workspace history",
    )
    .option("--repo <path...>", "repositories to migrate (default: the git repository here)")
    .option(
      "--history <path>",
      "Conductor history export to import into the ledger: an unpacked folder or a JSON file",
    )
    .option("--force", "replace a [runtime] that selfhost.toml already has")
    .option("--dry-run", "print the plan and the selfhost.toml diff, and write nothing")
    .option("--undo", "put back each selfhost.toml migrate changed, byte for byte")
    .option("--prompts", "store prompt text from the history (off by default)")
    .option("--person <id>", "who the history belongs to (default: git email)")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option("--json", "print one selfhost.migrate_conductor/v1 object")
    .action(async (options: MigrateConductorOptions) => {
      const deps = io();
      try {
        deps.setExitCode(await runMigrateConductor(options, deps));
      } catch (error) {
        fail(error, options.json);
      }
    });
}
