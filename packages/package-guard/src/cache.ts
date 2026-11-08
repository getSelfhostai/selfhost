import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Lookup results by key, each until its own expiry. */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}

interface Entry {
  key: string;
  expires: number;
  value: unknown;
}

/**
 * A cache in memory and, with `dir`, on disk: one JSON file per key, so separate hook processes
 * share results. Best effort: a file that cannot be read or written is a miss, never an error.
 * Writes go to a temporary file first and are renamed into place, so a reader never sees half
 * a file.
 */
export function createCache(now: () => Date, dir?: string): Cache {
  const memory = new Map<string, Entry>();
  const fileOf = (key: string) =>
    dir === undefined
      ? undefined
      : join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const at = now().getTime();
      const held = memory.get(key);
      if (held && held.expires > at) return held.value as T;
      const file = fileOf(key);
      if (!file) return undefined;
      try {
        const entry = JSON.parse(await readFile(file, "utf8")) as Entry;
        if (entry.key !== key || !(entry.expires > at)) return undefined;
        memory.set(key, entry);
        return entry.value as T;
      } catch {
        return undefined;
      }
    },
    async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
      const entry: Entry = { key, expires: now().getTime() + ttlMs, value };
      memory.set(key, entry);
      const file = fileOf(key);
      if (!file || dir === undefined) return;
      try {
        await mkdir(dir, { recursive: true });
        const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(temp, JSON.stringify(entry));
        await rename(temp, file);
      } catch {
        // A cache that cannot be written only costs a lookup next time.
      }
    },
  };
}
