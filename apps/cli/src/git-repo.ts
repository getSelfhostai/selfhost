import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseRemote } from "@selfhost/schema";

/**
 * owner/name of the repository at `cwd`, from its origin remote, as get_policy in the MCP server
 * reads it. Undefined for a folder that is gone, not in git, or has no origin.
 */
export function gitRepoAt(cwd: string): string | undefined {
  if (!existsSync(cwd)) return undefined;
  try {
    const remote = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return parseRemote(remote)?.repo;
  } catch {
    return undefined;
  }
}

/** gitRepoAt with one git call per folder for the life of the returned function. */
export function cachedRepoOf(
  lookup: (cwd: string) => string | undefined = gitRepoAt,
): (cwd: string) => string | undefined {
  const known = new Map<string, string | null>();
  return (cwd) => {
    let repo = known.get(cwd);
    if (repo === undefined) {
      repo = lookup(cwd) ?? null;
      known.set(cwd, repo);
    }
    return repo ?? undefined;
  };
}
