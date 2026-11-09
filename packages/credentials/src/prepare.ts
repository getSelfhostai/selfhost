import { type GatewayClient, type IssuedKey, issueKey, keySettings } from "@selfhost/gateway";
import type { GitHubApp, TokenPermissions } from "@selfhost/github";
import type { EgressPolicy, RuntimeCapabilities, SandboxSpec, SecretRef } from "@selfhost/runtime";
import {
  type CredentialIssuedData,
  egressPolicyOf,
  hostAllowed,
  hostOfUrl,
  type LedgerEvent,
  LOCATION_ENV,
  type RedactionSettings,
  type ResolvedSelfhostConfig,
  type RevokeReason,
  type SecretLiteral,
} from "@selfhost/schema";
import { credentialIssuedEvent, credentialRevokedEvent, type EventRun } from "./events.js";
import { type Leak, type SecretMasker, scanForLeaks, secretMasker } from "./mask.js";
import {
  declaredSecrets,
  PROVIDER_KEY_NAMES,
  providerKeyGaps,
  refOf,
  resolveSecret,
} from "./secrets.js";
import {
  type CredentialTarget,
  type EnforcementGap,
  egressFor,
  locationOf,
  type NativeEgress,
  type NativeSecrets,
  type SecretPlan,
  secretsFor,
} from "./translate.js";

/** The run credentials are prepared for. */
export interface CredentialRun {
  id: string;
  team: string;
  /** owner/name of the repository the run works on. Its GitHub token reaches only this one. */
  repo?: string;
  /** Where the run executes. */
  target: CredentialTarget;
  /** The runtime adapter's own claims; a false field there wins over the built-in table. */
  capabilities?: Pick<RuntimeCapabilities, "egress" | "secrets">;
}

export interface CredentialDeps {
  /** The server's environment: env: sources and the Vault and Infisical tokens. */
  env: NodeJS.ProcessEnv;
  /** For Vault and Infisical. Default: the global fetch. */
  fetch?: typeof fetch;
  /** The GitHub App, to mint the run's repository token. Without it, no GitHub token. */
  github?: Pick<GitHubApp, "runToken" | "revokeToken">;
  /** The AI gateway: model traffic goes through it on a per-run key, and no provider key enters. */
  gateway?: { client: GatewayClient; baseUrl: string };
  /** Writes ledger events (credential.issued, credential.revoked). Default: none written. */
  record?: (events: LedgerEvent[]) => Promise<void>;
  now?: () => Date;
}

/** One credential the run holds. The value stays in memory, for the sandbox and the masker. */
interface Held {
  name: string;
  value: string;
  ref: SecretRef;
  data: Omit<CredentialIssuedData, "v" | "location">;
  /** Revokes it at run end; absent for values the run only reads (env, Vault, Infisical). */
  revoke?: () => Promise<void>;
  injectFor?: SecretPlan["injectFor"];
  /** The same credential under a second name: no events of its own. */
  alias?: boolean;
}

export interface RevokeReport {
  /** Every revocable credential was revoked, or already was. */
  ok: boolean;
  events: LedgerEvent[];
}

/**
 * What a run gets, for the run orchestrator and the runtime adapter. This is the seam between
 * them and selfhost's credential policy: build the sandbox from `spec()`, give the adapter
 * `resolve` for the values, mask everything the run writes with `masker`, and always call
 * `revoke()` when the run ends, however it ends.
 */
export interface PreparedCredentials {
  /** By reference, for SandboxSpec.secrets. */
  secrets: SecretRef[];
  /** name to value, for the adapter's native secret injection. Never log it. */
  env: Readonly<Record<string, string>>;
  /** For SandboxSpec.egress. Undefined: no limit ([egress] absent, off or observe). */
  egress: EgressPolicy | undefined;
  /** Plain variables for SandboxSpec.env: where the run executes and the gateway's address. */
  plainEnv: Readonly<Record<string, string>>;
  /** The target's own egress and secret config, for the adapter to apply. */
  native: { egress: NativeEgress | undefined; secrets: NativeSecrets };
  /** Rules the target cannot hold as written. */
  gaps: EnforcementGap[];
  /** credential.issued events, already passed to deps.record. */
  events: LedgerEvent[];
  /** The value of one of `secrets`, for an adapter that resolves refs itself. */
  resolve(ref: SecretRef): string;
  /** `base` with the run's secrets, egress and plain variables merged in. */
  spec(base: SandboxSpec): SandboxSpec;
  /** Masks the run's values in text and in ledger events, then the usual secret patterns. */
  masker: SecretMasker;
  /** The ledger's redaction settings with the run's values added. */
  redaction(base?: RedactionSettings): RedactionSettings;
  /** Checks texts for the run's values; run it on the ledger events and logs after the run. */
  scan(texts: readonly string[]): Leak[];
  /** Revokes the GitHub token and the gateway key. Safe to call twice; never throws. */
  revoke(reason?: RevokeReason): Promise<RevokeReport>;
}

