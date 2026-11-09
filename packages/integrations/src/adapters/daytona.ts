import { RUNTIME_KEYS } from "../runtime-keys.js";
import type { Adapter } from "../types.js";
import { keyedCheck } from "./keyed.js";

export const DAYTONA_API_URL = "https://app.daytona.io/api";

/** GET /api-keys/current with a Bearer key: the key's own details, nothing started. */
export const daytona: Adapter<"runtime"> = {
  kind: "runtime",
  tool: "daytona",
  describe: () => ({
    kind: "runtime",
    tool: "daytona",
    name: "Daytona",
    check: "GET /api-keys/current with a Bearer API key.",
    docs: "https://www.daytona.io/docs/en/tools/api",
  }),
  check: (settings, env, fetch) =>
    keyedCheck(
      {
        name: "Daytona",
        url: settings.url ?? DAYTONA_API_URL,
        path: "/api-keys/current",
        keyEnv: settings.api_key_env ?? RUNTIME_KEYS.daytona.keyEnv,
        header: (key) => ["authorization", `Bearer ${key}`],
        what: RUNTIME_KEYS.daytona.what,
      },
      env,
      fetch,
    ),
};
