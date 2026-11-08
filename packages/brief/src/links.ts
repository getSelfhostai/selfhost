import { createHash } from "node:crypto";
import { runViewUrl } from "@selfhost/traces";
import type { BriefTarget } from "./types.js";

// Parentheses too, so the URL cannot end a Markdown link early.
const encodePath = (path: string) =>
  path
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29")))
    .join("/");

/**
 * A link to a file, or to one line of it, where a reviewer reads the change. For a pull request
 * it is the line in the diff view (`#diff-<sha256 of the path>R12`, `L12` for a deleted line);
 * for local commits on a GitHub repository, the line in the file at the head commit (the base
 * commit for a deleted line). Undefined when the repository is not on GitHub.
 */
export function lineUrl(
  target: BriefTarget,
  path: string,
  line?: number,
  side: "new" | "old" = "new",
): string | undefined {
  if (target.pr) {
    const anchor = createHash("sha256").update(path).digest("hex");
    const suffix = line === undefined ? "" : `${side === "old" ? "L" : "R"}${line}`;
    return `${target.pr.url}/files#diff-${anchor}${suffix}`;
  }
  if (!target.repo) return undefined;
  const sha = side === "old" ? target.base : target.head;
  const suffix = line === undefined ? "" : `#L${line}`;
  return `https://github.com/${target.repo}/blob/${sha}/${encodePath(path)}${suffix}`;
}

/** One session's run view in the team server's console, or undefined without a server. */
export function traceUrl(server: string | undefined, session: string): string | undefined {
  return server ? runViewUrl(server, session) : undefined;
}

/** The local command that prints a session's events. */
export function traceCommand(session: string): string {
  const arg = /^[\w.:@-]+$/.test(session) ? session : `'${session.replace(/'/g, "'\\''")}'`;
  return `selfhost review trace ${arg}`;
}
