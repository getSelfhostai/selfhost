import type { SecretRef } from "@selfhost/runtime";
import {
  type CredentialSource,
  type ResolvedSelfhostConfig,
  RUN_SECRET_ENV_PREFIX,
} from "@selfhost/schema";
import type { CredentialTarget, EnforcementGap, SecretPlan } from "./translate.js";

/** A secret declared in [secrets.env], parsed. */
export interface DeclaredSecret {
  name: string;
  from: string;
  source: CredentialSource;
  injectFor?: SecretPlan["injectFor"];
}

const DEFAULT_HEADER = "Authorization";
const DEFAULT_FORMAT = "Bearer {value}";

export const DEFAULT_VAULT_MOUNT = "secret";
export const DEFAULT_INFISICAL_URL = "https://app.infisical.com";

/** HashiCorp Vault as the server reaches it. */
export interface VaultSettings {
  url: string;
  token: string;
  mount: string;
  namespace?: string;
}

/** Infisical as the server reaches it. */
export interface InfisicalSettings {
  url: string;
  token: string;
  projectId: string;
  environment: string;
}

/**
 * The secret stores, from the server's own environment only. A team's or a repository's policy
 * names paths in them and never their address or token, so it cannot send the server's token,
 * or any other server variable, to a host of its choosing.
 */
export interface SecretStores {
  vault?: VaultSettings;
  infisical?: InfisicalSettings;
}

const read = (env: NodeJS.ProcessEnv, name: string) => env[name]?.trim() || undefined;

/**
 * Vault from VAULT_ADDR, VAULT_TOKEN, VAULT_NAMESPACE and SELFHOST_VAULT_MOUNT; Infisical from
 * INFISICAL_URL, INFISICAL_TOKEN, INFISICAL_PROJECT_ID and INFISICAL_ENVIRONMENT. A store with
 * no address (Vault) or no project (Infisical) is not set up.
 */
export function storesFromEnv(env: NodeJS.ProcessEnv): SecretStores {
  const vaultUrl = read(env, "VAULT_ADDR");
  const vaultToken = read(env, "VAULT_TOKEN");
  const namespace = read(env, "VAULT_NAMESPACE");
  const projectId = read(env, "INFISICAL_PROJECT_ID");
  const environment = read(env, "INFISICAL_ENVIRONMENT");
  const infisicalToken = read(env, "INFISICAL_TOKEN");
  return {
    ...(vaultUrl
      ? {
          vault: {
            url: vaultUrl,
            token: vaultToken ?? "",
            mount: read(env, "SELFHOST_VAULT_MOUNT") ?? DEFAULT_VAULT_MOUNT,
            ...(namespace ? { namespace } : {}),
          },
        }
      : {}),
    ...(projectId && environment
      ? {
          infisical: {
            url: read(env, "INFISICAL_URL") ?? DEFAULT_INFISICAL_URL,
            token: infisicalToken ?? "",
            projectId,
            environment,
          },
        }
      : {}),
  };
}

export function sourceOf(from: string): CredentialSource {
  const scheme = from.slice(0, from.indexOf(":"));
  if (scheme === "vault" || scheme === "infisical" || scheme === "env") return scheme;
  if (scheme === "gateway") return "gateway";
  return "github-app";
}

/** The [secrets.env] declarations of a config, in name order. */
export function declaredSecrets(config: Pick<ResolvedSelfhostConfig, "secrets">): DeclaredSecret[] {
  return Object.entries(config.secrets?.env ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, declared]) => {
      if (typeof declared === "string") return { name, from: declared, source: sourceOf(declared) };
      return {
        name,
        from: declared.from,
        source: sourceOf(declared.from),
        ...(declared.host
          ? {
              injectFor: {
                host: declared.host,
                header: declared.header ?? DEFAULT_HEADER,
                format: declared.format ?? DEFAULT_FORMAT,
              },
            }
          : {}),
      };
    });
}

export const refOf = (secret: Pick<DeclaredSecret, "name" | "from">): SecretRef => ({
  name: secret.name,
  from: secret.from,
});

/** Why a value could not be read. Names the reference and the store, never a value or token. */
export class SecretResolveError extends Error {
  override name = "SecretResolveError";
}

export interface ResolveDeps {
  /** The server's environment: env: sources (SELFHOST_RUN_SECRET_* only) and, by default, the stores. */
  env: NodeJS.ProcessEnv;
  /** Default: storesFromEnv(env). */
  stores?: SecretStores;
  fetch?: typeof fetch;
}

/** `path#key`, or `key` alone (Infisical's root folder). */
function splitRef(ref: string): { path: string; key: string } {
  const hash = ref.lastIndexOf("#");
  return hash === -1
    ? { path: "/", key: ref }
    : { path: ref.slice(0, hash), key: ref.slice(hash + 1) };
}

function storeToken(token: string, name: string, store: string): string {
  if (!token) throw new SecretResolveError(`${store}: ${name} is not set on the server`);
  return token;
}

