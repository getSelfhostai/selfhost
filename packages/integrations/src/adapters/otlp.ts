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

const DOCS = "https://opentelemetry.io/docs/specs/otlp/#otlphttp";

/** The traces URL of an OTLP/HTTP endpoint: /v1/traces is added unless it is there already. */
export function tracesUrl(endpoint: string): string {
  return /\/v1\/traces$/.test(endpoint) ? endpoint : `${endpoint}/v1/traces`;
}

/**
 * POST /v1/traces with an empty export request: a zero-length protobuf body is a valid
 * ExportTraceServiceRequest with no spans, so nothing is stored. Any 2xx passes.
 */
export const otlp: Adapter<"tracer"> = {
  kind: "tracer",
  tool: "otlp",
  describe: () => ({
    kind: "tracer",
    tool: "otlp",
    name: "OTLP endpoint",
    check: "POST /v1/traces with an empty export request and the headers from headers_env.",
    docs: DOCS,
  }),
  async check(settings, env, fetch) {
    const base = baseUrl(settings.endpoint, "endpoint");
    if (isCheck(base)) return base;
    const headers = headersFrom(env, settings.headers_env);
    if (isCheck(headers)) return headers;
    const url = tracesUrl(base);
    const answer = await call(fetch, url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-protobuf" },
      body: new Uint8Array(0),
    });
    if ("status" in answer && answer.status >= 200 && answer.status < 300) {
      return connected(`The OTLP endpoint at ${shown(url)} accepted an empty export.`);
    }
    if ("status" in answer && refusedKey(answer.status)) {
      const named = Object.values(settings.headers_env ?? {});
      return failed(
        named.length > 0
          ? `The OTLP endpoint at ${shown(url)} refused the headers from ${named.join(", ")} (${answer.status}). Check the key they hold.`
          : `The OTLP endpoint at ${shown(url)} needs credentials (${answer.status}). Set headers_env, such as { Authorization = "OTLP_AUTH" }.`,
      );
    }
    if ("status" in answer && (answer.status === 404 || answer.status === 405)) {
      return failed(
        `Nothing at ${shown(url)} takes OTLP traces (${answer.status}). Set endpoint to the OTLP/HTTP base URL; selfhost adds /v1/traces.`,
      );
    }
    return unexpected(answer, "the OTLP endpoint", url, "It should take OTLP/HTTP protobuf.");
  },
};
