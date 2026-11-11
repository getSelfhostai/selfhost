import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ApiToken {
  token: string;
  /** Where the token is kept, or undefined when it came from SELFHOST_TOKEN. */
  path?: string;
  /** true when this call generated the token. */
  created: boolean;
}

/**
 * The bearer token the API accepts: SELFHOST_TOKEN when set, otherwise the token saved in
 * <dataDir>/token, generated with mode 0600 on first start.
 */
export function loadApiToken(dataDir: string, env: NodeJS.ProcessEnv = process.env): ApiToken {
  const fromEnv = env.SELFHOST_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, created: false };
  // An in-memory data dir has nowhere to keep the token, so it lasts for this process only.
  if (dataDir.includes("://")) return { token: generateToken(), created: true };
  const path = join(dataDir, "token");
  if (existsSync(path)) {
    const saved = readFileSync(path, "utf8").trim();
    if (saved) return { token: saved, path, created: false };
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const token = generateToken();
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { token, path, created: true };
}

function generateToken(): string {
  return `selfhost_${randomBytes(32).toString("base64url")}`;
}

/**
 * What the start log says about a token it just made: where it is and how to read it, never the
 * token itself, since logs are kept and shipped where the admin token must not go.
 */
export function tokenNotice(path: string | undefined): string {
  if (path === undefined) {
    return "API token made for this process only (the data dir is in memory) and not printed. Set SELFHOST_TOKEN to choose one you can use.";
  }
  return `API token made and saved to ${path} (mode 0600). Read it on this machine with: cat ${path}`;
}
