import type { Env, Fetch } from "@selfhost/integrations";
import { coderRuntime } from "./adapters/coder.js";
import { envSecrets, type SecretResolver } from "./adapters/common.js";
import { daytonaRuntime } from "./adapters/daytona.js";
import { e2bRuntime } from "./adapters/e2b.js";
import { modalRuntime } from "./adapters/modal.js";
import { openSandboxRuntime } from "./adapters/opensandbox.js";
import { providerSettings, type RuntimeConfig, runtimeKey } from "./settings.js";
import type { RuntimeAdapter, RuntimeKind } from "./types.js";

export interface OpenRuntimeOptions {
  /** Where keys and env: secrets are read from: the server's environment, or the laptop's. */
  env: Env;
  /** Resolves secret references other than env:. Default: env: only. */
  secrets?: SecretResolver;
  fetch?: Fetch;
  now?: () => Date;
}

/**
 * The adapter for one runtime, with the team's key from the environment. Throws a
 * RuntimeKeyError naming the variable to set when there is no key: a run never starts on a key
 * selfhost owns. The provider SDK is loaded on first use, so a missing optional dependency only
 * matters for the runtime that needs it.
 */
export function openRuntime(
  kind: RuntimeKind,
  config: RuntimeConfig,
  options: OpenRuntimeOptions,
): RuntimeAdapter {
  const settings = providerSettings(config, kind);
  const credentials = runtimeKey(kind, settings, options.env);
  const common = {
    settings,
    credentials,
    secrets: options.secrets ?? envSecrets(options.env),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  switch (kind) {
    case "e2b":
      return e2bRuntime(common);
    case "daytona":
      return daytonaRuntime(common);
    case "modal":
      return modalRuntime(common);
    case "coder":
      return coderRuntime(common);
    case "opensandbox":
      return openSandboxRuntime(common);
  }
}
