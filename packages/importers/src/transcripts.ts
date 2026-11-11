import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The agents' own transcripts, for a run handoff: where each agent keeps a session's file, and
 * where a copy must go on the new owner's machine for the agent to resume it natively.
 *
 * - Claude Code keeps a session at <config>/projects/<project>/<session id>.jsonl, where config
 *   is CLAUDE_CONFIG_DIR (else ~/.claude) and project is the working directory with every
 *   character that is not a letter or digit replaced by "-". `claude --resume <session id>`
 *   looks in the current directory's project first, then in every other project, and
 *   `claude --resume <path>` takes the file itself. A name over 200 characters gets a hash of
 *   the full path that is not documented, so such a copy is resumed by its path.
 * - Codex keeps a session at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl
 *   (CODEX_HOME else ~/.codex). `codex resume <thread id>` finds it by scanning the sessions
 *   folder when its state database has no row for the thread.
 *
 * Each line names the directory the session ran in (cwd for Claude Code, payload.cwd of
 * session_meta and turn_context for Codex); a copy is moved to the new owner's clone so it
 * resumes there.
 */

export type TranscriptAgent = "claude_code" | "codex";

/** Where the agents' folders are: the environment and home folder of the person running it. */
export interface TranscriptPlaces {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
}

/** Session ids and file names that are safe as one path segment. */
const SAFE_NAME = /^(?!\.)[A-Za-z0-9._-]{1,200}$/;

/** Claude Code's longest project folder name it derives without a hash. */
const CLAUDE_PROJECT_NAME_MAX = 200;

const expandHome = (path: string, home: string) =>
  path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path;

function claudeConfigDirs({ env, home }: TranscriptPlaces): string[] {
  const set = env.CLAUDE_CONFIG_DIR?.trim();
  if (set) {
    return set
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => expandHome(part, home));
  }
  return [join(env.XDG_CONFIG_HOME || join(home, ".config"), "claude"), join(home, ".claude")];
}

/** Claude Code's config folder a copy goes to: CLAUDE_CONFIG_DIR's first, else ~/.claude. */
function claudeConfigDir(places: TranscriptPlaces): string {
  const set = places.env.CLAUDE_CONFIG_DIR?.trim();
  return set
    ? (claudeConfigDirs(places)[0] ?? join(places.home, ".claude"))
    : join(places.home, ".claude");
}

