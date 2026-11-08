import {
  baseUrl,
  call,
  connected,
  failed,
  headersFrom,
  isCheck,
  refusedKey,
  shown,
  unexpected,
} from "../http.js";
import type { Adapter } from "../types.js";

const DOCS = "https://arize.com/docs/phoenix/self-hosting/features/authentication";

/**
 * GET /healthz (no auth), then GET /v1/projects?limit=1 with the headers from headers_env, which
 * answers 401 when Phoenix has auth on and the key is missing or wrong.
 */
export const phoenix: Adapter<"tracer"> = {
  kind: "tracer",
  tool: "phoenix",
  describe: () => ({
    kind: "tracer",
    tool: "phoenix",
    name: "Phoenix",
    check: "GET /healthz, then GET /v1/projects?limit=1 with the headers from headers_env.",
    docs: DOCS,
  }),
  async check(settings, env, fetch) {
    const endpoint = baseUrl(settings.endpoint, "endpoint");
    if (isCheck(endpoint)) return endpoint;
    const headers = headersFrom(env, settings.headers_env);
    if (isCheck(headers)) return headers;
    const base = endpoint.replace(/\/v1\/traces$/, "");
    const fix = "Check endpoint is your Phoenix address, such as http://phoenix:6006.";
    const health = await call(fetch, `${base}/healthz`);
    if ("unreachable" in health || health.status !== 200) {
      return unexpected(health, "Phoenix", base, fix);
    }
    const projects = await call(fetch, `${base}/v1/projects?limit=1`, { headers });
    if ("status" in projects && projects.status === 200) {
      return connected(`Phoenix at ${shown(base)} is up and takes the key.`);
    }
    if ("status" in projects && refusedKey(projects.status)) {
      const named = Object.values(settings.headers_env ?? {});
      return failed(
        named.length > 0
          ? `Phoenix at ${shown(base)} refused the key in ${named.join(", ")} (${projects.status}). It must hold Bearer and a Phoenix API key.`
          : `Phoenix at ${shown(base)} has auth on. Set headers_env = { Authorization = "PHOENIX_AUTH" }, with that variable holding Bearer and a Phoenix API key.`,
      );
    }
    return unexpected(projects, "Phoenix", base, fix);
  },
};
