import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { type AgentLocations, locate } from "./locations.js";
import { pathLookup } from "./probes.js";
import {
  AGENT_IDS,
  AGENT_NAMES,
  type AgentId,
  type AgentLogin,
  type AgentStatus,
  type Env,
  type LocateOptions,
  type LoginMethod,
  type Probes,
} from "./types.js";

export interface DetectOptions extends LocateOptions, Probes {}

interface Context {
  home: string;
  env: Env;
  platform: NodeJS.Platform;
  probes: Probes;
}

interface AgentSpec {
  binaries: string[];
  installPaths(home: string, platform: NodeJS.Platform): string[];
  /** npm package names, to read the version from an npm install. */
  packages: string[];
  configPath(loc: AgentLocations): string;
  /** Any of these existing means the agent has been set up on this machine. */
  dataDirs(loc: AgentLocations): string[];
  hint: string;
  login(loc: AgentLocations, ctx: Context): Omit<AgentLogin, "hint">;
  /** Rejects a binary that shares the name but is a different tool. */
  accepts?(realPath: string, versionLine: () => string | undefined): boolean;
}

/** Variables that hand a provider key to OpenCode or Goose without a stored login. */
const PROVIDER_KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
];

const found = (method: LoginMethod, source: string) =>
  ({ status: "logged_in", method, source }) as const;
const missing = { status: "logged_out", method: null, source: null } as const;
const unknown = { status: "unknown", method: null, source: null } as const;

function hasFile(path: string, minBytes = 1): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size >= minBytes;
  } catch {
    return false;
  }
}

