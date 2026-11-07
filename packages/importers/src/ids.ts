import { createHash } from "node:crypto";

const MAX_UNIX_MS = 2 ** 48 - 1;

/**
 * A UUIDv7-formatted id that is a pure function of its inputs: the 48-bit timestamp field holds
 * `timestampMs`, and the remaining 74 bits come from a SHA-256 of `seed`. Re-importing the same
 * line yields the same id, so the ledger's idempotency key drops the repeat.
 */
export function deterministicUuidv7(seed: string, timestampMs: number): string {
  const hash = createHash("sha256").update(seed).digest();
  const bytes = Buffer.alloc(16);
  let time = Math.min(Math.max(0, Math.floor(timestampMs)), MAX_UNIX_MS);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  hash.copy(bytes, 6, 0, 10);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
