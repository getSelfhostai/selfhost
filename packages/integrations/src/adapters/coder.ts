import { baseUrl, call, failed, isCheck, unexpected } from "../http.js";
import type { Adapter } from "../types.js";
import { keyedCheck } from "./keyed.js";

/**
 * GET /api/v2/buildinfo (no auth), then GET /api/v2/users/me with the Coder-Session-Token header.
 * Coder is self-hosted, so url is required.
 */
export const coder: Adapter<"runtime"> = {
  kind: "runtime",
  tool: "coder",
  describe: () => ({
    kind: "runtime",
    tool: "coder",
    name: "Coder",
    check: "GET /api/v2/buildinfo, then GET /api/v2/users/me with the Coder-Session-Token header.",
    docs: "https://coder.com/docs/reference/api/users",
  }),
  async check(settings, env, fetch) {
    if (!settings.url) {
      return failed(
        "Set url to your Coder deployment's access URL, such as https://coder.example.com.",
      );
    }
    const base = baseUrl(settings.url, "url");
    if (isCheck(base)) return base;
    const info = await call(fetch, `${base}/api/v2/buildinfo`);
    if ("unreachable" in info || info.status !== 200) {
      return unexpected(info, "Coder", base, "Check url is your Coder access URL.");
    }
    return keyedCheck(
      {
        name: "Coder",
        url: base,
        path: "/api/v2/users/me",
        keyEnv: settings.api_key_env ?? "CODER_SESSION_TOKEN",
        header: (key) => ["coder-session-token", key],
        what: "a Coder session or API token (coder tokens create)",
      },
      env,
      fetch,
    );
  },
};
