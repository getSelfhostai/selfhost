import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { LedgerWriter } from "@selfhost/importers";
import { DEFAULT_REDACTION, type LedgerEvent, redactEvent } from "@selfhost/schema";
import { isAlive } from "../alerts/cache.js";

/**
 * The live feed `selfhost tail` follows on a laptop. The embedded ledger allows one process at
 * a time and `selfhost import --watch` keeps it open, so the watcher also appends each event it
 * writes to a small file here, and the tail reads that file: it never opens the ledger while a
 * watcher runs. One file per UTC day, the last two kept, readable by this user only. Each line
 * is the event as the ledger stores it (no prompt text, secrets masked), cut to the fields the
 * tail prints.
 */

export const FEED_FILE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const KEEP_DAYS = 2;

/** Who is writing the feed: the `import --watch` process, while it runs. */
export interface FeedWatcher {
  schema: "selfhost.feed_watcher/v1";
  pid: number;
  started_at: string;
}

/** ~/.selfhost/feed, next to the config file, or SELFHOST_FEED_DIR. */
export function feedDir(env: NodeJS.ProcessEnv, configPath: string): string {
  return env.SELFHOST_FEED_DIR ?? join(dirname(configPath), "feed");
}

const watcherPath = (dir: string) => join(dir, "watcher.json");
const dayFile = (dir: string, now: Date) =>
  join(dir, `events-${now.toISOString().slice(0, 10)}.jsonl`);

export function readWatcher(dir: string): FeedWatcher | undefined {
  try {
    const watcher = JSON.parse(readFileSync(watcherPath(dir), "utf8")) as FeedWatcher;
    return watcher?.schema === "selfhost.feed_watcher/v1" ? watcher : undefined;
  } catch {
    return undefined;
  }
}

/** A watcher is writing the feed now. */
export const watcherAlive = (dir: string) => isAlive(readWatcher(dir)?.pid);

/** The data fields the tail reads; the rest is dropped. */
const DATA_FIELDS = ["alert", "message", "answer", "tool_event_id", "request_type"];

/** The event as the tail needs it: redacted like the ledger, small, with the run's repo. */
export function feedEvent(event: LedgerEvent, repo: string | undefined): LedgerEvent {
  const stored = redactEvent(event, DEFAULT_REDACTION);
  const data = stored.data
    ? Object.fromEntries(
        DATA_FIELDS.filter((key) => key in (stored.data ?? {})).map((k) => [k, stored.data?.[k]]),
      )
    : {};
  const tool = stored.tool
    ? {
        name: stored.tool.name,
        ...(stored.tool.input_summary ? { input_summary: stored.tool.input_summary } : {}),
      }
    : undefined;
  return {
    id: stored.id,
    schema: stored.schema,
    ts: stored.ts,
    source: stored.source,
    kind: stored.kind,
    actor: stored.actor,
    ...(stored.team ? { team: stored.team } : {}),
    ...(stored.repo ? { repo: stored.repo } : repo ? { repo } : {}),
    ...(stored.agent ? { agent: stored.agent } : {}),
    ...(stored.model ? { model: stored.model } : {}),
    ...(stored.session_id ? { session_id: stored.session_id } : {}),
    ...(tool ? { tool } : {}),
    ...(stored.target ? { target: stored.target } : {}),
    ...(stored.decision ? { decision: stored.decision } : {}),
    ...(stored.cost ? { cost: stored.cost } : {}),
    ...(stored.links ? { links: stored.links } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  };
}

export interface FeedWriter {
  /** A writer that copies every event the ledger accepted into the feed. */
  tap(writer: LedgerWriter): LedgerWriter;
  /** Says the watcher stopped; the next tail falls back to reading the ledger. */
  close(): void;
}

/**
 * Starts the feed for `selfhost import --watch`. Writing to it never fails an import: a feed
 * that cannot be written is skipped, once reported through `warn`.
 */
export function startFeed(
  dir: string,
  options: { now?: () => Date; pid?: number; warn?: (line: string) => void } = {},
): FeedWriter {
  const clock = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const repos = new Map<string, string>();
  let warned = false;
  let day = "";
  const safely = (work: () => void) => {
    try {
      work();
    } catch (error) {
      if (!warned)
        options.warn?.(`Live feed for selfhost tail not written: ${(error as Error).message}`);
      warned = true;
    }
  };
  safely(() => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const watcher: FeedWatcher = {
      schema: "selfhost.feed_watcher/v1",
      pid,
      started_at: clock().toISOString(),
    };
    const temporary = `${watcherPath(dir)}.${pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(watcher)}\n`, { mode: 0o600 });
    renameSync(temporary, watcherPath(dir));
  });

  function prune(now: Date): void {
    const today = now.toISOString().slice(0, 10);
    if (today === day) return;
    day = today;
    const oldest = new Date(now.getTime() - (KEEP_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (const name of readdirSync(dir)) {
      const match = FEED_FILE.exec(name);
      if (match?.[1] && match[1] < oldest) rmSync(join(dir, name), { force: true });
    }
  }

  return {
    tap(writer) {
      return {
        async append(batch) {
          const result = await writer.append(batch);
          const accepted = new Set(result.accepted);
          const lines: string[] = [];
          for (const event of batch) {
            if (event.session_id && event.repo) repos.set(event.session_id, event.repo);
            if (!accepted.has(event.id)) continue;
            const repo = event.session_id ? repos.get(event.session_id) : undefined;
            lines.push(JSON.stringify(feedEvent(event, repo)));
          }
          if (lines.length > 0) {
            safely(() => {
              const now = clock();
              prune(now);
              appendFileSync(dayFile(dir, now), `${lines.join("\n")}\n`, { mode: 0o600 });
            });
          }
          return result;
        },
      };
    },
    close() {
      safely(() => {
        if (readWatcher(dir)?.pid === pid) rmSync(watcherPath(dir), { force: true });
      });
    },
  };
}

/** Follows the feed files: each call returns the events appended since the last one. */
export class FeedReader {
  private readonly offsets = new Map<string, number>();
  private readonly partial = new Map<string, string>();

  constructor(private readonly dir: string) {}

  /** Skips everything already in the feed, so the next read returns only what lands later. */
  skipToEnd(): void {
    for (const file of this.files()) this.offsets.set(file, statSync(join(this.dir, file)).size);
  }

  read(): LedgerEvent[] {
    const events: LedgerEvent[] = [];
    for (const file of this.files()) {
      const path = join(this.dir, file);
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }
      const offset = this.offsets.get(file) ?? 0;
      if (size <= offset) continue;
      const buffer = readFileSync(path).subarray(offset, size);
      this.offsets.set(file, size);
      const text = (this.partial.get(file) ?? "") + buffer.toString("utf8");
      const lines = text.split("\n");
      this.partial.set(file, lines.pop() ?? "");
      for (const line of lines) {
        if (line.trim() === "") continue;
        try {
          events.push(JSON.parse(line) as LedgerEvent);
        } catch {
          // A line cut short by a crash: skip it.
        }
      }
    }
    return events;
  }

  private files(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((name) => FEED_FILE.test(name))
        .sort();
    } catch {
      return [];
    }
  }
}
