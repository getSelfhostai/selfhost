import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which keys this laptop trusts to sign one-time exception grants, and so whether it is in team
 * mode for exceptions.
 *
 * - Managed settings installed (root-owned, written by an admin command from selfhost join, sync
 *   or `selfhost policy compile --managed`): the team server's url and public keys are pinned in
 *   the trust file below. An agent running as the person cannot change it, so only grants the
 *   server signed are accepted, whatever ~/.selfhost/config.json says.
 * - Otherwise, a team membership in ~/.selfhost/config.json: the keys pinned there at join and
 *   on each sync. Only server-signed grants are accepted, but an agent running as the person can
 *   rewrite that file, so selfhost doctor warns that the pin holds only as long as the file does.
 * - Neither: solo mode. Grants are signed with the local key in ~/.selfhost/exceptions/key,
 *   which holds against agents that follow the rules, not against one set on forging a grant.
 */

export const TRUST_SCHEMA = "selfhost.exception_trust/v1";

/** Where the root-owned trust file goes on each platform, next to no vendor's files. */
export const TRUST_PATHS: Readonly<Record<"darwin" | "linux" | "win32", string>> = {
  darwin: "/Library/Application Support/selfhost/exception-trust.json",
  linux: "/etc/selfhost/exception-trust.json",
  win32: "C:\\Program Files\\selfhost\\exception-trust.json",
};

/** A public key the team server signs grants with, as GET /v1/exception-keys lists it. */
export interface TrustedKey {
  id: string;
  /** Raw 32-byte Ed25519 public key, base64url. */
  public_key: string;
}

/** The trust file, and the `exception_keys` entry of config.json. */
export interface TrustFile {
  schema: typeof TRUST_SCHEMA;
  server: string;
  keys: TrustedKey[];
}

export interface ExceptionTrust {
  /** team: only grants the team server signed are accepted. solo: the local key signs them. */
  mode: "team" | "solo";
  /** Where the keys come from: the root-owned file, config.json, or nowhere yet. */
  source: "managed" | "config" | "none";
  keys: TrustedKey[];
  server?: string;
  /** The trust file or config.json the keys were read from. */
  path?: string;
  /** The team membership's person in config.json, when there is one. */
  person?: string;
}

const KEY_ID = /^[0-9a-f]{16}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

function keysOf(value: unknown): TrustedKey[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const keys = value.filter(
    (key): key is TrustedKey =>
      typeof key === "object" &&
      key !== null &&
      KEY_ID.test(String((key as TrustedKey).id)) &&
      PUBLIC_KEY.test(String((key as TrustedKey).public_key)),
  );
  return keys.map(({ id, public_key }) => ({ id, public_key }));
}

/** A trust file's contents, or undefined when it is not one. */
export function parseTrust(value: unknown): TrustFile | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { schema, server, keys } = value as Record<string, unknown>;
  const parsed = keysOf(keys);
  if (schema !== TRUST_SCHEMA || !isText(server) || !parsed) return undefined;
  return { schema: TRUST_SCHEMA, server, keys: parsed };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The trust file's path on this machine: the system path, or with `root`, the same path under
 * that folder (for tests and images). Undefined on platforms selfhost has no path for.
 */
export function trustPath(platform: string, root?: string): string | undefined {
  const target = TRUST_PATHS[platform as keyof typeof TRUST_PATHS];
  if (target === undefined) return undefined;
  if (root === undefined) return target;
  const drive = /^([A-Za-z]):[\\/]/.exec(target);
  const rest = drive ? target.slice(3) : target;
  return join(root, ...(drive ? [drive[1] ?? ""] : []), ...rest.split(/[\\/]+/).filter(Boolean));
}

/** The text of the trust file pinning these keys, as the managed install writes it. */
export function trustFileText(server: string, keys: readonly TrustedKey[]): string {
  const file: TrustFile = {
    schema: TRUST_SCHEMA,
    server,
    keys: keys.map(({ id, public_key }) => ({ id, public_key })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The keys config.json pins for its team server, when they are for that server. */
export function configPin(config: Record<string, unknown> | undefined): TrustFile | undefined {
  const pin = parseTrust(config?.exception_keys);
  return pin && pin.server === config?.server ? pin : undefined;
}

/**
 * The keys grants are verified with on this laptop: the root-owned trust file when there is one,
 * else the team membership's pin in config.json, else none (solo mode).
 */
export function exceptionTrust(
  configPath: string | undefined,
  platform: string,
  systemRoot?: string,
): ExceptionTrust {
  const config = configPath ? readJson(configPath) : undefined;
  const object =
    typeof config === "object" && config !== null && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : undefined;
  const team = isText(object?.server) && isText(object?.token) && isText(object?.team);
  const person = team && isText(object?.person) ? { person: object.person as string } : {};
  const managedPath = trustPath(platform, systemRoot);
  const managed = managedPath ? parseTrust(readJson(managedPath)) : undefined;
  if (managed) {
    return {
      mode: "team",
      source: "managed",
      keys: managed.keys,
      server: managed.server,
      path: managedPath,
      ...person,
    };
  }
  if (!team) return { mode: "solo", source: "none", keys: [] };
  const pin = configPin(object);
  return pin
    ? {
        mode: "team",
        source: "config",
        keys: pin.keys,
        server: pin.server,
        ...(configPath ? { path: configPath } : {}),
        ...person,
      }
    : { mode: "team", source: "none", keys: [], server: object?.server as string, ...person };
}
