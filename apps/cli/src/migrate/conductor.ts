import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  maskSecrets,
  RUNTIME_VARIABLE_PREFIX,
  type RunCommand,
  type Runtime,
  type RuntimeVariable,
} from "@selfhost/schema";
import { parse as parseToml } from "smol-toml";

/*
 * Conductor (https://www.conductor.build) runs Claude Code, Codex and other agents in parallel
 * git worktrees it calls workspaces. Each repository describes how a workspace is prepared,
 * run and cleaned up. Sources, read on 2026-11-08:
 *
 * - .conductor/settings.toml (shared, committed) and .conductor/settings.local.toml (one
 *   machine), or their .json equivalents: https://www.conductor.build/docs/reference/settings
 *   and the schema https://conductor.build/schemas/settings.repo.schema.json
 * - [scripts] setup, run (a string, or named actions [scripts.run.<id>] with command, args,
 *   options.cwd, default, icon, hide, available_in), archive, run_mode (concurrent or
 *   nonconcurrent), auto_run_after_setup: https://www.conductor.build/docs/reference/scripts
 * - conductor.json, the legacy file at the repository root (scripts.setup, scripts.run,
 *   scripts.archive, runScriptMode, enterpriseDataPrivacy), ignored by Conductor once
 *   .conductor/settings.toml exists: https://www.conductor.build/docs/reference/conductor-json
 * - Variables Conductor sets in scripts:
 *   https://www.conductor.build/docs/reference/environment-variables
 *
 * Scripts set only in the Conductor app (Settings, the project, the Scripts tab) are kept by
 * the app, not in the repository, so they are not read here.
 */

/** Conductor variables and the selfhost variable that carries the same value. */
export const CONDUCTOR_VARIABLES: Record<string, RuntimeVariable> = {
  CONDUCTOR_WORKSPACE_NAME: "SELFHOST_WORKSPACE_NAME",
  CONDUCTOR_WORKSPACE_PATH: "SELFHOST_WORKSPACE_PATH",
  CONDUCTOR_ROOT_PATH: "SELFHOST_ROOT_PATH",
  CONDUCTOR_DEFAULT_BRANCH: "SELFHOST_DEFAULT_BRANCH",
  CONDUCTOR_PORT: "SELFHOST_PORT",
};

const CONDUCTOR_API = "Conductor's own API, which selfhost has no stand-in for";

/** Conductor variables selfhost does not set, with why. */
export const UNMAPPED_VARIABLES: Record<string, string> = {
  CONDUCTOR_IS_LOCAL:
    "1 in Conductor's local workspaces and 0 in its cloud ones; selfhost runs every workspace the same way",
  CONDUCTOR_BASE_DIR:
    'parent folder of a Conductor cloud workspace; use $(dirname "$SELFHOST_WORKSPACE_PATH")',
  CONDUCTOR_API_URL: CONDUCTOR_API,
  CONDUCTOR_API_TOKEN: CONDUCTOR_API,
  CONDUCTOR_API_KEY: CONDUCTOR_API,
  CONDUCTOR_SESSION_ID:
    "Conductor's agent session id, never set for scripts; the ledger records sessions instead",
};

const UNDOCUMENTED_VARIABLE = "not a variable Conductor documents";

/** Top-level Conductor settings that have no place in selfhost.toml, with why. */
const SETTING_REASONS: Record<string, string> = {
  enterprise_data_privacy: "switches off Conductor app features; nothing to move",
  file_include_globs:
    'Conductor copies these ignored files into each workspace; selfhost has no copy step, so add a cp from "$SELFHOST_ROOT_PATH" to [runtime] setup',
  environment_variable_files:
    "selfhost does not read env files for the runtime; load them in [runtime] setup if needed",
  git: "Conductor's branch and archive behavior; selfhost's runtime names branches after the workspace",
  prompts:
    "prompts for Conductor's own buttons; shared agent instructions belong in AGENTS.md or CLAUDE.md",
  preview_urls: "Conductor's Open button; selfhost has no preview links",
  spotlight_testing: "Conductor's Spotlight testing; no selfhost equivalent",
  models: "Conductor's model picker",
  claude_provider: "set the provider in Claude Code's own settings",
  codex_provider: "set the provider in Codex's own config",
  bedrock_region: "set the region in Claude Code's own settings",
  vertex_project_id: "set the project in Claude Code's own settings",
  claude_code_executable_path: "a path on one machine",
  codex_executable_path: "a path on one machine",
  opencode_executable_path: "a path on one machine",
  ssh_key_path: "a path on one machine",
};

