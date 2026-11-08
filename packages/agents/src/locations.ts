import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Env, LocateOptions } from "./types.js";

/**
 * Where each agent keeps its settings and credentials, from the vendors' docs:
 *
 * - Claude Code: https://code.claude.com/docs/en/settings, /claude-directory, /authentication
 * - Codex: https://developers.openai.com/codex/config-reference, /auth, /hooks
 * - OpenCode: https://opencode.ai/docs/config/, /mcp-servers/, /cli/providers/
 * - Goose: https://block.github.io/goose/docs/guides/config-files
 * - Cursor CLI: https://cursor.com/docs/cli/reference/configuration, /docs/hooks
 * - Copilot CLI: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot
 * - Gemini CLI: https://geminicli.com/docs/cli/gemini-md/, /docs/get-started/configuration
 */
export interface AgentLocations {
  claude_code: {
    configDir: string;
    settings: string;
    /** `~/.claude.json`, which holds user-scope MCP servers. */
    globalConfig: string;
    credentials: string;
    keychainService: string;
    /** True when CLAUDE_CONFIG_DIR is set, which changes the keychain service name. */
    customConfigDir: boolean;
  };
  codex: {
    home: string;
    config: string;
    hooks: string;
    auth: string;
    keychainService: string;
    keychainAccount: string;
  };
  opencode: {
    configDir: string;
    config: string;
    dataDir: string;
    auth: string;
    database: string;
  };
  goose: {
    configDir: string;
    config: string;
    secrets: string;
    keychainService: string;
    keychainAccount: string;
  };
  cursor: {
    dir: string;
    cliConfig: string;
    mcp: string;
    hooks: string;
    auth: string;
    keychainService: string;
    keychainAccount: string;
  };
  /** Copilot CLI reads no selfhost settings; its folder holds personal instructions and MCP. */
  copilot: {
    dir: string;
    instructions: string;
    mcp: string;
  };
  gemini: {
    dir: string;
    settings: string;
  };
}

function set(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function expand(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return resolve(home, path);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function canonical(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

export function locate({
  home,
  env = {},
  platform = process.platform,
}: LocateOptions): AgentLocations {
  const xdgConfig = set(env, "XDG_CONFIG_HOME") ?? join(home, ".config");
  const xdgData = set(env, "XDG_DATA_HOME") ?? join(home, ".local", "share");
  const appData = set(env, "APPDATA") ?? join(home, "AppData", "Roaming");

  // Claude Code: CLAUDE_CONFIG_DIR moves ~/.claude and ~/.claude.json, and keys the
  // keychain entry to that directory with a hash suffix.
  const claudeEnv = set(env, "CLAUDE_CONFIG_DIR");
  const claudeDir = claudeEnv ? expand(claudeEnv, home) : join(home, ".claude");
  const claudeService = claudeEnv
    ? `Claude Code-credentials-${sha256(claudeDir).slice(0, 8)}`
    : "Claude Code-credentials";

  // Codex: CODEX_HOME, default ~/.codex. The keyring account is "cli|" plus the first 16 hex
  // characters of the SHA-256 of the canonical CODEX_HOME path.
  const codexEnv = set(env, "CODEX_HOME");
  const codexHome = codexEnv ? expand(codexEnv, home) : join(home, ".codex");

  // OpenCode follows XDG on every platform, Windows included.
  const opencodeDir = join(xdgConfig, "opencode");
  const opencodeData = join(xdgData, "opencode");
  const jsonc = join(opencodeDir, "opencode.jsonc");

  // Goose: GOOSE_PATH_ROOT, else %APPDATA%\Block\goose\config on Windows, else XDG.
  const gooseRoot = set(env, "GOOSE_PATH_ROOT");
  const gooseDir = gooseRoot
    ? join(expand(gooseRoot, home), "config")
    : platform === "win32"
      ? join(appData, "Block", "goose", "config")
      : join(xdgConfig, "goose");

  // Cursor CLI: CURSOR_CONFIG_DIR for cli-config.json, XDG_CONFIG_HOME on Linux, else ~/.cursor.
  // MCP servers and hooks always live in ~/.cursor.
  const cursorDir = join(home, ".cursor");
  const cursorConfigEnv = set(env, "CURSOR_CONFIG_DIR");
  const cursorCliDir = cursorConfigEnv
    ? expand(cursorConfigEnv, home)
    : platform === "linux" && set(env, "XDG_CONFIG_HOME")
      ? join(xdgConfig, "cursor")
      : cursorDir;
  const cursorAuth =
    platform === "win32"
      ? join(appData, "Cursor", "auth.json")
      : platform === "darwin"
        ? join(cursorDir, "auth.json")
        : join(xdgConfig, "cursor", "auth.json");

  // Copilot CLI: COPILOT_HOME, default ~/.copilot.
  const copilotEnv = set(env, "COPILOT_HOME");
  const copilotDir = copilotEnv ? expand(copilotEnv, home) : join(home, ".copilot");
  const geminiDir = join(home, ".gemini");

  return {
    claude_code: {
      configDir: claudeDir,
      settings: join(claudeDir, "settings.json"),
      globalConfig: claudeEnv ? join(claudeDir, ".claude.json") : join(home, ".claude.json"),
      credentials: join(claudeDir, ".credentials.json"),
      keychainService: claudeService,
      customConfigDir: claudeEnv !== undefined,
    },
    codex: {
      home: codexHome,
      config: join(codexHome, "config.toml"),
      hooks: join(codexHome, "hooks.json"),
      auth: join(codexHome, "auth.json"),
      keychainService: "Codex Auth",
      keychainAccount: `cli|${sha256(canonical(codexHome)).slice(0, 16)}`,
    },
    opencode: {
      configDir: opencodeDir,
      config: existsSync(jsonc) ? jsonc : join(opencodeDir, "opencode.json"),
      dataDir: opencodeData,
      auth: join(opencodeData, "auth.json"),
      database: join(opencodeData, "opencode.db"),
    },
    goose: {
      configDir: gooseDir,
      config: join(gooseDir, "config.yaml"),
      secrets: join(gooseDir, "secrets.yaml"),
      keychainService: "goose",
      keychainAccount: "secrets",
    },
    cursor: {
      dir: cursorDir,
      cliConfig: join(cursorCliDir, "cli-config.json"),
      mcp: join(cursorDir, "mcp.json"),
      hooks: join(cursorDir, "hooks.json"),
      auth: cursorAuth,
      keychainService: "cursor-access-token",
      keychainAccount: "cursor-user",
    },
    copilot: {
      dir: copilotDir,
      instructions: join(copilotDir, "copilot-instructions.md"),
      mcp: join(copilotDir, "mcp-config.json"),
    },
    gemini: { dir: geminiDir, settings: join(geminiDir, "settings.json") },
  };
}

/** Environment variables that move agent config directories. `--home` drops them. */
export const PATH_ENV_VARS = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "GOOSE_PATH_ROOT",
  "CURSOR_CONFIG_DIR",
  "COPILOT_HOME",
] as const;
