import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  EXCEPTION_KEYS_SCHEMA,
  type ExceptionGrant,
  type ExceptionKeysResponse,
  exceptionGrantPayload,
} from "@selfhost/schema";

/**
 * The Ed25519 keys this server signs one-time exception grants with. They are made on the first
 * start and kept next to the API token, in <dataDir>/exception-keys.json (mode 0600), or in the
 * file SELFHOST_EXCEPTION_KEYS_FILE names, which several servers sharing one database point at so
 * they sign with the same keys. The private keys never leave this file: laptops get the public
 * keys from GET /v1/exception-keys and pin them.
 *
 * Rotation adds a key and makes it the one that signs; the older ones stay listed, so grants they
 * signed still verify on laptops until they expire. A laptop pins the new key on its next sync
 * (and its next managed settings install, where those hold the pin).
 */

const KEYRING_SCHEMA = "selfhost.exception_keyring/v1";

interface StoredKey {
  id: string;
  /** PKCS#8 DER, base64. */
  private_key: string;
  /** Raw 32-byte public key, base64url. */
  public_key: string;
  created_at: string;
}

interface StoredKeyring {
  schema: typeof KEYRING_SCHEMA;
  active: string;
  keys: StoredKey[];
}

export interface ExceptionKeyring {
  /** Where the keys are kept; undefined for an in-memory data dir, whose keys last one process. */
  path?: string;
  /** true when this load made the first key. */
  created: boolean;
  /** The public keys, for GET /v1/exception-keys. */
  publicKeys(): ExceptionKeysResponse;
  /** Signs a grant with the active key. */
  sign(grant: Omit<ExceptionGrant, "signature" | "key_id">): ExceptionGrant;
  /** Adds a key and makes it the one that signs; returns its id. */
  rotate(now?: Date): string;
}

/** The first 16 hex digits of sha256 of the raw public key. */
export function keyIdOf(publicKey: Buffer): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}

function newKey(now: Date): StoredKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  return {
    id: keyIdOf(raw),
    private_key: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    public_key: raw.toString("base64url"),
    created_at: now.toISOString(),
  };
}

function check(ring: StoredKeyring, path: string): StoredKeyring {
  if (ring.schema !== KEYRING_SCHEMA || !Array.isArray(ring.keys) || ring.keys.length === 0) {
    throw new Error(`${path} is not a selfhost exception keyring`);
  }
  for (const key of ring.keys) {
    const derived = createPublicKey(createPrivateKey(privateDer(key)));
    const raw = Buffer.from(derived.export({ format: "jwk" }).x ?? "", "base64url");
    if (raw.toString("base64url") !== key.public_key || keyIdOf(raw) !== key.id) {
      throw new Error(`${path}: key ${key.id} does not match its private key`);
    }
  }
  if (!ring.keys.some((key) => key.id === ring.active)) {
    throw new Error(`${path}: the active key ${ring.active} is not in the file`);
  }
  return ring;
}

const privateDer = (key: StoredKey) => ({
  key: Buffer.from(key.private_key, "base64"),
  format: "der" as const,
  type: "pkcs8" as const,
});

function save(path: string, ring: StoredKeyring): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ring, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function read(path: string): StoredKeyring | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return check(JSON.parse(text) as StoredKeyring, path);
}

/**
 * The keyring of SELFHOST_EXCEPTION_KEYS_FILE, else <dataDir>/exception-keys.json, made with one
 * key when there is none. An in-memory data dir (memory://) gets a key for this process only.
 */
export function loadExceptionKeys(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): ExceptionKeyring {
  const fromEnv = env.SELFHOST_EXCEPTION_KEYS_FILE?.trim();
  const path =
    fromEnv || (dataDir.includes("://") ? undefined : join(dataDir, "exception-keys.json"));
  let ring = path ? read(path) : undefined;
  const created = ring === undefined;
  if (!ring) {
    const first = newKey(now);
    ring = { schema: KEYRING_SCHEMA, active: first.id, keys: [first] };
    if (path) save(path, ring);
  }
  return keyring(ring, path, created);
}

function keyring(
  initial: StoredKeyring,
  path: string | undefined,
  created: boolean,
): ExceptionKeyring {
  let ring = initial;
  const signers = new Map<string, KeyObject>();
  const signer = (key: StoredKey) => {
    let found = signers.get(key.id);
    if (!found) {
      found = createPrivateKey(privateDer(key));
      signers.set(key.id, found);
    }
    return found;
  };
  return {
    ...(path ? { path } : {}),
    created,
    publicKeys: () => ({
      schema: EXCEPTION_KEYS_SCHEMA,
      algorithm: "ed25519",
      active: ring.active,
      keys: ring.keys.map(({ id, public_key, created_at }) => ({ id, public_key, created_at })),
    }),
    sign(grant) {
      const active = ring.keys.find((key) => key.id === ring.active);
      if (!active) throw new Error("the exception keyring has no active key");
      const unsigned = { ...grant, key_id: active.id };
      const signature = sign(null, exceptionGrantPayload(unsigned), signer(active));
      return { ...unsigned, signature: signature.toString("base64url") };
    },
    rotate(now = new Date()) {
      const next = newKey(now);
      ring = { ...ring, active: next.id, keys: [...ring.keys, next] };
      if (path) save(path, ring);
      return next.id;
    },
  };
}