export type ConductorFormat = "settings.toml" | "settings.json" | "conductor.json";

/** A Conductor file in the repository. Its bytes are hashed to prove they were not changed. */
export interface ConductorFile {
  /** Relative to the repository root. */
  path: string;
  role: "shared" | "local" | "legacy";
  /** True for the one file whose settings were moved. */
  read: boolean;
  /** Why the file was not moved. */
  reason: string | null;
  /** Keys it sets, for files that were not moved; never their values. */
  keys: string[];
  sha256: string;
}

export interface MappedSetting {
  /** Key in the Conductor file, for example scripts.run.web. */
  from: string;
  /** Key in selfhost.toml, for example runtime.run.web. */
  to: string;
  note: string | null;
}

export interface UnmappedSetting {
  key: string;
  reason: string;
}

/** A Conductor variable that a script uses. */
export interface VariableUse {
  name: string;
  /** The selfhost variable it became, or null when selfhost has none. */
  to: RuntimeVariable | null;
  /** Settings keys that use it; there it is renamed to `to`. */
  where: string[];
  /**
   * Script files in the repository that read it. They are not changed, so when `to` is set
   * [runtime.env] keeps the Conductor name, set from the selfhost variable.
   */
  files: string[];
  reason: string | null;
}

export interface ConductorMapping {
  source: { path: string; format: ConductorFormat } | null;
  files: ConductorFile[];
  /** The [runtime] section to write; undefined when there was nothing to move. */
  runtime: Runtime | undefined;
  mapped: MappedSetting[];
  not_mapped: UnmappedSetting[];
  /** Keys that are not in Conductor's documented settings. */
  unknown: string[];
  variables: VariableUse[];
  /** [runtime.env] keys that keep a Conductor name for the script files that still read it. */
  aliases: string[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const SHARED = [".conductor/settings.toml", ".conductor/settings.json"];
const LOCAL = [".conductor/settings.local.toml", ".conductor/settings.local.json"];
const LEGACY = "conductor.json";

function parseFile(path: string, text: string): Json {
  let value: unknown;
  try {
    value = path.endsWith(".toml") ? parseToml(text) : JSON.parse(text);
  } catch (error) {
    const message = (error as Error).message.split("\n")[0];
    throw new Error(`${path} could not be parsed: ${message}`);
  }
  if (!isObject(value)) throw new Error(`${path} does not hold a table of settings`);
  return value;
}

/** Dotted key paths of every value in a settings object, for files that are not moved. */
function keyPaths(value: Json, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    if (key === "$schema") return [];
    const path = prefix ? `${prefix}.${key}` : key;
    return isObject(child) ? keyPaths(child, path) : [path];
  });
}

interface Found {
  file: ConductorFile;
  /** The parsed file, or the parse error. Only the file that is moved has to parse. */
  settings: Json | Error;
}

/** Every Conductor settings file in the repository, read but never written. */
export function findConductorFiles(root: string): Found[] {
  const found: Found[] = [];
  const add = (path: string, role: ConductorFile["role"]) => {
    const full = join(root, path);
    if (!existsSync(full) || !statSync(full).isFile()) return;
    const bytes = readFileSync(full);
    let settings: Json | Error;
    try {
      settings = parseFile(path, bytes.toString("utf8"));
    } catch (error) {
      settings = error as Error;
    }
    found.push({
      file: { path, role, read: false, reason: null, keys: [], sha256: sha256(bytes) },
      settings,
    });
  };
  for (const path of SHARED) add(path, "shared");
  for (const path of LOCAL) add(path, "local");
  add(LEGACY, "legacy");
  return found;
}

/** Hashes the Conductor files again, to show their bytes did not change. */
export function unchangedFiles(root: string, files: ConductorFile[]): boolean {
  return files.every((file) => {
    const full = join(root, file.path);
    return existsSync(full) && sha256(readFileSync(full)) === file.sha256;
  });
}

