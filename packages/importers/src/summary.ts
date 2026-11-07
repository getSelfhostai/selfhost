import { isAbsolute, relative } from "node:path";

/** Longest `tool.input_summary` and `target.value`, in characters. */
export const SUMMARY_MAX_CHARS = 120;
/** Longest stored prompt when `logPrompts` is on. */
export const PROMPT_MAX_CHARS = 2000;

const REDACTED = "[redacted]";

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

// NAME=value where the name says it holds a secret.
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"'&|;]+)/gi;
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const URL_CREDENTIALS = /\/\/[^/\s:@]+:[^/\s@]+@/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

/** Masks secret-shaped values and email addresses. */
export function maskSecrets(text: string): { text: string; masked: boolean } {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out
    .replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string, value: string) =>
      value === REDACTED ? `${name}${separator}${value}` : `${name}${separator}${REDACTED}`,
    )
    .replace(AUTH_HEADER, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(URL_CREDENTIALS, `//${REDACTED}@`)
    .replace(EMAIL, (match) => (match.startsWith("git@") ? match : REDACTED));
  return { text: out, masked: out !== text };
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

/** First line of a command or value, whitespace collapsed, masked, then truncated. */
export function summarize(text: string): { text: string; masked: boolean } | undefined {
  const firstLine = text.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (firstLine === "") return undefined;
  const masked = maskSecrets(firstLine);
  const multiline = /\r?\n\s*\S/.test(text.trim());
  const shown = multiline ? `${masked.text} ...` : masked.text;
  return { text: truncate(shown, SUMMARY_MAX_CHARS), masked: masked.masked };
}

export function displayPath(path: string, cwd: string | undefined): string {
  if (cwd && isAbsolute(path)) {
    const rel = relative(cwd, path);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  return path;
}

export type TargetType = "file" | "command" | "url";

export interface ToolDetails {
  summary?: string;
  target?: { type: TargetType; value: string };
  masked: boolean;
  /** The full command, kept in memory only to detect git commits. */
  command?: string;
}

export function toolDetails(
  value: string | undefined,
  type: TargetType | undefined,
  extra: { command?: string; prefix?: string } = {},
): ToolDetails {
  const summary = value === undefined ? undefined : summarize(value);
  if (!summary) return { masked: false, command: extra.command };
  const text = extra.prefix
    ? truncate(`${extra.prefix} ${summary.text}`, SUMMARY_MAX_CHARS)
    : summary.text;
  return {
    summary: text,
    target: type ? { type, value: summary.text } : undefined,
    masked: summary.masked,
    command: extra.command,
  };
}

/** Tool fields for an event: name, summary and target, with `redacted` set when masking hit. */
export function toolFields(name: string, details: ToolDetails) {
  return {
    tool: details.summary ? { name, input_summary: details.summary } : { name },
    ...(details.target ? { target: details.target } : {}),
    ...(details.masked
      ? {
          redacted: details.target
            ? ["tool.input_summary", "target.value"]
            : ["tool.input_summary"],
        }
      : {}),
  };
}

const GIT_COMMIT = /\bgit\b[^\n;&|]*?\bcommit\b/;
const COMMIT_LINE = /\[([^\]\n]+?) ([0-9a-f]{7,40})\]/g;

export function isGitCommitCommand(command: string | undefined): boolean {
  return command !== undefined && GIT_COMMIT.test(command);
}

/** Commits git reported creating, from `[branch sha] subject` lines in its output. */
export function commitsFromOutput(output: string): { sha: string; branch?: string }[] {
  const commits: { sha: string; branch?: string }[] = [];
  for (const match of output.matchAll(COMMIT_LINE)) {
    const branch = match[1]?.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    const sha = match[2];
    if (sha && !commits.some((commit) => commit.sha === sha)) {
      commits.push(branch ? { sha, branch } : { sha });
    }
  }
  return commits;
}

/** Prompt text for `data.prompt`: masked and capped. */
export function promptData(text: string): { data: Record<string, unknown>; masked: boolean } {
  const masked = maskSecrets(text);
  const prompt = truncate(masked.text, PROMPT_MAX_CHARS);
  return {
    data: {
      prompt,
      prompt_chars: text.length,
      ...(prompt.length < masked.text.length ? { prompt_truncated: true } : {}),
    },
    masked: masked.masked,
  };
}
