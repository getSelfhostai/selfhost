import { maskSecrets, NOTIFY_TARGET_NAME_PATTERN } from "@selfhost/schema";

/** An Apprise URL: a scheme, ://, and the rest with no whitespace. */
const APPRISE_URL = /^([a-z][a-z0-9+.-]{1,31}):\/\/\S+$/i;
const MAX_URL_LENGTH = 2048;
const NAME = new RegExp(NOTIFY_TARGET_NAME_PATTERN);

/** Any URL-shaped text, for masking error messages that may echo a target back. */
const ANY_URL = /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s"'<>]+/gi;

/** Why an Apprise URL is refused, or undefined when it looks like one. */
export function urlProblem(url: string): string | undefined {
  if (url.length > MAX_URL_LENGTH) return `Expected at most ${MAX_URL_LENGTH} characters`;
  if (!APPRISE_URL.test(url)) {
    return "Expected an Apprise URL such as tgram://<bot token>/<chat id>, mailtos://..., slack://... or ntfys://<topic>";
  }
  return undefined;
}

export function nameProblem(name: string): string | undefined {
  return NAME.test(name)
    ? undefined
    : "Expected 1 to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit";
}

/**
 * Apprise services that only ever reach the vendor's own public host, so a target cannot point
 * the server at a machine on its own network. Anything else (json://, form://, mailto://, a
 * self-hosted ntfy or Gotify, a plain https:// webhook) takes a host, and only a team's owners and
 * admins may add it.
 */
export const HOSTED_SERVICES: ReadonlySet<string> = new Set([
  "tgram",
  "slack",
  "discord",
  "msteams",
  "pover",
  "pbul",
  "whatsapp",
  "pagerduty",
  "opsgenie",
]);

/** True when the URL's service only reaches the vendor's public host. */
export function isHostedService(url: string): boolean {
  return HOSTED_SERVICES.has(serviceOf(url));
}

/** The URL's scheme in lower case, such as tgram or mailtos. */
export function serviceOf(url: string): string {
  return (APPRISE_URL.exec(url)?.[1] ?? "unknown").toLowerCase();
}

/** What an answer or a log line may show of a target URL: its scheme and nothing else. */
export function maskUrl(url: string): string {
  return `${serviceOf(url)}://****`;
}

/**
 * Text that may go into a log line, an API answer or the send record: every URL is reduced to
 * its scheme, and secret-shaped values are masked. Apprise's errors can quote a target's URL.
 */
export function scrub(text: string, urls: readonly string[] = []): string {
  let out = text;
  for (const url of urls) if (url !== "") out = out.split(url).join(maskUrl(url));
  out = out.replace(ANY_URL, (match) => maskUrl(match));
  return maskSecrets(out).text;
}

/** A free name for a new target: its service, then service-2, service-3 and on. */
export function freeName(service: string, taken: ReadonlySet<string>): string {
  const base = service.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 36) || "target";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base}-${n}`;
    if (!taken.has(name)) return name;
  }
}
