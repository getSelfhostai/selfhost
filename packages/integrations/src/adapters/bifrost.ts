import {
  baseUrl,
  call,
  connected,
  failed,
  isCheck,
  isObject,
  refusedKey,
  secret,
  shown,
  unexpected,
} from "../http.js";
import type { Adapter } from "../types.js";

/** The Bifrost the selfhost server's Docker Compose install runs next to it. */
export const BUNDLED_BIFROST_URL = "http://bifrost:8080";

const DOCS = "https://docs.getbifrost.ai/quickstart/gateway/setting-up-auth";

/** `username:password` goes as Basic auth, anything else as a Bearer management key. */
export function bifrostAuth(key: string): string {
  return key.includes(":") ? `Basic ${Buffer.from(key).toString("base64")}` : `Bearer ${key}`;
}

/**
 * GET /health, which needs no auth. Then with admin_key_env, GET /api/config with that key; without
 * it, GET /api/session/is-auth-enabled (public) to tell whether a key is needed.
 */
export const bifrost: Adapter<"router"> = {
  kind: "router",
  tool: "bifrost",
  describe: () => ({
    kind: "router",
    tool: "bifrost",
    name: "Bifrost",
    check:
      "GET /health, then GET /api/config with the admin key (or /api/session/is-auth-enabled without one).",
    docs: DOCS,
  }),
  async check(settings, env, fetch) {
    const base = baseUrl(settings.url ?? BUNDLED_BIFROST_URL, "url");
    if (isCheck(base)) return base;
    const health = await call(fetch, `${base}/health`);
    if ("unreachable" in health || health.status !== 200) {
      const fix = settings.url
        ? "Check url points at Bifrost."
        : `Without url selfhost uses the bundled Bifrost at ${BUNDLED_BIFROST_URL}; start it, or set url.`;
      return unexpected(health, "Bifrost", base, fix);
    }
    if (settings.admin_key_env) {
      const key = secret(
        env,
        settings.admin_key_env,
        "a Bifrost management API key or the admin username:password",
        "admin_key_env",
      );
      if (isCheck(key)) return key;
      const config = await call(fetch, `${base}/api/config`, {
        headers: { authorization: bifrostAuth(key) },
      });
      if ("status" in config && config.status === 200) {
        return connected(
          `Bifrost at ${shown(base)} is up and accepts the admin key in ${settings.admin_key_env}.`,
        );
      }
      if ("status" in config && refusedKey(config.status)) {
        return failed(
          `Bifrost at ${shown(base)} refused the admin key in ${settings.admin_key_env} (${config.status}). It must hold a management API key, or the admin username:password from Bifrost's auth settings.`,
        );
      }
      return unexpected(config, "Bifrost", base, "Check url points at Bifrost.");
    }
    const auth = await call(fetch, `${base}/api/session/is-auth-enabled`);
    if ("status" in auth && auth.status === 200 && isObject(auth.json)) {
      if (auth.json.is_auth_enabled === true) {
        return failed(
          `Bifrost at ${shown(base)} has admin sign-in on. Set admin_key_env to the environment variable that holds a management API key or the admin username:password.`,
        );
      }
      return connected(`Bifrost at ${shown(base)} is up, with admin sign-in off.`);
    }
    return connected(`Bifrost at ${shown(base)} is up.`);
  },
};
