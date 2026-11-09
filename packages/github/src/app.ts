import { readFileSync } from "node:fs";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { Webhooks } from "@octokit/webhooks";

export interface GitHubAppCredentials {
  /** The App's id (or client id), from its settings page. */
  appId: string;
  /** PEM private key, PKCS#1 as GitHub downloads it or PKCS#8. */
  privateKey: string;
  /** The webhook secret set on the App. */
  webhookSecret: string;
}

/** Environment variables the App credentials come from. */
export const GITHUB_APP_ENV = {
  appId: "SELFHOST_GITHUB_APP_ID",
  privateKey: "SELFHOST_GITHUB_PRIVATE_KEY",
  privateKeyFile: "SELFHOST_GITHUB_PRIVATE_KEY_FILE",
  webhookSecret: "SELFHOST_GITHUB_WEBHOOK_SECRET",
} as const;

export type GitHubAppEnv =
  | { credentials: GitHubAppCredentials; missing: [] }
  | { credentials?: undefined; missing: string[] };

/**
 * The App credentials from the environment: `SELFHOST_GITHUB_APP_ID`,
 * `SELFHOST_GITHUB_PRIVATE_KEY` (or `SELFHOST_GITHUB_PRIVATE_KEY_FILE`, a path to the .pem) and
 * `SELFHOST_GITHUB_WEBHOOK_SECRET`. A key with `\n` escapes on one line is accepted. `missing`
 * names what is unset; the values are never part of an error.
 */
export function githubAppEnv(env: NodeJS.ProcessEnv = process.env): GitHubAppEnv {
  const appId = env[GITHUB_APP_ENV.appId]?.trim();
  const webhookSecret = env[GITHUB_APP_ENV.webhookSecret];
  let privateKey = env[GITHUB_APP_ENV.privateKey]?.trim();
  const keyFile = env[GITHUB_APP_ENV.privateKeyFile]?.trim();
  if (!privateKey && keyFile) {
    try {
      privateKey = readFileSync(keyFile, "utf8").trim();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
      throw new Error(`${GITHUB_APP_ENV.privateKeyFile}: cannot read ${keyFile} (${code})`);
    }
  }
  if (privateKey && !privateKey.includes("\n")) privateKey = privateKey.replaceAll("\\n", "\n");

  const missing = [
    ...(appId ? [] : [GITHUB_APP_ENV.appId]),
    ...(privateKey ? [] : [`${GITHUB_APP_ENV.privateKey} or ${GITHUB_APP_ENV.privateKeyFile}`]),
    ...(webhookSecret ? [] : [GITHUB_APP_ENV.webhookSecret]),
  ];
  if (!appId || !privateKey || !webhookSecret) return { missing };
  return { credentials: { appId, privateKey, webhookSecret }, missing: [] };
}

export interface GitHubAppOptions {
  /** Used for every GitHub API call, installation tokens included. Default: the global fetch. */
  fetch?: typeof fetch;
  /** Octokit warnings and errors, one line each, never tokens or bodies. Default: console.warn. */
  log?: (line: string) => void;
}

/** Permissions a run's token asks for, by GitHub's permission names. */
export type TokenPermissions = Readonly<Record<string, "read" | "write">>;

/**
 * What a background run needs on its repository: push a branch, open a pull request, read the
 * repository's metadata. Nothing on any other repository.
 */
export const RUN_TOKEN_PERMISSIONS: TokenPermissions = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
};

/** An installation token limited to one repository. */
export interface RunToken {
  /** Goes into the run's sandbox only; never logged or stored. */
  token: string;
  expiresAt: string;
  installationId: number;
  /** owner/name. */
  repository: string;
  /** What GitHub granted, which can be less than what was asked. */
  permissions: Record<string, string>;
}

export interface GitHubApp {
  /** true when `signature` (X-Hub-Signature-256) signs `body` with the App's webhook secret. */
  verify(body: string, signature: string | undefined): Promise<boolean>;
  /**
   * An Octokit acting as one installation of the App. One per installation is kept, so its token
   * is fetched once and renewed by @octokit/auth-app before it expires.
   */
  installation(id: number): Octokit;
  /** The App's installation on owner/repo, or undefined when it is not installed there. */
  repoInstallation(owner: string, repo: string): Promise<number | undefined>;
  /**
   * A new installation token for owner/repo alone, with `permissions` (default
   * RUN_TOKEN_PERMISSIONS): GitHub refuses it on every other repository of the installation.
   * Throws when the App is not installed on the repository.
   */
  runToken(owner: string, repo: string, permissions?: TokenPermissions): Promise<RunToken>;
  /**
   * Revokes an installation token (DELETE /installation/token). "already" when GitHub no longer
   * accepts it: revoked before, or expired.
   */
  revokeToken(token: string): Promise<"revoked" | "already">;
}

/** The GitHub App: webhook signatures through @octokit/webhooks, API calls through Octokit. */
export function createGitHubApp(
  credentials: GitHubAppCredentials,
  options: GitHubAppOptions = {},
): GitHubApp {
  const webhooks = new Webhooks({ secret: credentials.webhookSecret });
  const write = options.log ?? ((line: string) => console.warn(line));
  const log = {
    debug: () => {},
    info: () => {},
    warn: (message: string) => write(`github: ${message}`),
    error: (message: string) => write(`github: ${message}`),
  };
  const installations = new Map<number, Octokit>();
  const request = options.fetch ? { request: { fetch: options.fetch } } : {};
  let asApp: Octokit | undefined;

  const app = () =>
    (asApp ??= new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: credentials.appId, privateKey: credentials.privateKey },
      log,
      ...request,
    }));

  return {
    async verify(body, signature) {
      if (!body || !signature) return false;
      try {
        return await webhooks.verify(body, signature);
      } catch {
        return false;
      }
    },
    installation(id) {
      let octokit = installations.get(id);
      if (!octokit) {
        octokit = new Octokit({
          authStrategy: createAppAuth,
          auth: {
            appId: credentials.appId,
            privateKey: credentials.privateKey,
            installationId: id,
          },
          log,
          ...request,
        });
        installations.set(id, octokit);
      }
      return octokit;
    },
    async repoInstallation(owner, repo) {
      try {
        const { data } = await app().rest.apps.getRepoInstallation({ owner, repo });
        return data.id;
      } catch (error) {
        if ((error as { status?: number }).status === 404) return undefined;
        throw error;
      }
    },
    async runToken(owner, repo, permissions = RUN_TOKEN_PERMISSIONS) {
      const installationId = await this.repoInstallation(owner, repo);
      if (installationId === undefined) {
        throw new Error(`The GitHub App is not installed on ${owner}/${repo}`);
      }
      const { data } = await app().rest.apps.createInstallationAccessToken({
        installation_id: installationId,
        repositories: [repo],
        permissions: { ...permissions },
      });
      return {
        token: data.token,
        expiresAt: data.expires_at,
        installationId,
        repository: `${owner}/${repo}`,
        permissions: { ...(data.permissions as Record<string, string> | undefined) },
      };
    },
    async revokeToken(token) {
      const asToken = new Octokit({ auth: token, log, ...request });
      try {
        await asToken.rest.apps.revokeInstallationAccessToken();
        return "revoked";
      } catch (error) {
        if ((error as { status?: number }).status === 401) return "already";
        throw error;
      }
    },
  };
}
