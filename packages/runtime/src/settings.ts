import {
  type Env,
  isCheck,
  missingUrl,
  RUNTIME_KEYS,
  type RuntimeCredentials,
  runtimeCredentials,
} from "@selfhost/integrations";
import type { RuntimeProvider, SelfhostConfig } from "@selfhost/schema";
import type { RuntimeKind } from "./types.js";

/** The parts of selfhost.toml the runtime reads. */
export type RuntimeConfig = Pick<SelfhostConfig, "runtime" | "integrations" | "budget">;

/**
 * How to reach one runtime: [runtime.providers.<kind>], else nothing (the defaults). A config
 * that did not go through parseConfig may still carry the deprecated [integrations.runtime],
 * which is read the same way when it names this runtime.
 */
export function providerSettings(config: RuntimeConfig, kind: RuntimeKind): RuntimeProvider {
  const own = config.runtime?.providers?.[kind];
  if (own) return own;
  const integration = config.integrations?.runtime;
  if (integration?.tool === kind) {
    const { tool: _tool, ...rest } = integration;
    return rest;
  }
  return {};
}

/** A runtime that cannot start a sandbox: no key, or no url for the team's own server. */
export class RuntimeKeyError extends Error {
  constructor(
    readonly kind: RuntimeKind,
    detail: string,
  ) {
    super(
      `${detail} selfhost runs ${kind} sandboxes only on the team's own key, so this run does not start until one is added.`,
    );
    this.name = "RuntimeKeyError";
  }
}

/**
 * The team's key for a runtime, read from the environment variable its settings name. Throws a
 * RuntimeKeyError that says which variable to set. The key is never written anywhere.
 */
export function runtimeKey(
  kind: RuntimeKind,
  settings: RuntimeProvider,
  env: Env,
): RuntimeCredentials {
  if (!settings.url) {
    const missing = missingUrl(kind);
    if (missing) throw new RuntimeKeyError(kind, missing.detail);
  }
  const found = runtimeCredentials(kind, settings, env);
  if (isCheck(found)) throw new RuntimeKeyError(kind, found.detail);
  return found;
}

/**
 * Whether a runtime's key is there: set, not needed (an OpenSandbox server on this machine with
 * a local url and no key variable set), or not set.
 */
export function keyState(
  kind: RuntimeKind,
  settings: RuntimeProvider,
  env: Env,
): "set" | "not_needed" | "not_set" {
  try {
    return runtimeKey(kind, settings, env).key === "" ? "not_needed" : "set";
  } catch {
    return "not_set";
  }
}

/** Whether a runtime has what it needs to start a sandbox, without saying what is missing. */
export function hasKey(kind: RuntimeKind, settings: RuntimeProvider, env: Env): boolean {
  try {
    runtimeKey(kind, settings, env);
    return true;
  } catch {
    return false;
  }
}

/** The environment variables a runtime's key is read from, for messages and `runtime list`. */
export function keyEnvs(kind: RuntimeKind, settings: RuntimeProvider): string[] {
  const spec = RUNTIME_KEYS[kind];
  const key = settings.api_key_env ?? spec.keyEnv;
  const secret = spec.secretEnv ? (settings.api_secret_env ?? spec.secretEnv) : undefined;
  return secret ? [key, secret] : [key];
}
