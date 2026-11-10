import type { RuntimeTool } from "@selfhost/schema";
import { failed, isCheck, secret } from "./http.js";
import type { CheckResult, Env, Settings } from "./types.js";

/** Where each runtime's key lives by default, and what it is, for messages. */
export const RUNTIME_KEYS: Readonly<
  Record<RuntimeTool, { keyEnv: string; what: string; secretEnv?: string; secretWhat?: string }>
> = {
  e2b: { keyEnv: "E2B_API_KEY", what: "an E2B API key" },
  daytona: { keyEnv: "DAYTONA_API_KEY", what: "a Daytona API key" },
  modal: {
    keyEnv: "MODAL_TOKEN_ID",
    what: "a Modal token id (ak-...)",
    secretEnv: "MODAL_TOKEN_SECRET",
    secretWhat: "a Modal token secret (as-...)",
  },
  coder: {
    keyEnv: "CODER_SESSION_TOKEN",
    what: "a Coder session or API token (coder tokens create)",
  },
  opensandbox: { keyEnv: "OPEN_SANDBOX_API_KEY", what: "the OpenSandbox server's API key" },
};

/** A runtime's key, read from the environment where selfhost runs. Never stored or shown. */
export interface RuntimeCredentials {
  /** Empty for an OpenSandbox server on this machine that runs without a key. */
  key: string;
  /** The second half of a two-part key: Modal's token secret. */
  secret?: string;
  keyEnv: string;
  secretEnv?: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Whether a URL points at this machine. */
export function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return LOOPBACK.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * The key for one runtime from its settings ([runtime.providers.<name>])
 * and the environment, or an error that names the variable to set. An OpenSandbox server on
 * localhost may run without a key; every other runtime needs one, so selfhost never starts a
 * sandbox on a key it owns.
 */
export function runtimeCredentials(
  tool: RuntimeTool,
  settings: Settings<"runtime">,
  env: Env,
): RuntimeCredentials | CheckResult {
  const spec = RUNTIME_KEYS[tool];
  const keyEnv = settings.api_key_env ?? spec.keyEnv;
  if (tool === "opensandbox" && !env[keyEnv]?.trim() && isLoopbackUrl(settings.url)) {
    return { key: "", keyEnv };
  }
  const key = secret(env, keyEnv, spec.what, "api_key_env");
  if (isCheck(key)) return key;
  if (!spec.secretEnv) return { key, keyEnv };
  const secretEnv = settings.api_secret_env ?? spec.secretEnv;
  const value = secret(env, secretEnv, spec.secretWhat ?? spec.what, "api_secret_env");
  if (isCheck(value)) return value;
  return { key, secret: value, keyEnv, secretEnv };
}

/** The error runtimeCredentials gives for a runtime that needs a url and has none. */
export function missingUrl(tool: RuntimeTool): CheckResult | undefined {
  if (tool === "coder") {
    return failed(
      "Set url to your Coder deployment's access URL, such as https://coder.example.com.",
    );
  }
  if (tool === "opensandbox") {
    return failed(
      "Set url to your OpenSandbox server, such as http://localhost:8080 for one running on this machine.",
    );
  }
  return undefined;
}
