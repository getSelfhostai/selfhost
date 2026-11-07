/**
 * Usage limit hits in the agents' own logs, recorded as `alert.raised` events with
 * `data.alert: "usage_limit"` so the limit forecast can calibrate each person's limit from the
 * usage that led up to a hit. Only the hit itself is read: no plan, account or login details.
 */

type Json = Record<string, unknown>;

export const USAGE_LIMIT_ALERT = "usage_limit";

export interface UsageLimitHit {
  /** "session" for the 5-hour window, "weekly" for the week, absent when the log does not say. */
  window?: "session" | "weekly";
  /** When the vendor says the window resets, ISO 8601 UTC. */
  resets_at?: string;
  /** Length of the window the vendor reports, in minutes (Codex). */
  window_minutes?: number;
  /** The vendor's own label for the limit that was reached (Codex rate_limit_reached_type). */
  limit_type?: string;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function epochIso(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds <= 0) return undefined;
  const ms = seconds * 1000;
  return Number.isFinite(ms) && ms < 8.64e15 ? new Date(ms).toISOString() : undefined;
}

/** "... usage limit reached|1761580800", "5-hour limit reached", "You've hit your limit". */
const CLAUDE_LIMIT_TEXT = /usage limit|limit reached|hit your (?:usage )?limit/i;
const CLAUDE_RESET_EPOCH = /\|(\d{10})\b/;

function textOf(message: Json): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Json => isObject(block) && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/**
 * A Claude Code transcript line that reports a plan usage limit: the synthetic response
 * line (`isApiErrorMessage`, model `<synthetic>`) Claude Code writes when a request is
 * refused, whose text names the limit. Older versions end the text with `|<reset epoch>`.
 * API rate limits (429 on an API key) say neither, so they are not counted.
 */
export function claudeLimitHit(line: Json): UsageLimitHit | undefined {
  if (line.type !== "assistant" || line.isApiErrorMessage !== true) return undefined;
  const message = isObject(line.message) ? line.message : {};
  const text = textOf(message);
  if (!CLAUDE_LIMIT_TEXT.test(text)) return undefined;
  const window = /weekly/i.test(text)
    ? "weekly"
    : /5-hour|five-hour|session/i.test(text)
      ? "session"
      : undefined;
  const epoch = text.match(CLAUDE_RESET_EPOCH)?.[1];
  const resets = epochIso(epoch === undefined ? undefined : Number(epoch));
  return { ...(window ? { window } : {}), ...(resets ? { resets_at: resets } : {}) };
}

const WEEK_MINUTES = 7 * 24 * 60;

function windowOf(minutes: number | undefined, label: string): "session" | "weekly" | undefined {
  if (minutes !== undefined) return minutes >= WEEK_MINUTES / 2 ? "weekly" : "session";
  if (/secondary|week/i.test(label)) return "weekly";
  if (/primary|session|5h/i.test(label)) return "session";
  return undefined;
}

/**
 * A Codex `token_count` payload whose `rate_limits` snapshot shows a limit reached:
 * `rate_limit_reached_type` set, or the primary (5-hour) or secondary (weekly) window at 100%.
 */
export function codexLimitHit(payload: Json): UsageLimitHit | undefined {
  if (payload.type !== "token_count" || !isObject(payload.rate_limits)) return undefined;
  const limits = payload.rate_limits;
  const label =
    typeof limits.rate_limit_reached_type === "string" ? limits.rate_limit_reached_type : "";
  const windows = [limits.primary, limits.secondary].filter(isObject);
  const full = windows.find((window) => (finite(window.used_percent) ?? 0) >= 100);
  if (!full && label === "") return undefined;
  const named =
    full ??
    (/secondary|week/i.test(label) ? (limits.secondary as Json | undefined) : undefined) ??
    (/primary/i.test(label) ? (limits.primary as Json | undefined) : undefined);
  const minutes = isObject(named) ? finite(named.window_minutes) : undefined;
  const window = windowOf(minutes, label);
  const resets = epochIso(isObject(named) ? finite(named.resets_at) : undefined);
  return {
    ...(window ? { window } : {}),
    ...(resets ? { resets_at: resets } : {}),
    ...(minutes !== undefined ? { window_minutes: minutes } : {}),
    ...(label ? { limit_type: label } : {}),
  };
}
