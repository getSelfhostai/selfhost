import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "../team/client.js";

const REQUEST_TIMEOUT_MS = 30_000;

/** An error answer from a cloud provider's API, or a request that never got one (status 0). */
export class CloudApiError extends Error {
  override name = "CloudApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A JSON API with a bearer token: Hetzner Cloud and DigitalOcean both look like this. */
export function jsonApi(fetch: Fetch, label: string, base: string, token: string) {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CloudApiError(0, "unreachable", `Could not reach the ${label} API: ${reason}`);
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      // Hetzner: {"error": {"code", "message"}}. DigitalOcean: {"id", "message"}.
      const answer = json as
        | { error?: { code?: string; message?: string }; id?: string; message?: string }
        | undefined;
      const code = answer?.error?.code ?? answer?.id ?? "http_error";
      const message = answer?.error?.message ?? answer?.message ?? (text.slice(0, 200) || "");
      throw new CloudApiError(
        response.status,
        code,
        `${label} API ${method} ${path} answered ${response.status} ${code}${message ? `: ${message}` : ""}`,
      );
    }
    if (json === undefined) {
      throw new CloudApiError(response.status, "bad_response", `${label} API did not answer JSON`);
    }
    return json as T;
  };
}

export interface PublicKey {
  path: string;
  /** The whole line: type, base64 key and comment. */
  key: string;
  /** MD5 fingerprint as Hetzner and DigitalOcean show it, like 3b:16:...:fa. */
  fingerprint: string;
}

const KEY_FILES = ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"];

/** The public key to put on a new server: --ssh-key, else the first of ~/.ssh/id_*.pub. */
export function findPublicKey(flag: string | undefined, env: NodeJS.ProcessEnv): PublicKey {
  const home = env.HOME || homedir();
  const candidates = flag
    ? [flag.endsWith(".pub") ? flag : `${flag}.pub`]
    : KEY_FILES.map((file) => join(home, ".ssh", file));
  const path = candidates.find((file) => existsSync(file));
  if (!path) {
    throw new Error(
      flag
        ? `No SSH public key at ${candidates[0]}`
        : "No SSH public key in ~/.ssh (id_ed25519.pub, id_ecdsa.pub or id_rsa.pub): pass --ssh-key <file> or create one with ssh-keygen -t ed25519",
    );
  }
  const key = readFileSync(path, "utf8").trim().split("\n")[0]?.trim() ?? "";
  return { path, key, fingerprint: md5Fingerprint(key, path) };
}

export function md5Fingerprint(key: string, where = "the SSH public key"): string {
  const blob = key.split(/\s+/)[1];
  if (!/^(ssh-|ecdsa-)/.test(key) || !blob || !/^[A-Za-z0-9+/]+=*$/.test(blob)) {
    throw new Error(`${where} is not an OpenSSH public key (ssh-ed25519 AAAA... comment)`);
  }
  const digest = createHash("md5").update(Buffer.from(blob, "base64")).digest("hex");
  return digest.match(/../g)?.join(":") ?? digest;
}
