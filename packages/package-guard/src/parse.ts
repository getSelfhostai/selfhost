import { parse as parseShell } from "shell-quote";
import { managerOf, toolName } from "./managers.js";

export const ECOSYSTEMS = ["npm", "pypi", "cargo", "go"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

/** One package an install asks a registry for. */
export interface PackageRequest {
  ecosystem: Ecosystem;
  /** The name the registry knows: PyPI names normalized, a Go module or package path. */
  name: string;
  /** Version, tag, range or Go query as written. Undefined installs the default version. */
  spec?: string;
  /** The argument as written. */
  arg: string;
}

/** An argument the guard does not look up in a registry, and why. */
export interface SkippedArg {
  arg: string;
  reason: string;
  /** Host of a URL or git install, matched against blocked_registries. */
  host?: string;
}

/** One package manager call that installs or runs packages. */
export interface Install {
  ecosystem: Ecosystem;
  /** The package manager as typed, without its folder: npm, pnpm, pip3, uv, cargo, go. */
  manager: string;
  /** The words of this call, joined by spaces. */
  command: string;
  packages: PackageRequest[];
  skipped: SkippedArg[];
  /** Registries, indexes or proxies the call names, on the command line or in its env. */
  registries: string[];
  /** Go module path patterns from GOPRIVATE and GONOPROXY: modules the public proxy never sees. */
  privatePatterns: string[];
}

/** A simple command: its words and the variables assigned in front of it. */
export interface Words {
  env: Record<string, string>;
  words: string[];
}

const SEPARATORS = new Set([
  "&&",
  "||",
  ";",
  ";;",
  ";&",
  ";;&",
  "|",
  "|&",
  "&",
  "(",
  ")",
  "<(",
  ">(",
]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const MAX_DEPTH = 3;

/**
 * Newlines end a command in a shell, but shell-quote reads them as spaces, and it reads a
 * comment to the end of the whole string. Turns each newline outside quotes, and not escaped by
 * a backslash, into `;`, and drops comments up to the end of their line.
 */
function splitLines(command: string): string {
  let out = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] ?? "";
    if (quote !== "'" && char === "\\") {
      // A backslash before a newline joins the lines, as in a shell.
      if (command[i + 1] !== "\n") out += char + (command[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (quote === undefined && char === "#" && /^$|[\s;&|()]$/.test(out.slice(-1))) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === undefined) quote = char;
      else if (quote === char) quote = undefined;
    }
    out += char === "\n" && quote === undefined ? ";" : char;
  }
  return out;
}

/** The simple commands in a shell command line, with redirections left out. */
export function simpleCommands(command: string): Words[] {
  // Variables stay as written, so `npm i $PKG` keeps `$PKG` instead of an empty word.
  const entries = parseShell(splitLines(command), (key) => `$${key}`);
  const commands: Words[] = [];
  let words: string[] = [];
  let skipNext = false;
  const flush = () => {
    const env: Record<string, string> = {};
    let start = 0;
    for (; start < words.length; start += 1) {
      const match = ASSIGNMENT.exec(words[start] ?? "");
      if (!match) break;
      env[match[1] ?? ""] = match[2] ?? "";
    }
    if (start < words.length) commands.push({ env, words: words.slice(start) });
    words = [];
  };
  for (const entry of entries) {
    if (typeof entry === "string") {
      if (skipNext) skipNext = false;
      else words.push(entry);
      continue;
    }
    if ("comment" in entry) continue;
    if (entry.op === "glob") {
      if (skipNext) skipNext = false;
      else words.push(entry.pattern);
      continue;
    }
    if (SEPARATORS.has(entry.op)) {
      flush();
      skipNext = false;
      continue;
    }
    // A redirection: drop its target, and a file descriptor number written right before it.
    if (/^\d+$/.test(words[words.length - 1] ?? "")) words.pop();
    skipNext = true;
  }
  flush();
  return commands;
}

interface Wrapper {
  /** Flags that take a value. */
  values: Set<string>;
  /** Assignments may follow the flags, as with env and sudo. */
  assignments: boolean;
}

/** Commands that run the command after them. */
const WRAPPERS: Record<string, Wrapper> = {
  sudo: {
    values: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"]),
    assignments: true,
  },
  doas: { values: new Set(["-u", "-C"]), assignments: false },
  env: {
    values: new Set(["-u", "--unset", "-C", "--chdir"]),
    assignments: true,
  },
  time: { values: new Set(["-f", "-o"]), assignments: false },
  nohup: { values: new Set(), assignments: false },
  command: { values: new Set(), assignments: false },
  exec: { values: new Set(["-a"]), assignments: false },
  nice: { values: new Set(["-n"]), assignments: false },
  corepack: { values: new Set(), assignments: false },
};

/** Strips wrappers like sudo and env, keeping the variables they set. */
function unwrap({ env, words }: Words): Words {
  const vars = { ...env };
  let rest = words;
  for (;;) {
    const wrapper = WRAPPERS[toolName(rest[0] ?? "")];
    if (!wrapper) break;
    let i = 1;
    while (i < rest.length) {
      const word = rest[i] ?? "";
      if (word === "--") {
        i += 1;
        break;
      }
      if (word.startsWith("-") && word.length > 1) {
        i += wrapper.values.has(word) ? 2 : 1;
        continue;
      }
      const match = wrapper.assignments ? ASSIGNMENT.exec(word) : null;
      if (!match) break;
      vars[match[1] ?? ""] = match[2] ?? "";
      i += 1;
    }
    rest = rest.slice(i);
  }
  return { env: vars, words: rest };
}

/** The command string of `bash -c '...'` or `eval ...`, to read again. */
function nestedCommand(words: string[]): string | undefined {
  const tool = toolName(words[0] ?? "");
  if (tool === "eval") return words.slice(1).join(" ");
  if (!SHELLS.has(tool)) return undefined;
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] ?? "";
    if (!word.startsWith("-") || word.startsWith("--")) return undefined;
    if (word.slice(1).includes("c")) return words[i + 1];
  }
  return undefined;
}

function collect(
  command: string,
  baseEnv: Record<string, string>,
  depth: number,
  installs: Install[],
): void {
  for (const simple of simpleCommands(command)) {
    const { env, words } = unwrap({ env: { ...baseEnv, ...simple.env }, words: simple.words });
    if (words.length === 0) continue;
    const nested = nestedCommand(words);
    if (nested !== undefined) {
      if (depth < MAX_DEPTH) collect(nested, env, depth + 1, installs);
      continue;
    }
    const install = managerOf(words, env);
    if (install && (install.packages.length > 0 || install.skipped.length > 0)) {
      installs.push(install);
    }
  }
}

/**
 * Every package install in a shell command: npm, pnpm, yarn and bun add or install, npx, pnpm
 * dlx, bunx and yarn dlx, and create or init initializers; pip, python -m pip, uv pip, uv add,
 * uv tool, uv run --with, uvx, poetry add and pipx; cargo add and install; go get, install and
 * run. Reads chains (`cd x && npm i y`), `bash -c` and `eval`, wrappers like sudo and env, and
 * variables set in front of a command. `env` is the environment the command runs in, for
 * registry variables such as npm_config_registry, PIP_INDEX_URL and GOPROXY; variables set in
 * the command win. Pure: no I/O.
 */
export function parseInstalls(command: string, env: Record<string, string> = {}): Install[] {
  const installs: Install[] = [];
  collect(command, env, 0, installs);
  return installs;
}
