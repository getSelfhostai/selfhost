import { connected, failed, isCheck, secret } from "../http.js";
import { RUNTIME_KEYS } from "../runtime-keys.js";
import type { Adapter } from "../types.js";

/**
 * Modal has no HTTP API to test a token: its clients speak gRPC. So the check is that both halves
 * are set and shaped like a token (ak- and as-), and says how to test it for real.
 */
export const modal: Adapter<"runtime"> = {
  kind: "runtime",
  tool: "modal",
  describe: () => ({
    kind: "runtime",
    tool: "modal",
    name: "Modal",
    check:
      "The token id (ak-) and secret (as-) are set and well formed; Modal has no HTTP call to test them.",
    docs: "https://modal.com/docs/cli/latest/token",
  }),
  async check(settings, env) {
    const idEnv = settings.api_key_env ?? RUNTIME_KEYS.modal.keyEnv;
    const secretEnv = settings.api_secret_env ?? RUNTIME_KEYS.modal.secretEnv ?? "";
    const id = secret(env, idEnv, RUNTIME_KEYS.modal.what, "api_key_env");
    if (isCheck(id)) return id;
    const value = secret(env, secretEnv, RUNTIME_KEYS.modal.secretWhat ?? "", "api_secret_env");
    if (isCheck(value)) return value;
    if (!id.startsWith("ak-")) {
      return failed(`${idEnv} does not hold a Modal token id, which starts with ak-.`);
    }
    if (!value.startsWith("as-")) {
      return failed(`${secretEnv} does not hold a Modal token secret, which starts with as-.`);
    }
    return connected(
      `${idEnv} and ${secretEnv} hold a Modal token. Modal has no HTTP API to test it; modal token info tests it from a terminal.`,
    );
  },
};
