import type { Adapter } from "../types.js";
import { keyedCheck } from "./keyed.js";

export const E2B_API_URL = "https://api.e2b.app";

/** GET /v2/sandboxes?limit=1 with the X-API-Key header: lists running sandboxes, starts none. */
export const e2b: Adapter<"runtime"> = {
  kind: "runtime",
  tool: "e2b",
  describe: () => ({
    kind: "runtime",
    tool: "e2b",
    name: "E2B",
    check: "GET /v2/sandboxes?limit=1 with the X-API-Key header.",
    docs: "https://docs.e2b.dev/api-reference/sandboxes/list-sandboxes-v2",
  }),
  check: (settings, env, fetch) =>
    keyedCheck(
      {
        name: "E2B",
        url: settings.url ?? E2B_API_URL,
        path: "/v2/sandboxes?limit=1",
        keyEnv: settings.api_key_env ?? "E2B_API_KEY",
        header: (key) => ["x-api-key", key],
        what: "an E2B API key",
      },
      env,
      fetch,
    ),
};