/** Hosts every run reaches to clone and push its repository. */
const GITHUB_HOSTS = ["github.com", "api.github.com"];

/** Where each SDK style reaches the gateway, as `selfhost gateway connect` writes it. */
export function gatewayUrls(tool: GatewayClient["tool"], baseUrl: string) {
  const root = baseUrl.replace(/\/+$/, "");
  return tool === "bifrost"
    ? { anthropic: `${root}/anthropic`, openai: `${root}/openai/v1` }
    : { anthropic: root, openai: `${root}/v1` };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Gives a run its credentials and egress policy, from the composed policy for its team and
 * repository:
 *
 * - a GitHub App installation token for the run's repository alone, with the least permissions;
 * - with a gateway, the gateway's address and a per-run virtual key under [budget] run_usd, in
 *   place of any provider key;
 * - every [secrets.env] value, read from env, Vault or Infisical now;
 * - the egress allow list for the team, plus the repository's and the gateway's hosts;
 * - each in the target's own form, with the rules it cannot hold.
 *
 * If anything fails, whatever was already issued is revoked before the error is thrown. Values
 * are held in memory only, and no error carries one.
 */
export async function prepareCredentials(
  run: CredentialRun,
  config: ResolvedSelfhostConfig,
  deps: CredentialDeps,
): Promise<PreparedCredentials> {
  const now = deps.now ?? (() => new Date());
  const location = locationOf(run.target);
  const eventRun: EventRun = {
    id: run.id,
    team: run.team,
    ...(run.repo ? { repo: run.repo } : {}),
  };
  const held: Held[] = [];
  const plainEnv: Record<string, string> = { [LOCATION_ENV]: location };
  let revoked: Promise<RevokeReport> | undefined;

  const revokeAll = (reason: RevokeReason): Promise<RevokeReport> => {
    revoked ??= (async () => {
      const ts = now().toISOString();
      const events: LedgerEvent[] = [];
      let ok = true;
      for (const credential of held) {
        if (!credential.revoke || credential.alias) continue;
        let error: string | undefined;
        try {
          await credential.revoke();
        } catch (failure) {
          ok = false;
          error = masker.text(errorText(failure));
        }
        events.push(
          credentialRevokedEvent(
            eventRun,
            {
              credential: credential.data.credential,
              name: credential.name,
              source: credential.data.source,
              reason,
              ok: error === undefined,
              ...(error !== undefined ? { error } : {}),
              location,
            },
            ts,
          ),
        );
      }
      if (events.length > 0) await deps.record?.(events).catch(() => undefined);
      return { ok, events };
    })();
    return revoked;
  };
  const literals = (): SecretLiteral[] => held.map(({ name, value }) => ({ name, value }));
  const masker = secretMasker(literals);

  try {
    if (run.repo && deps.github) {
      const [owner = "", repo = ""] = run.repo.split("/");
      const permissions = config.secrets?.github_permissions as TokenPermissions | undefined;
      const token = await deps.github.runToken(owner, repo, permissions);
      const github = deps.github;
      const name = githubTokenName(config);
      held.push({
        name,
        value: token.token,
        ref: { name, from: "github-app:repo" },
        data: {
          credential: "github_app_token",
          name,
          source: "github-app",
          repository: token.repository,
          permissions: token.permissions,
          expires_at: token.expiresAt,
        },
        revoke: async () => {
          await github.revokeToken(token.token);
        },
      });
    }

    if (deps.gateway) {
      const { client, baseUrl } = deps.gateway;
      const owner = { kind: "run" as const, team: run.team, run_id: run.id };
      const result = await issueKey(client, owner, config, { rotate: true });
      if (!("issued" in result)) throw new Error("The gateway returned no key for the run");
      const issued: IssuedKey = result.issued;
      const settings = keySettings(owner, config);
      const urls = gatewayUrls(client.tool, baseUrl);
      plainEnv.ANTHROPIC_BASE_URL = urls.anthropic;
      plainEnv.OPENAI_BASE_URL = urls.openai;
      const runBudget = settings.budgets.find((b) => b.period === "run")?.limit_usd;
      for (const name of ["ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"]) {
        held.push({
          name,
          value: issued.value,
          ref: { name, from: "gateway:run" },
          data: {
            credential: "gateway_key",
            name,
            source: "gateway",
            ...(runBudget !== undefined ? { budget_usd: runBudget } : {}),
          },
          ...(name === "ANTHROPIC_AUTH_TOKEN"
            ? {
                revoke: async () => {
                  await client.updateKey(issued.key, { ...settings, active: false });
                },
              }
            : { alias: true }),
        });
      }
    }

    const taken = new Set(held.map((credential) => credential.name));
    for (const secret of declaredSecrets(config)) {
      if (taken.has(secret.name)) continue;
      if (deps.gateway && (PROVIDER_KEY_NAMES as readonly string[]).includes(secret.name)) continue;
      if (secret.source === "github-app" || secret.source === "gateway") continue;
      const value = await resolveSecret(secret, config, deps);
      held.push({
        name: secret.name,
        value,
        ref: refOf(secret),
        data: {
          credential: "secret",
          name: secret.name,
          source: secret.source,
          ...(secret.injectFor ? { injected_for: secret.injectFor.host } : {}),
        },
        ...(secret.injectFor ? { injectFor: secret.injectFor } : {}),
      });
    }
  } catch (error) {
    await revokeAll("aborted");
    throw new Error(`Credentials for run ${run.id}: ${masker.text(errorText(error))}`);
  }

  const plans: SecretPlan[] = held.map(({ name, value, injectFor }) => ({
    name,
    value,
    ...(injectFor ? { injectFor } : {}),
  }));
  const secrets = secretsFor(run.target, plans, run.capabilities);
  const policy = egressPolicyOf(config, run.team);
  const allow =
    policy?.mode === "enforce"
      ? [
          ...new Set([
            ...policy.allow,
            ...(run.repo ? GITHUB_HOSTS : []),
            ...(deps.gateway
              ? [hostOfUrl(deps.gateway.baseUrl)].filter((h) => h !== undefined)
              : []),
          ]),
        ]
      : undefined;
  const egress = egressFor(run.target, allow, run.capabilities);
  // A secret's injection host is not added to the allow list: a repository declaring a secret
  // must not widen the team's egress. It is flagged instead.
  for (const injection of secrets.native.inject) {
    if (allow === undefined || hostAllowed(injection.host, allow)) continue;
    egress.gaps.push({
      target: run.target,
      rule: `secrets.env.${injection.name}`,
      entry: injection.host,
      effect: "stricter",
      message: `The secret is injected for ${injection.host}, which [egress] allow does not let the run reach.`,
    });
  }

  const ts = now().toISOString();
  const events = held
    .filter((credential) => !credential.alias)
    .map((credential) => credentialIssuedEvent(eventRun, { ...credential.data, location }, ts));
  try {
    if (events.length > 0) await deps.record?.(events);
  } catch (error) {
    await revokeAll("aborted");
    throw new Error(`Credentials for run ${run.id}: ${masker.text(errorText(error))}`);
  }

  const env = Object.fromEntries(held.map(({ name, value }) => [name, value]));
  const refs = held.map((credential) => credential.ref);
  const egressPolicy = allow === undefined ? undefined : { allow };
  return {
    secrets: refs,
    env,
    egress: egressPolicy,
    plainEnv,
    native: { egress: egress.native, secrets: secrets.native },
    gaps: [
      ...egress.gaps,
      ...secrets.gaps,
      ...(deps.gateway ? [] : providerKeyGaps(run.target, Object.keys(env))),
    ],
    events,
    resolve(ref) {
      const value = env[ref.name];
      if (value === undefined) throw new Error(`No value for ${ref.name} in run ${run.id}`);
      return value;
    },
    spec(base) {
      return {
        ...base,
        env: { ...base.env, ...plainEnv },
        secrets: [...(base.secrets ?? []).filter((s) => !(s.name in env)), ...refs],
        ...(egressPolicy ? { egress: egressPolicy } : {}),
        labels: { ...base.labels, "selfhost-run": run.id, "selfhost-team": run.team },
      };
    },
    masker,
    redaction: (base) => masker.settings(base),
    scan: (texts) => scanForLeaks(texts, literals()),
    revoke: (reason = "succeeded") => revokeAll(reason),
  };
}

/** The variable the run's GitHub token goes in: a github-app: declaration's name, or GITHUB_TOKEN. */
function githubTokenName(config: Pick<ResolvedSelfhostConfig, "secrets">): string {
  const declared = declaredSecrets(config).find((secret) => secret.source === "github-app");
  return declared?.name ?? "GITHUB_TOKEN";
}

/**
 * Runs `body` with the run's credentials and revokes them when it ends: "succeeded" when it
 * returns, "timed_out" or "killed" when the signal's reason says so, else "failed".
 */
export async function withCredentials<T>(
  run: CredentialRun,
  config: ResolvedSelfhostConfig,
  deps: CredentialDeps,
  body: (credentials: PreparedCredentials) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const credentials = await prepareCredentials(run, config, deps);
  let reason: RevokeReason = "failed";
  try {
    const result = await body(credentials);
    reason = "succeeded";
    return result;
  } catch (error) {
    const cause = signal?.aborted ? String(signal.reason ?? "") : "";
    reason = /time/i.test(cause) ? "timed_out" : signal?.aborted ? "killed" : "failed";
    throw error;
  } finally {
    await credentials.revoke(reason);
  }
}