function codexHome({ env, home }: TranscriptPlaces): string {
  const set = env.CODEX_HOME?.trim();
  return set ? expandHome(set.split(",")[0]?.trim() ?? set, home) : join(home, ".codex");
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  for (const name of list(dir)) {
    const path = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(path, out, depth + 1);
    else if (name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

const newest = (paths: string[]) =>
  [...paths].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || a.localeCompare(b))[0];

/** Whether a Codex rollout file name is for this thread. */
export function isCodexRollout(name: string, threadId: string): boolean {
  return (
    name.startsWith("rollout-") &&
    (name.endsWith(`-${threadId}.jsonl`) || name.includes(`-${threadId}_`))
  );
}

/** The session's transcript on this machine, or undefined when the agent has none for it. */
export function findTranscript(
  agent: TranscriptAgent,
  sessionId: string,
  places: TranscriptPlaces,
): string | undefined {
  if (!SAFE_NAME.test(sessionId)) return undefined;
  if (agent === "claude_code") {
    const found: string[] = [];
    for (const dir of claudeConfigDirs(places)) {
      const projects = join(dir, "projects");
      for (const project of list(projects)) {
        const path = join(projects, project, `${sessionId}.jsonl`);
        if (existsSync(path)) found.push(path);
      }
    }
    return newest(found);
  }
  const home = codexHome(places);
  const found = [join(home, "sessions"), join(home, "archived_sessions")].flatMap((dir) =>
    walk(dir).filter((path) => isCodexRollout(path.split(/[\\/]/).pop() ?? "", sessionId)),
  );
  return newest(found);
}

const cwdOf = (agent: TranscriptAgent, line: Record<string, unknown>): unknown => {
  if (agent === "claude_code") return line.cwd;
  const payload = line.payload;
  return payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).cwd
    : undefined;
};

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The directory the session ran in: the first one its lines name. */
export function transcriptCwd(agent: TranscriptAgent, text: string): string | undefined {
  for (const line of text.split("\n")) {
    const cwd = line.trim() === "" ? undefined : cwdOf(agent, parseLine(line) ?? {});
    if (typeof cwd === "string" && cwd !== "") return cwd;
  }
  return undefined;
}

const moved = (path: string, from: string, to: string) =>
  path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;

/**
 * The transcript with the directory it ran in (and folders under it) moved from `from` to `to`
 * on every line that names one. Other lines are kept byte for byte.
 */
export function rehomeTranscript(
  agent: TranscriptAgent,
  text: string,
  from: string,
  to: string,
): string {
  if (from === to) return text;
  return text
    .split("\n")
    .map((line) => {
      const parsed = line.trim() === "" ? undefined : parseLine(line);
      const cwd = parsed ? cwdOf(agent, parsed) : undefined;
      if (!parsed || typeof cwd !== "string") return line;
      const next = moved(cwd, from, to);
      if (next === cwd) return line;
      if (agent === "claude_code") return JSON.stringify({ ...parsed, cwd: next });
      return JSON.stringify({
        ...parsed,
        payload: { ...(parsed.payload as Record<string, unknown>), cwd: next },
      });
    })
    .join("\n");
}

/** Claude Code's project folder name for a working directory, or undefined past 200 characters. */
export function claudeProjectName(cwd: string): string | undefined {
  const name = resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
  return name.length > CLAUDE_PROJECT_NAME_MAX ? undefined : name;
}

/** YYYY/MM/DD of a Codex rollout name (rollout-2026-11-11T10-00-00-<id>.jsonl), else of `at`. */
function codexDay(fileName: string, at: Date): string {
  const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(fileName);
  if (match) return `${match[1]}/${match[2]}/${match[3]}`;
  const iso = at.toISOString();
  return `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

export interface PlacedTranscript {
  /** Where the copy is. */
  path: string;
  /** How the agent resumes it from the clone: by session id, or by the file's path. */
  resumeBy: "id" | "path";
  /** false when a file was already there and was kept as it was. */
  written: boolean;
}

/**
 * Writes the transcript where the agent resumes it on this machine, for a session that runs in
 * `repoRoot` from now on: the lines are moved there first. A file already at that place is
 * kept as it is (the session is this person's own, say, handed back to them). A Claude Code
 * project folder whose name would need a hash goes to `spare`, resumed by its path.
 */
export function placeTranscript(
  agent: TranscriptAgent,
  transcript: { sessionId: string; fileName: string; text: string },
  repoRoot: string,
  places: TranscriptPlaces,
  options: { spare: string; now: Date },
): PlacedTranscript {
  const from = transcriptCwd(agent, transcript.text);
  const text = from ? rehomeTranscript(agent, transcript.text, from, repoRoot) : transcript.text;
  const sparePath = join(options.spare, transcript.fileName);
  if (!SAFE_NAME.test(transcript.sessionId) || !SAFE_NAME.test(transcript.fileName)) {
    throw new Error(`Not a transcript name: ${transcript.fileName}`);
  }
  const toSpare = (): PlacedTranscript => {
    mkdirSync(options.spare, { recursive: true, mode: 0o700 });
    writeFileSync(sparePath, text, { mode: 0o600 });
    return { path: sparePath, resumeBy: "path", written: true };
  };
  let target: string | undefined;
  if (agent === "claude_code") {
    const project = claudeProjectName(repoRoot);
    if (project) {
      target = join(claudeConfigDir(places), "projects", project, `${transcript.sessionId}.jsonl`);
    }
  } else {
    target = join(
      codexHome(places),
      "sessions",
      codexDay(transcript.fileName, options.now),
      transcript.fileName,
    );
  }
  if (!target) return toSpare();
  // Already here: the session is this person's own, or was taken over before. Theirs is kept.
  if (existsSync(target)) return { path: target, resumeBy: "id", written: false };
  mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(target, text, { mode: 0o600 });
  return { path: target, resumeBy: "id", written: true };
}
