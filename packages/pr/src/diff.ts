import type { DiffLine, FileStatus, Hunk } from "./types.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const text = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);

/** Hunks from diff lines at `start`, up to the first line that is not part of one. */
function readHunks(lines: string[], start: number): { hunks: Hunk[]; next: number } {
  const hunks: Hunk[] = [];
  let i = start;
  while (i < lines.length) {
    const header = HUNK_HEADER.exec(lines[i] ?? "");
    if (!header) break;
    const hunk: Hunk = {
      oldStart: Number(header[1]),
      oldLines: header[2] === undefined ? 1 : Number(header[2]),
      newStart: Number(header[3]),
      newLines: header[4] === undefined ? 1 : Number(header[4]),
      removed: [],
      added: [],
    };
    hunks.push(hunk);
    i++;
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    let oldLeft = hunk.oldLines;
    let newLeft = hunk.newLines;
    while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const line = lines[i] ?? "";
      const mark = line[0];
      if (mark === "+" && newLeft > 0) {
        hunk.added.push({ line: newLine++, text: text(line.slice(1)) });
        newLeft--;
      } else if (mark === "-" && oldLeft > 0) {
        hunk.removed.push({ line: oldLine++, text: text(line.slice(1)) });
        oldLeft--;
      } else if ((mark === " " || line === "") && oldLeft > 0 && newLeft > 0) {
        oldLine++;
        newLine++;
        oldLeft--;
        newLeft--;
      } else if (mark !== "\\") {
        break;
      }
      i++;
    }
    // "\ No newline at end of file" after the last line of a hunk.
    while (i < lines.length && lines[i]?.startsWith("\\")) i++;
  }
  return { hunks, next: i };
}

/** The hunks of one file's unified diff, as GitHub returns it in a pull request file's `patch`. */
export function parseHunks(patch: string): Hunk[] {
  const lines = patch.split("\n");
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (HUNK_HEADER.test(lines[i] ?? "")) {
      const read = readHunks(lines, i);
      hunks.push(...read.hunks);
      i = Math.max(read.next, i + 1);
    } else {
      i++;
    }
  }
  return hunks;
}

/** One file of a `git diff` patch. */
export interface FileDiff {
  /** The new path, or the old one for a deleted file. */
  path: string;
  previousPath?: string;
  status: FileStatus;
  /** Undefined for a binary file. */
  hunks?: Hunk[];
}

/** Undoes git's C-style quoting of a path with special characters: "a/x\ty" becomes a/x<tab>y. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const body = path.slice(1, -1);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8 };
  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? "";
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = body[i + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1))?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      i += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The path of a `--- a/x` or `+++ b/x` line; undefined for /dev/null. */
function sidePath(line: string): string | undefined {
  const value = unquote(line.slice(4).replace(/\t$/, ""));
  if (value === "/dev/null") return undefined;
  return value.replace(/^[ab]\//, "");
}

/** `git diff -M` output (with its a/ and b/ prefixes): every file with its status and hunks. */
export function parseDiff(diff: string): FileDiff[] {
  const lines = diff.split("\n");
  const files: FileDiff[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = lines[i] ?? "";
    if (!start.startsWith("diff --git ")) {
      i++;
      continue;
    }
    i++;
    let status: FileStatus = "modified";
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let binary = false;
    let hunks: Hunk[] = [];
    while (i < lines.length && !lines[i]?.startsWith("diff --git ")) {
      const line = lines[i] ?? "";
      if (line.startsWith("@@")) {
        const read = readHunks(lines, i);
        hunks = hunks.concat(read.hunks);
        i = Math.max(read.next, i + 1);
        continue;
      }
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "removed";
      else if (line.startsWith("rename from ")) {
        status = "renamed";
        oldPath = unquote(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) newPath = unquote(line.slice("rename to ".length));
      else if (line.startsWith("--- ")) oldPath = sidePath(line) ?? oldPath;
      else if (line.startsWith("+++ ")) newPath = sidePath(line) ?? newPath;
      else if (line.startsWith("Binary files ")) binary = true;
      i++;
    }
    // A mode change alone names the file only on the diff --git line: "diff --git a/x b/x".
    if (oldPath === undefined && newPath === undefined) {
      const rest = start.slice("diff --git ".length);
      const half = (rest.length - 1) / 2;
      if (Number.isInteger(half) && rest[half] === " ") {
        const [a, b] = [rest.slice(0, half), rest.slice(half + 1)];
        if (a.slice(2) === b.slice(2)) oldPath = newPath = a.slice(2);
      }
    }
    const path = status === "removed" ? oldPath : (newPath ?? oldPath);
    if (path === undefined) continue;
    files.push({
      path,
      ...(status === "renamed" && oldPath !== undefined && oldPath !== path
        ? { previousPath: oldPath }
        : {}),
      status,
      ...(binary ? {} : { hunks }),
    });
  }
  return files;
}

/** A hunk's first added line, or its first removed one when it only deletes. */
export function firstChangedLine(hunk: Hunk): { side: "new" | "old"; line: DiffLine } | undefined {
  const added = hunk.added[0];
  if (added) return { side: "new", line: added };
  const removed = hunk.removed[0];
  return removed ? { side: "old", line: removed } : undefined;
}
