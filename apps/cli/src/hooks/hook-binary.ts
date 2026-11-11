import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Which } from "@selfhost/agents";

/**
 * The selfhost binary root-owned managed settings run. A hook command of `selfhost hook ...`
 * runs whatever `selfhost` comes first on the agent's PATH, which the person (and so an agent
 * running as them) can usually change, and the usual install folders are theirs to write. So when
 * selfhost installs managed settings it writes the binary's absolute path, resolved at install
 * time, and selfhost doctor warns when someone other than root can replace that file.
 */

export interface HookBinary {
  /** `<binary> hook {agent}`, or `<node> <script> hook {agent}` for a script install. */
  command: string;
  /** The files the command runs, absolute: the binary, or node and the script. */
  paths: string[];
}

/** A path quoted for sh, or for cmd and PowerShell on Windows. */
function quote(path: string, platform: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(path)) return path;
  return platform === "win32" ? `"${path}"` : `'${path.replaceAll("'", `'\\''`)}'`;
}

/** true when the file starts with a shebang that runs node: an npm install's script. */
function isNodeScript(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(128);
    const read = readSync(fd, head, 0, head.length, 0);
    const line = head.subarray(0, read).toString("utf8").split("\n")[0] ?? "";
    return line.startsWith("#!") && /\bnode\b/.test(line);
  } catch {
    return /\.[cm]?js$/.test(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The hook command with selfhost's absolute path, from `selfhost` on PATH now, or undefined when
 * it is not there. A script install runs under this node by its absolute path too, since its
 * `#!/usr/bin/env node` line would look node up on PATH.
 */
export function managedHookCommand(
  which: Which | undefined,
  platform: string,
  node: string = process.execPath,
): HookBinary | undefined {
  const found = which?.("selfhost");
  if (!found || !isAbsolute(found)) return undefined;
  let binary: string;
  try {
    binary = realpathSync.native(found);
    if (!statSync(binary).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const paths = isNodeScript(binary) ? [node, binary] : [binary];
  return {
    command: `${paths.map((path) => quote(path, platform)).join(" ")} hook {agent}`,
    paths,
  };
}

/**
 * The absolute files a hook command starts with: the binary, or node and its script. Empty when
 * the command runs `selfhost` through PATH (or a shell line selfhost init wrote).
 */
export function hookCommandPaths(command: string): string[] {
  const words: string[] = [];
  const pattern = /'((?:[^']|'\\'')*)'|"([^"]*)"|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    const word = (match[1]?.replaceAll(`'\\''`, "'") ?? match[2] ?? match[3] ?? "").trim();
    if (word === "hook") break;
    words.push(word);
  }
  return words.length > 0 && words.every((word) => isAbsolute(word)) ? words : [];
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first of `path` and the folders above it this user can write, which lets them replace
 * the file, or undefined when none is. Root can write everything, so this is about other users.
 */
export function userWritable(path: string): string | undefined {
  let current = path;
  for (let i = 0; i < 64; i++) {
    if (writable(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}
