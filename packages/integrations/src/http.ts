import type { CheckResult, Env, Fetch } from "./types.js";

/** Each call a check makes gives up after this long. */
export const CHECK_TIMEOUT_MS = 5000;

/** Bodies past this many characters are not parsed; checks need a field or two at most. */
const MAX_BODY_CHARS = 256 * 1024;

export type Answer = { status: number; json: unknown } | { unreachable: string };

export const connected = (detail: string): CheckResult => ({ status: "connected", detail });
export const failed = (detail: string): CheckResult => ({ status: "error", detail });

/** The base URL with its path's trailing slashes dropped; an error for credentials in it. */
export function baseUrl(value: string, name: string): string | CheckResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return failed(`${name}: "${shown(value)}" is not a URL.`);
  }
  if (url.username || url.password) {
    return failed(
      `${name}: the URL holds a user name or password. Take it out and name an environment variable for the key instead.`,
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** A URL for messages: no credentials, query or fragment. */
export function shown(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.replace(/\/\/[^/@]*@/, "//").split(/[?#]/)[0] ?? "";
  }
}

function reason(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `no answer within ${CHECK_TIMEOUT_MS / 1000} seconds`;
  }
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  if (typeof cause?.code === "string") return cause.code;
  return error instanceof Error ? error.message : String(error);
}

/** One request with a timeout. The body is parsed as JSON when it is JSON, else left out. */
export async function call(fetch: Fetch, url: string, init: RequestInit = {}): Promise<Answer> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (error) {
    return { unreachable: reason(error) };
  }
  let json: unknown;
  try {
    const text = await response.text();
    json = text.length <= MAX_BODY_CHARS ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

/** The error for an answer that is not the one expected, or for no answer at all. */
export function unexpected(answer: Answer, name: string, url: string, fix: string): CheckResult {
  if ("unreachable" in answer) {
    return failed(
      `Could not reach ${name} at ${shown(url)} (${answer.unreachable}). ${fix} It must be reachable from where selfhost runs.`,
    );
  }
  const subject = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  return failed(`${subject} at ${shown(url)} answered ${answer.status}. ${fix}`);
}

export const refusedKey = (status: number) => status === 401 || status === 403;

/** The variable's value, or an error naming it. The value never goes in a message. */
export function secret(
  env: Env,
  name: string,
  what: string,
  setting: string,
): string | CheckResult {
  const value = env[name]?.trim();
  if (value) return value;
  return failed(
    `Set the environment variable ${name} (${setting}) where selfhost runs, to ${what}. It is not set.`,
  );
}

/** Values of headers_env, read from the environment, or an error naming the unset ones. */
export function headersFrom(
  env: Env,
  headersEnv: Readonly<Record<string, string>> | undefined,
): Record<string, string> | CheckResult {
  const headers: Record<string, string> = {};
  const missing: string[] = [];
  for (const [header, name] of Object.entries(headersEnv ?? {})) {
    const value = env[name]?.trim();
    if (value) headers[header] = value;
    else missing.push(`${name} (for the ${header} header)`);
  }
  if (missing.length === 0) return headers;
  return failed(
    `Set ${missing.join(" and ")} where selfhost runs: headers_env names ${missing.length === 1 ? "it" : "them"}, and ${missing.length === 1 ? "it is" : "they are"} not set.`,
  );
}

/** The header named in headers_env, ignoring case, as [header, environment variable]. */
export function headerEnv(
  headersEnv: Readonly<Record<string, string>> | undefined,
  header: string,
): [string, string] | undefined {
  return Object.entries(headersEnv ?? {}).find(([key]) => key.toLowerCase() === header);
}

export const isCheck = (value: unknown): value is CheckResult =>
  typeof value === "object" && value !== null && "status" in value && "detail" in value;

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
