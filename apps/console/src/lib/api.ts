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

async function request(path: string, signal?: AbortSignal): Promise<Response> {
  const token = currentToken();
  const res = await fetch(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
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

export async function getMe(signal?: AbortSignal): Promise<MeResponse> {
  return (await request("/v1/me", signal)).json();
}

export async function getUsage(query: URLSearchParams, signal?: AbortSignal) {
  return (await (await request(`/v1/usage?${query}`, signal)).json()) as UsageResponse;
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
