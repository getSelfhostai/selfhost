import {
  baseUrl,
  call,
  connected,
  failed,
  headerEnv,
  headersFrom,
  isCheck,
  isObject,
  refusedKey,
  shown,
  unexpected,
} from "../http.js";
import type { Adapter } from "../types.js";

const DOCS = "https://langfuse.com/docs/api-and-data-platform/features/public-api";

/** https://cloud.langfuse.com/api/public/otel (optionally with /v1/traces) to its host. */
const OTEL_PATH = /\/api\/public\/otel(?:\/v1\/traces)?$/;

/**
 * GET /api/public/projects with the Authorization header from headers_env, Basic
 * base64(public key:secret key): the same key the OTLP endpoint takes, and one project back.
 */
export const langfuse: Adapter<"tracer"> = {
  kind: "tracer",
  tool: "langfuse",
  describe: () => ({
    kind: "tracer",
    tool: "langfuse",
    name: "Langfuse",
    check: "GET /api/public/projects with the Basic auth key the OTLP endpoint takes.",
    docs: DOCS,
  }),
  async check(settings, env, fetch) {
    const endpoint = baseUrl(settings.endpoint, "endpoint");
    if (isCheck(endpoint)) return endpoint;
    if (!OTEL_PATH.test(endpoint)) {
      return failed(
        `endpoint should be Langfuse's OTLP endpoint, such as https://cloud.langfuse.com/api/public/otel, not ${shown(endpoint)}.`,
      );
    }
    const auth = headerEnv(settings.headers_env, "authorization");
    if (!auth) {
      return failed(
        'Langfuse needs a key. Set headers_env = { Authorization = "LANGFUSE_OTLP_AUTH" }, with that variable holding Basic and base64 of public key:secret key.',
      );
    }
    const headers = headersFrom(env, settings.headers_env);
    if (isCheck(headers)) return headers;
    const host = endpoint.replace(OTEL_PATH, "");
    const answer = await call(fetch, `${host}/api/public/projects`, { headers });
    if ("status" in answer && answer.status === 200) {
      const data = isObject(answer.json) && Array.isArray(answer.json.data) ? answer.json.data : [];
      const project = isObject(data[0]) && typeof data[0].name === "string" ? data[0].name : "";
      return connected(
        `Langfuse at ${shown(host)} accepts the key in ${auth[1]}${project ? ` (project ${project})` : ""}.`,
      );
    }
    if ("status" in answer && refusedKey(answer.status)) {
      return failed(
        `Langfuse at ${shown(host)} refused the key in ${auth[1]} (${answer.status}). It must hold Basic and base64 of public key:secret key, from a project in this region (keys work in their own region only).`,
      );
    }
    return unexpected(answer, "Langfuse", host, "Check endpoint is your Langfuse host.");
  },
};
