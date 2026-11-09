import {
  baseUrl,
  call,
  connected,
  failed,
  isCheck,
  refusedKey,
  shown,
  unexpected,
} from "../http.js";
import { missingUrl, RUNTIME_KEYS, runtimeCredentials } from "../runtime-keys.js";
import type { Adapter } from "../types.js";

/** OpenSandbox's lifecycle API sits under /v1; the url may name it or not. */
export function openSandboxApi(url: string): string {
  return `${url.replace(/\/v1$/, "")}/v1`;
}

/**
 * GET /v1/sandboxes?pageSize=1 with the OPEN-SANDBOX-API-KEY header: lists sandboxes, starts
 * none. OpenSandbox is the team's own server, so url is required; a server on localhost may run
 * without a key.
 */
export const opensandbox: Adapter<"runtime"> = {
  kind: "runtime",
  tool: "opensandbox",
  describe: () => ({
    kind: "runtime",
    tool: "opensandbox",
    name: "OpenSandbox",
    check: "GET /v1/sandboxes?pageSize=1 with the OPEN-SANDBOX-API-KEY header.",
    docs: "https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/server/README.md",
  }),
  async check(settings, env, fetch) {
    if (!settings.url) return missingUrl("opensandbox") ?? failed("Set url.");
    const base = baseUrl(settings.url, "url");
    if (isCheck(base)) return base;
    const credentials = runtimeCredentials("opensandbox", { ...settings, url: base }, env);
    if (isCheck(credentials)) return credentials;
    const api = openSandboxApi(base);
    const headers: Record<string, string> = credentials.key
      ? { "open-sandbox-api-key": credentials.key }
      : {};
    const answer = await call(fetch, `${api}/sandboxes?pageSize=1`, { headers });
    const where = `OpenSandbox at ${shown(base)}`;
    if ("status" in answer && answer.status === 200) {
      return connected(
        credentials.key
          ? `${where} accepts the key in ${credentials.keyEnv}.`
          : `${where} answers without a key. Keep it bound to this machine, or set ${RUNTIME_KEYS.opensandbox.keyEnv}.`,
      );
    }
    if ("status" in answer && refusedKey(answer.status)) {
      return failed(
        credentials.key
          ? `${where} refused the key in ${credentials.keyEnv} (${answer.status}). It must hold ${RUNTIME_KEYS.opensandbox.what}.`
          : `${where} wants a key (${answer.status}). Set ${credentials.keyEnv} to ${RUNTIME_KEYS.opensandbox.what}.`,
      );
    }
    return unexpected(answer, "OpenSandbox", base, "Check url points at the OpenSandbox server.");
  },
};
