import type { Fetch, RuntimeCredentials } from "@selfhost/integrations";
import type { RuntimeProvider } from "@selfhost/schema";
import type { SecretResolver } from "./common.js";

/** What every adapter is built from. Tests pass `load` and `fetch` so nothing leaves the process. */
export interface AdapterOptions<Sdk = never> {
  /** [runtime.providers.<kind>]: url, template, usd_per_hour. */
  settings: RuntimeProvider;
  /** The team's key, read from the environment by runtimeKey. */
  credentials: RuntimeCredentials;
  /** Turns a spec's secret references into values. */
  secrets: SecretResolver;
  now?: () => Date;
  /** Loads the provider SDK. Default: a dynamic import of the optional peer dependency. */
  load?: () => Promise<Sdk>;
  /** For providers driven over HTTP. Default: the global fetch. */
  fetch?: Fetch;
  /** Milliseconds between log polls. Default: LOG_POLL_MS. */
  logPollMs?: number;
}
