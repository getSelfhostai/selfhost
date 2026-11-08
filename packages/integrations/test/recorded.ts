import type { Fetch } from "../src/index.js";

/**
 * Answers recorded from each tool's API docs, keyed by "METHOD url". A test serves some of them
 * through a fake fetch; any other request fails as unreachable, so nothing reaches the network.
 */
export interface Recorded {
  status: number;
  body?: unknown;
}

export interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyBytes: number;
}

export function fakeFetch(answers: Record<string, Recorded | ((sent: SentRequest) => Recorded)>) {
  const sent: SentRequest[] = [];
  const fetch: Fetch = async (url, init = {}) => {
    const request: SentRequest = {
      method: init.method ?? "GET",
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      bodyBytes: init.body instanceof Uint8Array ? init.body.byteLength : 0,
    };
    sent.push(request);
    const answer = answers[`${request.method} ${url}`];
    if (!answer) {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }
    const { status, body } = typeof answer === "function" ? answer(request) : answer;
    const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, { status });
  };
  return { fetch, sent };
}

/** Answers 200 when the header holds the value, else 401. */
export const withHeader =
  (header: string, value: string, ok: Recorded, refused: Recorded = { status: 401 }) =>
  (sent: SentRequest): Recorded =>
    sent.headers[header] === value ? ok : refused;

export const RECORDED = {
  bifrostHealth: {
    status: 200,
    body: { status: "ok", components: { config_store: "ok", log_store: "ok", vector_store: "ok" } },
  },
  bifrostAuthOff: {
    status: 200,
    body: { is_auth_enabled: false, has_valid_token: false, auth_type: "none" },
  },
  bifrostAuthOn: {
    status: 200,
    body: { is_auth_enabled: true, has_valid_token: false, auth_type: "password" },
  },
  bifrostConfig: { status: 200, body: { client_config: {} } },
  litellmAlive: { status: 200, body: "I'm alive!" },
  litellmModels: {
    status: 200,
    body: { data: [{ id: "gpt-4o", object: "model" }], object: "list" },
  },
  litellmRefused: {
    status: 401,
    body: { error: { message: "Authentication Error, Invalid proxy server token passed." } },
  },
  langfuseProjects: {
    status: 200,
    body: { data: [{ id: "p1", name: "agents", organization: { id: "o1", name: "Acme" } }] },
  },
  phoenixHealth: { status: 200, body: "OK" },
  phoenixProjects: { status: 200, body: { data: [{ id: "UHJvamVjdDox", name: "default" }] } },
  datadogValid: { status: 200, body: { valid: true } },
  datadogInvalid: { status: 403, body: { errors: ["Forbidden"] } },
  e2bSandboxes: { status: 200, body: [] },
  e2bRefused: { status: 401, body: { code: 401, message: "authorization header is missing" } },
  daytonaKey: { status: 200, body: { name: "selfhost", value: "dtn_****", permissions: [] } },
  coderBuildinfo: {
    status: 200,
    body: {
      version: "v2.18.0",
      external_url: "https://github.com/coder/coder",
      dashboard_url: "https://coder.example.com",
    },
  },
  coderMe: { status: 200, body: { id: "u1", username: "ada", status: "active", roles: [] } },
  coderRefused: { status: 401, body: { message: "You must be logged in to do that." } },
} satisfies Record<string, Recorded>;
