import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { isPostgresUrl, type Ledger, openLedger } from "@selfhost/ledger";
import { ledgerData, type McpData, McpToolError } from "@selfhost/mcp";
import { effectiveRules } from "@selfhost/policy";
import { openReviewList } from "@selfhost/review";
import {
  PAGE_LIMIT_MAX,
  type PolicyResponse,
  parseRemote,
  type ReviewItem,
  type ReviewItemsPage,
} from "@selfhost/schema";
import { isAlive, readCache } from "../alerts/cache.js";
import { localPerson } from "../alerts/person.js";
import { statuslineCachePath } from "../alerts/settings.js";
import { drainSpool } from "../hooks/drain.js";
import { exceptionsDir, isOwnException, issueGrants, readGrant } from "../hooks/exceptions.js";
import { loadPolicy } from "../hooks/pretool.js";
import { spoolDir } from "../hooks/receive.js";
import { inboxPaths, readInboxCache } from "../inbox/store.js";
import { periodSpend, readSpendSnapshot, soloBudget, spendSnapshotPath } from "./spend.js";

const run = promisify(execFile);

export interface LocalMcpIo {
  env: NodeJS.ProcessEnv;
  /** The folder the agent started the server in: its repository. */
  cwd: string;
  /** ~/.selfhost/config.json. */
  configPath: string;
}

export interface LocalMcpOptions {
  database?: string;
  dataDir?: string;
}

const HELD =
  "selfhost import --watch holds the embedded ledger, which takes one process at a time. Stop it, or keep the ledger in Postgres (DATABASE_URL), to use this tool.";

/**
 * list_review_items while the watcher holds the ledger: from the copy of the person's open items
 * it saves for selfhost inbox, ranked as the list returned them. Other states need the ledger.
 */
export function heldReviewItems(
  items: ReviewItem[],
  query: { state?: string; owner?: string; for?: string; limit?: number; cursor?: string },
): ReviewItemsPage {
  if (query.state !== undefined && query.state !== "open") {
    throw new McpToolError(
      "unavailable",
      `While selfhost import --watch runs, only open items can be listed here (from the copy it saves). ${HELD}`,
    );
  }
  const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
  const matching = items.filter(
    (item) =>
      (query.owner === undefined || item.owners.some((owner) => same(owner, query.owner ?? ""))) &&
      // The copy holds the person's own items; on a laptop an item with no owner is theirs too.
      (query.for === undefined ||
        item.owners.length === 0 ||
        item.owners.some((owner) => same(owner, query.for ?? "")) ||
        same(item.requested_by, query.for)),
  );
  const start = Number(query.cursor ?? 0) || 0;
  const end = start + (query.limit ?? PAGE_LIMIT_MAX);
  return {
    items: matching.slice(start, end),
    next_cursor: end < matching.length ? String(end) : null,
  };
}

/** owner/name of the repository at `cwd`, from its origin remote. */
async function repoAt(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-C", cwd, "remote", "get-url", "origin"]);
    return parseRemote(stdout)?.repo;
  } catch {
    return undefined;
  }
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The tools' data on this machine: the embedded ledger (or Postgres), the selfhost.toml the
 * hooks use for this repository, and the one-time exception files. Everything here is the
 * person's own, so nothing is refused for permissions. The embedded ledger is opened for each
 * call and closed after it, one call at a time, so `selfhost inbox` and `import` can still use
 * it between calls.
 */
