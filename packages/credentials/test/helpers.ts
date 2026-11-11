import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bifrostClient } from "@selfhost/gateway";
import { fakeBifrost } from "@selfhost/gateway/testing";
import { createGitHubApp } from "@selfhost/github";
import { FakeGitHub } from "@selfhost/github/testing";
import { parseConfig, type ResolvedSelfhostConfig } from "@selfhost/schema";

export const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");

export function policy(text: string): ResolvedSelfhostConfig {
  const parsed = parseConfig(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
}

export const POLICY = policy(readFileSync(join(FIXTURES, "credentials", "selfhost.toml"), "utf8"));

/** Fake values, built at run time so the repository holds no secret-shaped string. */
export const VALUES = {
  sentry: ["fake", "sentry", "dsn", "0001"].join("-"),
  database: ["postgres://ci:fake", "db", "pass@db.acme.test/app"].join("-"),
  stripe: ["fake", "stripe", "key", "0042"].join("_"),
  vaultToken: ["fake", "vault", "token"].join("-"),
  infisicalToken: ["fake", "infisical", "token"].join("-"),
  anthropic: ["fake", "provider", "key", "9999"].join("-"),
};

/**
 * The server's environment: team platform's run secret, a shared one platform and t may read,
 * and where the stores are, with their tokens.
 */
export const SERVER_ENV: NodeJS.ProcessEnv = {
  SELFHOST_RUN_SECRET_PLATFORM__SENTRY_DSN: VALUES.sentry,
  SELFHOST_RUN_SECRET_SHARED__ANTHROPIC_API_KEY: VALUES.anthropic,
  SELFHOST_RUN_SECRET_SHARED_TEAMS: "platform, t",
  VAULT_ADDR: "https://vault.acme.test:8200",
  VAULT_NAMESPACE: "eng",
  VAULT_TOKEN: VALUES.vaultToken,
  INFISICAL_URL: "https://infisical.acme.test",
  INFISICAL_PROJECT_ID: "proj-acme",
  INFISICAL_ENVIRONMENT: "ci",
  INFISICAL_TOKEN: VALUES.infisicalToken,
};

export interface StoreCall {
  url: string;
  headers: Record<string, string>;
}

/** Vault KV v2 and Infisical v4 answering the fixture's references, and nothing else. */
export function fakeStores(options: { failVault?: number } = {}) {
  const calls: StoreCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers));
    calls.push({ url, headers });
    const { hostname, pathname, searchParams } = new URL(url);
    if (hostname === "vault.acme.test") {
      if (options.failVault) return new Response("{}", { status: options.failVault });
      if (headers["x-vault-token"] !== VALUES.vaultToken) {
        return new Response('{"errors":["permission denied"]}', { status: 403 });
      }
      if (pathname === "/v1/secret/data/selfhost/platform/acme-api/ci") {
        return Response.json({ data: { data: { database_url: VALUES.database } } });
      }
      return new Response('{"errors":[]}', { status: 404 });
    }
    if (hostname === "infisical.acme.test") {
      if (headers.authorization !== `Bearer ${VALUES.infisicalToken}`) {
        return new Response("{}", { status: 401 });
      }
      if (
        pathname === "/api/v4/secrets/STRIPE_KEY" &&
        searchParams.get("projectId") === "proj-acme" &&
        searchParams.get("environment") === "ci" &&
        searchParams.get("secretPath") === "/selfhost/platform/payments"
      ) {
        return Response.json({ secret: { secretKey: "STRIPE_KEY", secretValue: VALUES.stripe } });
      }
      return new Response("{}", { status: 404 });
    }
    throw new Error(`unexpected request to ${hostname}`);
  };
  return { fetch, calls };
}

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** The real GitHub App client over the in-memory GitHub. */
export function github() {
  const fake = new FakeGitHub({
    appId: "123",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    installationOf: (repo) => (repo.startsWith("acme/") ? 42 : undefined),
    repositoriesOf: () => ["acme-api", "acme-web"],
  });
  const app = createGitHubApp(
    {
      appId: "123",
      privateKey: keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      webhookSecret: "unused",
    },
    { fetch: fake.fetch, log: () => {} },
  );
  return { fake, app };
}

export function gateway() {
  const fake = fakeBifrost();
  const client = bifrostClient({
    url: "http://bifrost:8080",
    username: "selfhost",
    password: fake.password,
    fetch: fake.fetch,
    minIntervalMs: 0,
  });
  return { fake, client, baseUrl: "https://selfhost.acme.test/llm" };
}