/** conductor.json in the shape of .conductor/settings.toml, and how its keys are named. */
function fromLegacy(value: Json): { settings: Json; names: Record<string, string> } {
  const settings: Json = {};
  const names: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "runScriptMode") {
      settings.scripts = {
        ...(isObject(settings.scripts) ? settings.scripts : {}),
        run_mode: child,
      };
      names["scripts.run_mode"] = key;
    } else if (key === "enterpriseDataPrivacy") {
      settings.enterprise_data_privacy = child;
      names.enterprise_data_privacy = key;
    } else if (key === "scripts" && isObject(child)) {
      settings.scripts = { ...child, ...(isObject(settings.scripts) ? settings.scripts : {}) };
    } else {
      settings[`legacy:${key}`] = child;
      names[`legacy:${key}`] = key;
    }
  }
  return { settings, names };
}

const SCRIPT_EXTENSIONS = /\.(?:sh|bash|zsh|fish|py|rb|js|mjs|cjs|ts|pl)$/;
const MAX_SCRIPT_BYTES = 1024 * 1024;
const VARIABLE = /\bCONDUCTOR_[A-Z0-9_]+\b/g;

const inside = (rel: string) => rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);

/** Repository files a command runs, such as ./script/setup.sh, for the variables they read. */
function scriptFiles(root: string, command: string): string[] {
  const files: string[] = [];
  for (const token of command.split(/[\s;&|()<>`"']+/)) {
    if (token === "" || token.includes("$") || token.startsWith("-")) continue;
    if (!token.includes("/") && !SCRIPT_EXTENSIONS.test(token)) continue;
    const full = resolve(root, token);
    const rel = relative(root, full);
    if (!inside(rel) || !existsSync(full)) continue;
    // A symlink that leaves the repository is not followed.
    if (!inside(relative(realpathSync(root), realpathSync(full)))) continue;
    const info = statSync(full);
    if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) continue;
    const path = rel.split(sep).join("/");
    if (!files.includes(path)) files.push(path);
  }
  return files;
}

/** Shell-quotes an argument that is appended to a command, keeping $ expansions working. */
function shellArg(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\`])/g, "\\$1")}"`;
}

const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;

/** The action id as a selfhost run command name: letters, digits, spaces, _ and -. */
function runName(id: string, taken: Set<string>): string {
  let name = RUN_NAME.test(id)
    ? id
    : id
        .replace(/[^A-Za-z0-9 _-]+/g, "-")
        .replace(/^[^A-Za-z0-9]+/, "")
        .replace(/-+$/, "");
  if (name === "") name = "run";
  let unique = name;
  for (let n = 2; taken.has(unique); n++) unique = `${name}-${n}`;
  taken.add(unique);
  return unique;
}

const SECRET_NAME =
  /secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential/i;

/** A value selfhost.toml should not carry: a secret by its name or its shape, or an email. */
function sensitive(name: string, value: string): boolean {
  return SECRET_NAME.test(name) || maskSecrets(value).masked;
}

const runKey = (name: string) => (/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name));

/**
 * Maps a repository's Conductor settings to a selfhost [runtime] section. Pure apart from
 * reading the Conductor files and the script files the commands run, which it never writes.
 */
export function mapConductor(root: string): ConductorMapping {
  const found = findConductorFiles(root);
  const shared = found.find((entry) => entry.file.role === "shared");
  const legacy = found.find((entry) => entry.file.role === "legacy");
  const source = shared ?? legacy;
  if (source?.settings instanceof Error) throw source.settings;
  for (const entry of found) {
    if (entry === source) {
      entry.file.read = true;
      continue;
    }
    if (entry.settings instanceof Error) {
      entry.file.reason = entry.settings.message.replace(`${entry.file.path} `, "it ");
      continue;
    }
    entry.file.keys = keyPaths(entry.settings);
    if (entry.file.role === "local") {
      entry.file.reason =
        "personal overrides for one machine, which can hold secrets; selfhost.toml is shared";
    } else if (entry.file.role === "legacy") {
      entry.file.reason = `Conductor ignores it while ${shared?.file.path} exists`;
    } else {
      entry.file.reason = `${source?.file.path} is read instead`;
    }
  }
  const mapping: ConductorMapping = {
    source: source
      ? {
          path: source.file.path,
          format:
            source.file.role === "legacy"
              ? "conductor.json"
              : source.file.path.endsWith(".json")
                ? "settings.json"
                : "settings.toml",
        }
      : null,
    files: found.map((entry) => entry.file),
    runtime: undefined,
    mapped: [],
    not_mapped: [],
    unknown: [],
    variables: [],
    aliases: [],
  };
  if (!source) return mapping;
  const { settings, names } =
    source.file.role === "legacy"
      ? fromLegacy(source.settings)
      : { settings: source.settings, names: {} as Record<string, string> };
  const name = (key: string) => names[key] ?? key;
  new Mapper(root, mapping, name).map(settings);
  return mapping;
}

class Mapper {
  private readonly runtime: Runtime = {};
  private readonly uses = new Map<string, VariableUse>();
  /** Variables the settings define themselves, which keep their name. */
  private readonly own = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly mapping: ConductorMapping,
    private readonly name: (key: string) => string,
  ) {}

  private mapped(from: string, to: string, note: string | null = null) {
    this.mapping.mapped.push({ from: this.name(from), to, note });
  }

  private skip(key: string, reason: string) {
    this.mapping.not_mapped.push({ key: this.name(key), reason });
  }

  private unknown(key: string) {
    this.mapping.unknown.push(this.name(key));
  }

  private use(variable: string): VariableUse {
    let entry = this.uses.get(variable);
    if (!entry) {
      entry = {
        name: variable,
        to: CONDUCTOR_VARIABLES[variable] ?? null,
        where: [],
        files: [],
        reason: CONDUCTOR_VARIABLES[variable]
          ? null
          : (UNMAPPED_VARIABLES[variable] ?? UNDOCUMENTED_VARIABLE),
      };
      this.uses.set(variable, entry);
    }
    return entry;
  }

  /** Renames the Conductor variables a command or value uses to selfhost's. */
  private rewrite(text: string, where: string): string {
    return text.replace(VARIABLE, (variable) => {
      if (this.own.has(variable)) return variable;
      const entry = this.use(variable);
      if (!entry.where.includes(where)) entry.where.push(where);
      return entry.to ?? variable;
    });
  }

  /** Records the variables that the script files a command runs read under Conductor's names. */
  private scan(command: string) {
    for (const file of scriptFiles(this.root, command)) {
      const text = readFileSync(join(this.root, file), "utf8");
      for (const variable of new Set(text.match(VARIABLE) ?? [])) {
        if (this.own.has(variable)) continue;
        const entry = this.use(variable);
        if (!entry.files.includes(file)) entry.files.push(file);
      }
    }
  }

  private command(text: string, key: string): string {
    this.scan(text);
    return this.rewrite(text, key);
  }

  map(settings: Json) {
    const env = settings.environment_variables;
    if (isObject(env)) {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string") this.own.add(key);
        else if (isObject(value)) for (const name of Object.keys(value)) this.own.add(name);
      }
    }
    for (const [key, value] of Object.entries(settings)) {
      if (key === "$schema") continue;
      if (key === "scripts") this.scripts(value);
      else if (key === "environment_variables") this.env(value);
      else if (key.startsWith("legacy:")) this.unknown(key);
      else if (SETTING_REASONS[key]) {
        const keys = isObject(value) ? keyPaths(value, key) : [key];
        for (const each of keys) this.skip(each, SETTING_REASONS[key]);
      } else this.unknown(key);
    }
    this.aliases();
    this.mapping.variables = [...this.uses.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.mapping.runtime = Object.keys(this.runtime).length > 0 ? this.runtime : undefined;
  }

  private scripts(value: unknown) {
    if (!isObject(value)) {
      this.skip("scripts", "not a table");
      return;
    }
    for (const [key, script] of Object.entries(value)) {
      const path = `scripts.${key}`;
      if (key === "setup" || key === "archive") {
        if (typeof script !== "string" || script.trim() === "") {
          this.skip(path, "not a command");
          continue;
        }
        this.runtime[key] = this.command(script, path);
        this.mapped(path, `runtime.${key}`);
      } else if (key === "run") {
        this.run(script);
      } else if (key === "run_mode") {
        if (script === "concurrent") {
          this.runtime.run_mode = "concurrent";
          this.mapped(path, "runtime.run_mode");
        } else if (script === "nonconcurrent") {
          this.runtime.run_mode = "exclusive";
          this.mapped(path, "runtime.run_mode", "nonconcurrent is exclusive");
        } else {
          this.skip(path, `unknown run mode ${JSON.stringify(script)}`);
        }
      } else if (key === "auto_run_after_setup") {
        this.skip(path, "selfhost starts run commands only when asked");
      } else {
        this.unknown(path);
      }
    }
  }

  private run(value: unknown) {
    if (typeof value === "string") {
      if (value.trim() === "") return this.skip("scripts.run", "an empty command");
      this.runtime.run = { dev: { command: this.command(value, "scripts.run"), default: true } };
      this.mapped("scripts.run", "runtime.run.dev", "a single run command, named dev");
      return;
    }
    if (!isObject(value)) return this.skip("scripts.run", "neither a command nor a table");
    const taken = new Set<string>();
    const run: Record<string, RunCommand> = {};
    let hasDefault = false;
    for (const [id, action] of Object.entries(value)) {
      const path = `scripts.run.${runKey(id)}`;
      if (!isObject(action)) {
        this.skip(path, "not a table");
        continue;
      }
      if (typeof action.command !== "string" || action.command.trim() === "") {
        this.skip(path, "has no command");
        continue;
      }
      const name = runName(id, taken);
      const to = `runtime.run.${runKey(name)}`;
      const notes: string[] = name === id ? [] : [`renamed from ${JSON.stringify(id)}`];
      if (isObject(action.options) && typeof action.options.cwd === "string") {
        notes.push("options.cwd is cwd");
      }
      let command = action.command;
      const entry: RunCommand = { command };
      for (const [field, setting] of Object.entries(action)) {
        const key = `${path}.${field}`;
        if (field === "command") continue;
        if (field === "args" && Array.isArray(setting)) {
          const args = setting.filter((arg): arg is string => typeof arg === "string");
          command = [command, ...args.map(shellArg)].join(" ");
          notes.push("args appended to the command");
        } else if (field === "default" && typeof setting === "boolean") {
          if (setting && hasDefault) {
            this.skip(key, "another command is already the default");
          } else if (setting) {
            entry.default = true;
            hasDefault = true;
          }
        } else if (field === "options" && isObject(setting)) {
          for (const [option, optionValue] of Object.entries(setting)) {
            if (option === "cwd" && typeof optionValue === "string" && optionValue !== "") {
              entry.cwd = optionValue;
            } else this.unknown(`${key}.${option}`);
          }
        } else if (field === "icon") {
          this.skip(key, "an icon on Conductor's Run button");
        } else if (field === "hide") {
          this.skip(key, "hides the command in Conductor's Run button; selfhost lists them all");
        } else if (field === "available_in") {
          const where = Array.isArray(setting) ? setting : [setting];
          if (!(where.includes("local") && where.includes("cloud"))) {
            this.skip(
              key,
              "selfhost has no local and cloud workspaces; the command runs wherever the workspace does",
            );
          }
        } else {
          this.unknown(key);
        }
      }
      entry.command = this.command(command, path);
      run[name] = entry;
      this.mapped(path, to, notes.length > 0 ? notes.join("; ") : null);
    }
    if (Object.keys(run).length > 0) this.runtime.run = run;
  }

  private env(value: unknown) {
    if (!isObject(value)) return this.skip("environment_variables", "not a table");
    const out: Record<string, string> = {};
    for (const [key, setting] of Object.entries(value)) {
      const path = `environment_variables.${key}`;
      if ((key === "local" || key === "cloud") && isObject(setting)) {
        for (const name of Object.keys(setting)) {
          this.skip(
            `${path}.${name}`,
            `only for Conductor's ${key} workspaces; selfhost has one [runtime.env] for every workspace, so add it there if all of them need it`,
          );
        }
      } else if (typeof setting !== "string") {
        this.skip(path, "not a string");
      } else if (key.startsWith(RUNTIME_VARIABLE_PREFIX)) {
        this.skip(path, `names that start with ${RUNTIME_VARIABLE_PREFIX} are set by selfhost`);
      } else if (sensitive(key, setting)) {
        this.skip(
          path,
          "looks like a secret or an email address; selfhost.toml is shared, so set it in the environment instead",
        );
      } else {
        out[key] = this.rewrite(setting, path);
        this.mapped(path, `runtime.env.${key}`);
      }
    }
    if (Object.keys(out).length > 0) this.runtime.env = out;
  }

  /** Conductor names that script files still read, set from selfhost's in [runtime.env]. */
  private aliases() {
    const aliases = [...this.uses.values()].filter(
      (use) => use.to !== null && use.files.length > 0,
    );
    if (aliases.length === 0) return;
    const env = { ...(this.runtime.env ?? {}) };
    for (const use of aliases) {
      env[use.name] = `\${${use.to}}`;
      this.mapping.aliases.push(use.name);
    }
    this.runtime.env = env;
  }
}
