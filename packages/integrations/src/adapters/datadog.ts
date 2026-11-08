import {
  baseUrl,
  call,
  connected,
  failed,
  headerEnv,
  isCheck,
  isObject,
  refusedKey,
  secret,
  unexpected,
} from "../http.js";
import type { Adapter } from "../types.js";

const DOCS = "https://docs.datadoghq.com/api/latest/authentication/#validate-api-key";

/** https://otlp.<site>/v1/traces to <site>, such as datadoghq.eu. */
function siteOf(endpoint: string): string | undefined {
  const host = new URL(endpoint).hostname;
  return host.startsWith("otlp.") ? host.slice("otlp.".length) : undefined;
}

/**
 * GET https://api.<site>/api/v1/validate with the dd-api-key header from headers_env, which
 * answers {"valid": true}. The OTLP intake itself takes the same key at https://otlp.<site>.
 */
export const datadog: Adapter<"tracer"> = {
  kind: "tracer",
  tool: "datadog",
  describe: () => ({
    kind: "tracer",
    tool: "datadog",
    name: "Datadog",
    check: "GET https://api.<site>/api/v1/validate with the dd-api-key from headers_env.",
    docs: DOCS,
  }),
  async check(settings, env, fetch) {
    const endpoint = baseUrl(settings.endpoint, "endpoint");
    if (isCheck(endpoint)) return endpoint;
    const site = siteOf(endpoint);
    if (!site) {
      return failed(
        "endpoint should be Datadog's OTLP intake for your site, such as https://otlp.datadoghq.com or https://otlp.datadoghq.eu.",
      );
    }
    const header = headerEnv(settings.headers_env, "dd-api-key");
    if (!header) {
      return failed(
        'Datadog needs an API key. Set headers_env = { dd-api-key = "DD_API_KEY" }, with that variable holding a Datadog API key.',
      );
    }
    const key = secret(env, header[1], "a Datadog API key", "headers_env");
    if (isCheck(key)) return key;
    const url = `https://api.${site}/api/v1/validate`;
    const answer = await call(fetch, url, { headers: { "dd-api-key": key } });
    if ("status" in answer && answer.status === 200) {
      if (isObject(answer.json) && answer.json.valid === true) {
        return connected(`Datadog (${site}) accepts the API key in ${header[1]}.`);
      }
    }
    if ("status" in answer && (refusedKey(answer.status) || answer.status === 200)) {
      return failed(
        `Datadog (${site}) refused the API key in ${header[1]}. Check the key, and that ${site} is your Datadog site.`,
      );
    }
    return unexpected(answer, "Datadog", url, "Check the site in endpoint.");
  },
};