function firstEnv(env: Env, names: string[]): string | undefined {
  return names.find((name) => (env[name] ?? "").trim() !== "");
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Checks the keychain on macOS only. undefined means it could not be checked. */
function keychain(ctx: Context, service: string, account?: string): boolean | undefined {
  if (ctx.platform !== "darwin") return false;
  return ctx.probes.keychain?.(service, account);
}

const exe = (platform: NodeJS.Platform, path: string) =>
  platform === "win32" ? [`${path}.exe`, `${path}.cmd`, path] : [path];

const SPECS: Record<AgentId, AgentSpec> = {
  claude_code: {
    binaries: ["claude"],
    installPaths: (home, platform) => [
      ...exe(platform, join(home, ".local", "bin", "claude")),
      join(home, ".claude", "local", "claude"),
    ],
    packages: ["@anthropic-ai/claude-code"],
    configPath: (loc) => loc.claude_code.settings,
    dataDirs: (loc) => [loc.claude_code.configDir, loc.claude_code.globalConfig],
    hint: "claude auth login",
    login(loc, ctx) {
      const claude = loc.claude_code;
      if (hasFile(claude.credentials)) return found("file", claude.credentials);
      const inKeychain = keychain(ctx, claude.keychainService);
      if (inKeychain) return found("keychain", claude.keychainService);
      if (typeof readJsonObject(claude.settings)?.apiKeyHelper === "string") {
        return found("settings", `${claude.settings}#apiKeyHelper`);
      }
      const variable = firstEnv(ctx.env, [
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ]);
      if (variable) return found("env", variable);
      // With CLAUDE_CONFIG_DIR the keychain service carries a hash of the directory; a miss
      // there is not proof of no login.
      if (inKeychain === undefined || claude.customConfigDir) return unknown;
      return missing;
    },
  },
  codex: {
    binaries: ["codex"],
    installPaths: (home, platform) => exe(platform, join(home, ".local", "bin", "codex")),
    packages: ["@openai/codex"],
    configPath: (loc) => loc.codex.config,
    dataDirs: (loc) => [loc.codex.home],
    hint: "codex login",
    login(loc, ctx) {
      const codex = loc.codex;
      if (hasFile(codex.auth)) return found("file", codex.auth);
      const inKeychain = keychain(ctx, codex.keychainService, codex.keychainAccount);
      if (inKeychain) return found("keychain", codex.keychainService);
      if (inKeychain === undefined) return unknown;
      if (ctx.platform !== "darwin") {
        // keyring and auto use the Secret Service or Credential Manager, which we can't query.
        const store = credentialStore(codex.config);
        if (store === "keyring" || store === "auto") return unknown;
      }
      return missing;
    },
  },
  opencode: {
    binaries: ["opencode"],
    installPaths: (home, platform) => [
      ...exe(platform, join(home, ".opencode", "bin", "opencode")),
      ...exe(platform, join(home, ".local", "bin", "opencode")),
    ],
    packages: ["opencode-ai"],
    configPath: (loc) => loc.opencode.config,
    dataDirs: (loc) => [loc.opencode.configDir, loc.opencode.dataDir],
    hint: "opencode auth login",
    login(loc, ctx) {
      const opencode = loc.opencode;
      // An auth.json holding only "{}" has no logins.
      if (hasFile(opencode.auth, 3)) return found("file", opencode.auth);
      const variable = firstEnv(ctx.env, PROVIDER_KEY_VARS);
      if (variable) return found("env", variable);
      // OpenCode 2 keeps logins in its SQLite database, which we don't open.
      if (hasFile(opencode.database))
        return { ...unknown, method: "database", source: opencode.database };
      return missing;
    },
  },
  goose: {
    binaries: ["goose"],
    installPaths: (home, platform) => exe(platform, join(home, ".local", "bin", "goose")),
    packages: [],
    configPath: (loc) => loc.goose.config,
    dataDirs: (loc) => [loc.goose.configDir],
    hint: "goose configure",
    login(loc, ctx) {
      const goose = loc.goose;
      if (hasFile(goose.secrets)) return found("file", goose.secrets);
      const keyringOff = (ctx.env.GOOSE_DISABLE_KEYRING ?? "").trim() !== "";
      const inKeychain = keyringOff
        ? false
        : keychain(ctx, goose.keychainService, goose.keychainAccount);
      if (inKeychain) return found("keychain", goose.keychainService);
      const variable = firstEnv(ctx.env, PROVIDER_KEY_VARS);
      if (variable) return found("env", variable);
      if (inKeychain === undefined) return unknown;
      // Linux and Windows keyrings can't be queried without reading them.
      if (ctx.platform !== "darwin" && !keyringOff) return unknown;
      return missing;
    },
    // pressly/goose, the database migration tool, ships a binary with the same name.
    accepts: (_path, versionLine) => !/goose version/i.test(versionLine() ?? ""),
  },
  cursor: {
    binaries: ["cursor-agent", "agent"],
    installPaths: (home, platform) => [
      ...exe(platform, join(home, ".local", "bin", "cursor-agent")),
      ...exe(platform, join(home, ".local", "bin", "agent")),
    ],
    packages: [],
    configPath: (loc) => loc.cursor.cliConfig,
    dataDirs: (loc) => [loc.cursor.cliConfig, join(loc.cursor.dir, "cli-config.json")],
    hint: "agent login",
    login(loc, ctx) {
      const cursor = loc.cursor;
      if (hasFile(cursor.auth)) return found("file", cursor.auth);
      const inKeychain = keychain(ctx, cursor.keychainService, cursor.keychainAccount);
      if (inKeychain) return found("keychain", cursor.keychainService);
      const variable = firstEnv(ctx.env, ["CURSOR_API_KEY"]);
      if (variable) return found("env", variable);
      if (inKeychain === undefined) return unknown;
      return missing;
    },
    // `agent` is a common name; only count it when it resolves into a cursor-agent install.
    accepts: (path) => /cursor-agent/i.test(path),
  },
};

function credentialStore(configPath: string): string | undefined {
  try {
    const value = parseToml(readFileSync(configPath, "utf8")).cli_auth_credentials_store;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const VERSION_PATTERNS = [
  /\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]{6,}/,
  /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/,
];

export function parseVersion(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const pattern of VERSION_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return undefined;
}

/** Reads a version from the install path: versions/<v>/, Homebrew Cellar, or package.json. */
export function versionFromPath(path: string, packages: string[]): string | undefined {
  const versions = /[/\\]versions[/\\]([^/\\]+)/.exec(path);
  if (versions?.[1]) return parseVersion(versions[1]) ?? versions[1];
  const cellar = /[/\\]Cellar[/\\][^/\\]+[/\\]([^/\\]+)[/\\]/.exec(path);
  if (cellar?.[1]) return cellar[1];
  if (packages.length === 0) return undefined;
  let dir = dirname(path);
  for (let depth = 0; depth < 6; depth++) {
    const pkg = readJsonObject(join(dir, "package.json"));
    if (pkg && packages.includes(String(pkg.name)) && typeof pkg.version === "string") {
      return pkg.version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function findBinary(
  spec: AgentSpec,
  ctx: Context,
): { binary: string; version: string | undefined } | undefined {
  const candidates = [
    ...spec.binaries.map((name) => ctx.probes.which?.(name)),
    ...spec.installPaths(ctx.home, ctx.platform),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate) || !isExecutableFile(candidate)) continue;
    seen.add(candidate);
    const real = realPath(candidate);
    let line: string | undefined;
    let probed = false;
    const versionLine = () => {
      if (!probed) line = ctx.probes.version?.(candidate);
      probed = true;
      return line;
    };
    if (spec.accepts && !spec.accepts(real, versionLine)) continue;
    return {
      binary: candidate,
      version: versionFromPath(real, spec.packages) ?? parseVersion(versionLine()),
    };
  }
  return undefined;
}

/**
 * Finds Claude Code, Codex, OpenCode, Goose and Cursor CLI: whether each is installed, its
 * version when that is cheap to get, its settings file and whether it has a login. Logins are
 * detected only from the presence of credential files, keychain items and environment
 * variable names; no secret is ever read. Without `keychain` and `version` probes nothing is
 * executed, so tests on fixture home directories stay hermetic.
 */
export function detectAgents(options: DetectOptions): AgentStatus[] {
  const env = options.env ?? {};
  const platform = options.platform ?? process.platform;
  const ctx: Context = {
    home: options.home,
    env,
    platform,
    probes: {
      which: options.which ?? pathLookup(env, platform),
      keychain: options.keychain,
      version: options.version,
    },
  };
  const loc = locate({ home: options.home, env, platform });
  return AGENT_IDS.map((id) => {
    const spec = SPECS[id];
    const install = findBinary(spec, ctx);
    const configPath = spec.configPath(loc);
    const setUp = spec.dataDirs(loc).some((path) => existsSync(path));
    const login =
      install || setUp
        ? spec.login(loc, ctx)
        : { status: "logged_out" as const, method: null, source: null };
    return {
      id,
      name: AGENT_NAMES[id],
      installed: install !== undefined,
      binary: install?.binary ?? null,
      version: install?.version ?? null,
      configPath,
      configExists: existsSync(configPath),
      login: { ...login, hint: spec.hint },
    };
  });
}
