import type { ResolvedSelfhostConfig } from "./config.js";
import type { LedgerEvent } from "./event.js";

/** What a masked value becomes. A [[redaction]] pattern from selfhost.toml adds its name. */
export const REDACTED = "[redacted]";

/** One [[redaction]] entry from selfhost.toml. */
export interface RedactionPattern {
  name: string;
  /** Regular expression; every match is masked. */
  pattern: string;
}

/** What is stored: prompt text or not, and the patterns masked on top of the built-in ones. */
export interface RedactionSettings {
  /** Keep prompt and response text (`ledger.log_prompts`). */
  logPrompts: boolean;
  /** `[[redaction]]` patterns, applied after the built-in secret and email patterns. */
  patterns: readonly RedactionPattern[];
  /**
   * Exact values to mask before anything else, such as the secrets a run was given. Each match
   * becomes [redacted:<name>]. Values shorter than MIN_LITERAL_LENGTH are skipped.
   */
  literals?: readonly SecretLiteral[];
}

/** A known secret value and the name its mask carries. */
export interface SecretLiteral {
  name: string;
  value: string;
}

/** Shorter values would mask ordinary text, so they are not masked by value. */
export const MIN_LITERAL_LENGTH = 6;

/**
 * Masks every occurrence of each known value, longest first so a value that contains another is
 * masked whole. Plain string search: no value is ever compiled or cached.
 */
export function maskLiterals(
  text: string,
  literals: readonly SecretLiteral[],
): { text: string; masked: boolean } {
  let out = text;
  const ordered = [...literals]
    .filter((literal) => literal.value.length >= MIN_LITERAL_LENGTH)
    .sort((a, b) => b.value.length - a.value.length);
  for (const { name, value } of ordered) {
    if (out.includes(value)) out = out.split(value).join(`[redacted:${name}]`);
  }
  return { text: out, masked: out !== text };
}

/** The selfhost.toml defaults: no prompt or response text, built-in patterns only. */
export const DEFAULT_REDACTION: RedactionSettings = { logPrompts: false, patterns: [] };

export function redactionSettings(
  config: Pick<ResolvedSelfhostConfig, "ledger" | "redaction">,
): RedactionSettings {
  return { logPrompts: config.ledger.log_prompts, patterns: config.redaction };
}

/**
 * Keys under `data` that hold person ids (an email or login, like `actor.id`). They route alerts
 * and review items to people, or (sent_by) name the person token that sent a laptop's own
 * system event, so they are kept like `actor`, not masked as free text.
 */
export const IDENTITY_DATA_KEYS = [
  "owner",
  "owners",
  "previous_owner",
  "budget_owner",
  "person",
  "people",
  "sent_by",
] as const;

/** Keys under `data` that hold prompt or response text, dropped unless prompts are logged. */
export const PROMPT_DATA_KEYS = ["prompt", "messages", "response", "completion"] as const;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bselfhost_(?:pt_|inv_)?[A-Za-z0-9_-]{32,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

// NAME=value where the name says it holds a secret.
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"'&|;]+)/gi;
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const URL_CREDENTIALS = /\/\/[^/\s:@]+:[^/\s@]+@/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const MASK = /^\[redacted(?::[^\]]*)?\]$/;

const compiled = new Map<string, RegExp>();

function compile({ name, pattern }: RedactionPattern): RegExp {
  let regex = compiled.get(pattern);
  if (!regex) {
    try {
      regex = new RegExp(pattern, "g");
    } catch (error) {
      throw new Error(`[[redaction]] ${name}: ${(error as Error).message}`);
    }
    compiled.set(pattern, regex);
  }
  return regex;
}

/**
 * Masks secret-shaped values (provider API keys, tokens, private keys, credential assignments,
 * auth headers, credentials in URLs) and email addresses, then every match of `patterns`.
 * Emails in `keep` (lowercase) stay: the person ids the event stores in the clear anyway.
 * Masking text that is already masked changes nothing.
 */
export function maskSecrets(
  text: string,
  patterns: readonly RedactionPattern[] = [],
  keep: ReadonlySet<string> = new Set(),
): { text: string; masked: boolean } {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out
    .replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string, value: string) =>
      MASK.test(value) ? `${name}${separator}${value}` : `${name}${separator}${REDACTED}`,
    )
    .replace(AUTH_HEADER, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(URL_CREDENTIALS, `//${REDACTED}@`)
    .replace(EMAIL, (match) =>
      match.startsWith("git@") || keep.has(match.toLowerCase()) ? match : REDACTED,
    );
  for (const entry of patterns) {
    out = out.replace(compile(entry), (match) =>
      match === "" || MASK.test(match) ? match : `[redacted:${entry.name}]`,
    );
  }
  return { text: out, masked: out !== text };
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * The person ids an event stores in the clear: its actor, who decided, and the ids under `data`
 * such as `owner`. Lowercase.
 */
function identitiesOf(event: LedgerEvent): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) ids.add(value.toLowerCase());
    else if (Array.isArray(value)) for (const item of value) add(item);
  };
  if (event.actor.kind === "person") add(event.actor.id);
  add(event.decision?.by);
  for (const key of IDENTITY_DATA_KEYS) add(event.data?.[key]);
  return ids;
}

/**
 * The event as it may be stored. Prompt and response text under `data` is dropped unless
 * `logPrompts` is on, and secrets and emails are masked in the free-text fields:
 * `tool.input_summary`, `target.value`, `decision.reason` and every string under `data`. Who did
 * it (`actor`, `decision.by`, person ids under `data` such as `owner`) and the ids, links and
 * counts are kept, and so are those same person ids where `data` text names them, such as the
 * person in a budget alert's message: the event holds them in the clear already, and the owners
 * the alert goes to need to see who it is about. Any other email is masked. Each field path that
 * was dropped or masked is added to `redacted`.
 */
export function redactEvent(
  event: LedgerEvent,
  settings: RedactionSettings = DEFAULT_REDACTION,
): LedgerEvent {
  const paths: string[] = [];
  const people = identitiesOf(event);
  const mask = (text: string, path: string, keep?: ReadonlySet<string>): string => {
    const known = maskLiterals(text, settings.literals ?? []);
    const result = maskSecrets(known.text, settings.patterns, keep);
    if (known.masked || result.masked) paths.push(path);
    return result.text;
  };
  const maskValue = (value: unknown, path: string): unknown => {
    if (typeof value === "string") return mask(value, path, people);
    if (Array.isArray(value)) return value.map((item, i) => maskValue(item, `${path}[${i}]`));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, maskValue(item, childPath(path, key))]),
      );
    }
    return value;
  };

  const out: LedgerEvent = { ...event };
  if (event.tool?.input_summary !== undefined) {
    out.tool = {
      ...event.tool,
      input_summary: mask(event.tool.input_summary, "tool.input_summary"),
    };
  }
  if (event.target) {
    out.target = { ...event.target, value: mask(event.target.value, "target.value") };
  }
  if (event.decision?.reason !== undefined) {
    out.decision = { ...event.decision, reason: mask(event.decision.reason, "decision.reason") };
  }
  if (event.data) {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event.data)) {
      const path = childPath("data", key);
      if (!settings.logPrompts && (PROMPT_DATA_KEYS as readonly string[]).includes(key)) {
        paths.push(path);
      } else if ((IDENTITY_DATA_KEYS as readonly string[]).includes(key)) {
        data[key] = value;
      } else {
        data[key] = maskValue(value, path);
      }
    }
    out.data = data;
  }
  const redacted = [...new Set([...(event.redacted ?? []), ...paths])];
  if (redacted.length > 0) out.redacted = redacted;
  return out;
}
