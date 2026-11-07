import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter as hostDelimiter, join } from "node:path";
import type { Env, KeychainCheck, Probes, VersionProbe, Which } from "./types.js";

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Looks a command up on env.PATH, like `which`. Reads the file system only. */
export function pathLookup(env: Env, platform: NodeJS.Platform = process.platform): Which {
  const delimiter =
    platform === "win32" ? ";" : platform === process.platform ? hostDelimiter : ":";
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((dir) => dir !== "");
  const extensions =
    platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((ext) => ext.toLowerCase())]
      : [""];
  return (name) => {
    for (const dir of dirs) {
      for (const ext of extensions) {
        const candidate = join(dir, name + ext);
        if (isExecutable(candidate, platform)) return candidate;
      }
    }
    return undefined;
  };
}

/**
 * Asks the macOS keychain whether an item exists with `security find-generic-password -s`.
 * It never passes -w or -g, so the secret is never read or printed.
 */
export const macKeychain: KeychainCheck = (service, account) => {
  const args = ["find-generic-password", "-s", service];
  if (account) args.push("-a", account);
  const result = spawnSync("/usr/bin/security", args, { stdio: "ignore", timeout: 5000 });
  if (result.error || result.status === null) return undefined;
  if (result.status === 0) return true;
  // 44 is errSecItemNotFound.
  return result.status === 44 ? false : undefined;
};

/** Runs `<binary> --version` with a short timeout and returns the first output line. */
export function versionProbe(env: Env): VersionProbe {
  return (binary) => {
    const result = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    if (result.error || result.status !== 0) return undefined;
    const line = result.stdout.split("\n").find((text) => text.trim() !== "");
    return line?.trim();
  };
}

/** The real PATH lookup, keychain check and version probe for this machine. */
export function systemProbes(env: Env, platform: NodeJS.Platform = process.platform): Probes {
  return {
    which: pathLookup(env, platform),
    keychain: platform === "darwin" ? macKeychain : undefined,
    version: versionProbe(env),
  };
}
