import { GatewayError } from "./types.js";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  /** The gateway's base URL, without a trailing slash. */
  baseUrl: string;
  /** Sent on every call: the admin credential. Never logged or returned. */
  headers: Record<string, string>;
  fetch?: Fetch;
  /** Least time between two calls, so a sync of a large team does not flood the gateway. */
  minIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Http {
  call<T>(method: string, path: string, body?: unknown): Promise<T>;
}

const ERROR_MAX = 300;
/** A 429 from the gateway is retried once, after Retry-After up to this long. */
const RETRY_AFTER_MAX_MS = 5_000;

/** Anything shaped like a key (sk-..., Bifrost's sk-bf-...) cut to its first characters. */
export function maskKeys(text: string): string {
  return text.replace(/\b(sk-[A-Za-z0-9]{0,3})[A-Za-z0-9_-]{6,}/g, "$1...");
}

/** The message in a gateway's error body: Bifrost's { error: { message } }, LiteLLM's too. */
function errorOf(json: unknown, text: string): { message: string; type?: string } {
  const body = json as
    | { error?: { message?: unknown; type?: unknown } | string; type?: unknown; detail?: unknown }
    | undefined;
  const inner = typeof body?.error === "object" ? body.error : undefined;
  const message =
    (typeof inner?.message === "string" && inner.message) ||
    (typeof body?.error === "string" && body.error) ||
    (typeof body?.detail === "string" && body.detail) ||
    text ||
    "no message";
  const type =
    (typeof body?.type === "string" && body.type) ||
    (typeof inner?.type === "string" && inner.type) ||
    undefined;
  const clean = maskKeys(message.replace(/\s+/g, " ")).slice(0, ERROR_MAX);
  return { message: clean, ...(type ? { type } : {}) };
}

/**
 * JSON calls to one gateway, one at a time and at least minIntervalMs apart, with a timeout
 * each. The admin headers go only to baseUrl; errors name the method, path and status.
 */
export function createHttp(options: HttpOptions): Http {
  const {
    baseUrl,
    headers,
    minIntervalMs = 50,
    timeoutMs = 15_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  let queue: Promise<unknown> = Promise.resolve();
  let last = 0;

  async function once(method: string, path: string, body: unknown): Promise<Response> {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      return await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new GatewayError(0, `${method} ${path}: could not reach the gateway: ${reason}`);
    }
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response = await once(method, path, body);
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      await sleep(
        Number.isFinite(seconds) && seconds > 0
          ? Math.min(seconds * 1000, RETRY_AFTER_MAX_MS)
          : 1000,
      );
      response = await once(method, path, body);
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const { message, type } = errorOf(json, text);
      throw new GatewayError(
        response.status,
        `${method} ${path} answered ${response.status}: ${message}`,
        type,
      );
    }
    return (json ?? text) as T;
  }

  return {
    call<T>(method: string, path: string, body?: unknown): Promise<T> {
      const result = queue.then(() => call<T>(method, path, body));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
