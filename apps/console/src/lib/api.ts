import type { ApiError, MeResponse, UsageResponse } from "@selfhost/schema";

/**
 * How the console signs in. On a laptop `selfhost console` opens it with #token=<token>, which
 * is kept in this browser's localStorage and taken out of the address bar; the fragment never
 * reaches a server. On a team server people paste their own person token (or the admin token),
 * or, when the operator turned on sign-in, the proxy in front of the server says who they are
 * and no token is needed.
 */
const TOKEN_KEY = "selfhost.token";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function storedToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private windows can refuse storage: the token then lasts until the page closes.
  }
  memoryToken = token;
}

export function forgetToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing kept.
  }
  memoryToken = undefined;
}

let memoryToken: string | undefined;

/** Keeps a token handed over in the URL fragment and removes it from the address bar. */
export function takeTokenFromUrl(location: Location, history: History): void {
  const match = /^#token=([^&]+)/.exec(location.hash);
  if (!match?.[1]) return;
  saveToken(decodeURIComponent(match[1]));
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

const currentToken = () => memoryToken ?? storedToken();

/**
 * Whether the token in use came with this page: from the URL fragment or typed into the sign-in
 * form. A token this browser kept from an earlier visit did not, so its refusal is no error of
 * the visitor's.
 */
export const tokenGivenNow = () => memoryToken !== undefined;

async function request(path: string, signal?: AbortSignal, init: RequestInit = {}) {
  const token = currentToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    credentials: "same-origin",
    signal,
  });
  if (res.ok) return res;
  let message = `${res.status} ${res.statusText}`;
  try {
    message = ((await res.json()) as ApiError).error.message;
  } catch {
    // Not a selfhost error body, for example a proxy's sign-in page.
  }
  throw new ApiRequestError(res.status, message);
}

/** GET a JSON body. */
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return (await (await request(path, signal)).json()) as T;
}

/**
 * Whether the server has no such route or thing. A person token's unknown routes answer 403
 * with this message rather than 404, so it counts too.
 */
export function isMissing(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  return (
    error.status === 404 ||
    (error.status === 403 && error.message.startsWith("A person token works in the teams"))
  );
}

/**
 * GET a JSON body from a route this server may not have yet: null when it is missing, so the
 * screen shows that it is not there instead of an error.
 */
export async function getOptional<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  try {
    return await getJson<T>(path, signal);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** POST, PUT, PATCH or DELETE with an optional JSON body; the JSON answer. */
export async function send<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await request(path, undefined, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await res.json()) as T;
}

/** A query string from the values that are set. */
export function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const teamPath = (id: string) => `/v1/teams/${encodeURIComponent(id)}`;

export async function getMe(signal?: AbortSignal): Promise<MeResponse> {
  return getJson("/v1/me", signal);
}

export async function getUsage(params: URLSearchParams, signal?: AbortSignal) {
  return getJson<UsageResponse>(`/v1/usage?${params}`, signal);
}

/** Downloads the CSV of a usage query under the name the server gives it. */
export async function downloadUsageCsv(query: URLSearchParams): Promise<void> {
  const res = await request(`/v1/usage.csv?${query}`);
  const name =
    /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ??
    "selfhost-usage.csv";
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