async function getJson(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  what: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { headers });
  } catch (error) {
    throw new SecretResolveError(`${what}: no answer (${(error as Error).message})`);
  }
  if (!response.ok) throw new SecretResolveError(`${what}: HTTP ${response.status}`);
  return response.json();
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

/** A value from HashiCorp Vault's KV version 2 engine: GET /v1/<mount>/data/<path>. */
async function fromVault(ref: string, settings: VaultSettings, deps: ResolveDeps): Promise<string> {
  const { path, key } = splitRef(ref);
  const what = `vault:${ref}`;
  const token = storeToken(settings.token, "VAULT_TOKEN", "Vault");
  const mount = settings.mount.replace(/^\/+|\/+$/g, "");
  const url = `${trimSlash(settings.url)}/v1/${mount}/data/${path.replace(/^\/+/, "")}`;
  const body = (await getJson(
    deps.fetch ?? fetch,
    url,
    {
      "X-Vault-Token": token,
      ...(settings.namespace ? { "X-Vault-Namespace": settings.namespace } : {}),
    },
    what,
  )) as { data?: { data?: Record<string, unknown> } };
  const value = body.data?.data?.[key];
  if (typeof value !== "string") throw new SecretResolveError(`${what}: no string at key ${key}`);
  return value;
}

/** A value from Infisical: GET /api/v4/secrets/<name>?projectId&environment&secretPath. */
async function fromInfisical(
  ref: string,
  settings: InfisicalSettings,
  deps: ResolveDeps,
): Promise<string> {
  const { path, key } = splitRef(ref);
  const what = `infisical:${ref}`;
  const token = storeToken(settings.token, "INFISICAL_TOKEN", "Infisical");
  const query = new URLSearchParams({
    projectId: settings.projectId,
    environment: settings.environment,
    secretPath: path.startsWith("/") ? path : `/${path}`,
  });
  const url = `${trimSlash(settings.url)}/api/v4/secrets/${encodeURIComponent(key)}?${query}`;
  const body = (await getJson(
    deps.fetch ?? fetch,
    url,
    { Authorization: `Bearer ${token}` },
    what,
  )) as { secret?: { secretValue?: unknown } };
  const value = body.secret?.secretValue;
  if (typeof value !== "string") throw new SecretResolveError(`${what}: no secret value`);
  return value;
}

/**
 * Reads one declared secret's value from the server's environment (SELFHOST_RUN_SECRET_*
 * only), Vault or Infisical, each as the server is set up to reach it. github-app: and gateway:
 * values are issued per run, not read, so they are not resolved here.
 */
export async function resolveSecret(
  secret: Pick<DeclaredSecret, "from">,
  deps: ResolveDeps,
): Promise<string> {
  const colon = secret.from.indexOf(":");
  const scheme = secret.from.slice(0, colon);
  const ref = secret.from.slice(colon + 1);
  switch (scheme) {
    case "env": {
      // Checked here too: a config that did not go through parseConfig never saw the schema.
      if (!ref.startsWith(RUN_SECRET_ENV_PREFIX)) {
        throw new SecretResolveError(
          `env:${ref}: env: secrets read only server variables named ${RUN_SECRET_ENV_PREFIX}*`,
        );
      }
      const value = deps.env[ref];
      if (value === undefined || value === "") {
        throw new SecretResolveError(`env:${ref}: not set on the server`);
      }
      return value;
    }
    case "vault": {
      const settings = (deps.stores ?? storesFromEnv(deps.env)).vault;
      if (!settings)
        throw new SecretResolveError(`vault:${ref}: VAULT_ADDR is not set on the server`);
      return fromVault(ref, settings, deps);
    }
    case "infisical": {
      const settings = (deps.stores ?? storesFromEnv(deps.env)).infisical;
      if (!settings) {
        throw new SecretResolveError(
          `infisical:${ref}: INFISICAL_PROJECT_ID and INFISICAL_ENVIRONMENT are not set on the server`,
        );
      }
      return fromInfisical(ref, settings, deps);
    }
    default:
      throw new SecretResolveError(`${secret.from}: issued per run, not read from a store`);
  }
}

/** Provider key variables a gateway run never gets: model traffic goes through the gateway. */
export const PROVIDER_KEY_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const;

/**
 * A provider key in a run without the gateway: it reaches the sandbox as is and lives past the
 * run, since selfhost cannot revoke a provider's key.
 */
export function providerKeyGaps(
  target: CredentialTarget,
  names: readonly string[],
): EnforcementGap[] {
  return names
    .filter((name) => (PROVIDER_KEY_NAMES as readonly string[]).includes(name))
    .map((name) => ({
      target,
      rule: `secrets.env.${name}`,
      entry: name,
      effect: "weaker" as const,
      message:
        "A provider key enters the sandbox and outlives the run. Set [integrations.router] so each run gets a gateway key that is revoked when it ends.",
    }));
}
