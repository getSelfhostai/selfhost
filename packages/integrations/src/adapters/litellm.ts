import {
  baseUrl,
  call,
  connected,
  failed,
  isCheck,
  refusedKey,
  secret,
  shown,
  unexpected,
} from "../http.js";
import type { Adapter } from "../types.js";

const DOCS = "https://docs.litellm.ai/docs/proxy/health";

/**
 * GET /health/liveliness (no auth), then GET /v1/models with the master key. Not GET /health,
 * which sends a request to every model and costs tokens, and not /key/info, which can answer 404
 * for the master key itself.
 */
export const litellm: Adapter<"router"> = {
  kind: "router",
  tool: "litellm",
  describe: () => ({
    kind: "router",
    tool: "litellm",
    name: "LiteLLM",
    check: "GET /health/liveliness, then GET /v1/models with the master key.",
    docs: DOCS,
  }),
  async check(settings, env, fetch) {
    if (!settings.url) {
      return failed(
        "Set url to the address of your LiteLLM proxy, such as http://litellm:4000. selfhost does not run LiteLLM itself.",
      );
    }
    const base = baseUrl(settings.url, "url");
    if (isCheck(base)) return base;
    const live = await call(fetch, `${base}/health/liveliness`);
    if ("unreachable" in live || live.status !== 200) {
      return unexpected(live, "LiteLLM", base, "Check url points at the LiteLLM proxy.");
    }
    const keyEnv = settings.admin_key_env;
    let headers: Record<string, string> = {};
    if (keyEnv) {
      const key = secret(env, keyEnv, "the proxy's master key", "admin_key_env");
      if (isCheck(key)) return key;
      headers = { authorization: `Bearer ${key}` };
    }
    const models = await call(fetch, `${base}/v1/models`, { headers });
    if ("status" in models && models.status === 200) {
      return connected(
        keyEnv
          ? `LiteLLM at ${shown(base)} is up and accepts the master key in ${keyEnv}.`
          : `LiteLLM at ${shown(base)} is up and needs no key.`,
      );
    }
    if ("status" in models && refusedKey(models.status)) {
      return failed(
        keyEnv
          ? `LiteLLM at ${shown(base)} refused the key in ${keyEnv} (${models.status}). It must hold the proxy's master key (LITELLM_MASTER_KEY on the proxy).`
          : `LiteLLM at ${shown(base)} needs a key. Set admin_key_env to the environment variable that holds its master key.`,
      );
    }
    return unexpected(models, "LiteLLM", base, "Check url points at the LiteLLM proxy.");
  },
};