export function localMcpData(
  io: LocalMcpIo,
  options: LocalMcpOptions = {},
  now: () => Date = () => new Date(),
): McpData {
  const person = localPerson(undefined, io);
  const exceptions = exceptionsDir(dirname(io.configPath));
  const url = options.database ?? io.env.DATABASE_URL;
  const embedded = !(url && isPostgresUrl(url));
  const policyOf = () => loadPolicy(io.cwd, io.env, io.configPath);

  let queue: Promise<unknown> = Promise.resolve();
  function use<T>(fn: (ledger: Ledger) => Promise<T>): Promise<T> {
    const next = queue.then(async () => {
      if (embedded && watcherHolds()) throw new McpToolError("unavailable", HELD);
      const ledger = await openLedger({ url, dataDir: options.dataDir });
      try {
        return await fn(ledger);
      } finally {
        await ledger.close();
      }
    });
    queue = next.catch(() => undefined);
    return next;
  }

  function watcherHolds(): boolean {
    const inbox = readInboxCache(inboxPaths(io.configPath).cache, { server: null, team: null });
    return isAlive(inbox?.pid) || isAlive(readCache(statuslineCachePath(io))?.pid);
  }

  /** The watcher's saved copy, when it is alive to keep it fresh. */
  function heldCopy<T extends { pid: number | null }>(copy: T | undefined): T | undefined {
    return copy && isAlive(copy.pid) ? copy : undefined;
  }

  const shared = ledgerData({
    use,
    person,
    config: policyOf().config,
    now,
    source: "cli",
    async beforeException(ledger, id) {
      if (!isOwnException(exceptions, id)) {
        throw new McpToolError(
          "not_found",
          `No call blocked on this machine asked for exception ${id}. Use the id from selfhost's block message.`,
        );
      }
      // The block is on the spool until the next import; bring it in so the item is listed.
      await drainSpool(ledger, spoolDir(io.env), { person, now: now(), exceptionsOnly: true });
    },
  });

  return {
    ...shared,

    async reviewItems(query) {
      if (embedded && watcherHolds()) {
        const inbox = heldCopy(
          readInboxCache(inboxPaths(io.configPath).cache, { server: null, team: null }),
        );
        if (!inbox) throw new McpToolError("unavailable", HELD);
        return heldReviewItems(inbox.items, query);
      }
      return shared.reviewItems(query);
    },

    async policy(query) {
      const loaded = policyOf();
      const repo = await repoAt(io.cwd);
      if (query.repo !== undefined && query.repo.toLowerCase() !== repo) {
        throw new McpToolError(
          "not_found",
          `This selfhost mcp runs in ${repo ?? "a folder with no origin remote"} and reads that repository's policy only. Start it in ${query.repo}, or connect to the team server.`,
        );
      }
      const response: PolicyResponse = {
        hash: loaded.source?.hash ?? hashOf(""),
        ...(repo ? { repo } : {}),
        ...(loaded.text !== undefined ? { text: loaded.text } : {}),
        loaded_at: now().toISOString(),
        config: loaded.config,
        effective_rules: effectiveRules(loaded.config, {
          person: query.person ?? person,
          ...(query.agent ? { agent: query.agent } : {}),
        }),
      };
      return response;
    },

    async budget(query) {
      const loaded = policyOf();
      const where = loaded.source?.path ?? "selfhost.toml";
      const answer = (spent: Awaited<ReturnType<typeof periodSpend>>) =>
        soloBudget(query, spent, person, loaded.config.budget, now(), where);
      if (embedded && watcherHolds()) {
        const snapshot = heldCopy(readSpendSnapshot(spendSnapshotPath(io.env, io.configPath)));
        const known =
          query.person === undefined ||
          query.person.toLowerCase() === snapshot?.person.toLowerCase();
        if (!snapshot || !known) throw new McpToolError("unavailable", HELD);
        return answer(snapshot.spent);
      }
      return use(async (ledger) =>
        answer(await periodSpend(ledger, query.person ?? person, now())),
      );
    },

    async grant(item) {
      if (!isOwnException(exceptions, item.id)) return undefined;
      const at = now();
      let grant = readGrant(exceptions, item.id, at);
      if (!grant) {
        await use(async (ledger) => {
          const list = openReviewList(ledger, { config: policyOf().config, now });
          await issueGrants(exceptions, (id) => list.get(id), at);
        });
        grant = readGrant(exceptions, item.id, at);
      }
      return grant ? { expires_at: grant.expires_at } : undefined;
    },
  };
}
