import { databaseOf, type Ledger } from "@selfhost/ledger";
import { isSnoozed, openReviewList } from "@selfhost/review";
import type {
  LedgerEvent,
  NotifyCadence,
  NotifyConfig,
  NotifyKind,
  ReviewItem,
} from "@selfhost/schema";
import type { Deliver, Message } from "./apprise.js";
import { digestWindow, spendDigestWindow } from "./cadence.js";
import { scrub } from "./mask.js";
import {
  digestMessage,
  isEmptyDigest,
  itemMessage,
  type SpendDigest,
  spendAlertMessage,
  spendDigestMessage,
} from "./message.js";
import { type NotifyStore, notifyStore } from "./store.js";

/** [notify] with its defaults applied. */
export type NotifySettingsInForce = Required<NotifyConfig>;

export const NOTIFY_DEFAULTS: NotifySettingsInForce = {
  digest: "daily",
  digest_hour: 9,
  budget_owners: [],
  spend_digest: true,
};

/** Who gets what, from the team server's teams and policies, or the laptop's one person. */
export interface Directory {
  /**
   * [notify] in force for a person; undefined when they no longer have access (every token
   * revoked), so nothing more is sent to them.
   */
  settingsFor(person: string): Promise<NotifySettingsInForce | undefined>;
  /** Who is pushed an item an agent waits on when the item has no owner. team is null on a laptop. */
  unowned(team: string | null): Promise<string[]>;
  /** Who gets a team's budget alerts. */
  budgetOwners(team: string | null): Promise<string[]>;
  /** The budget owner's daily spend digest; undefined when the person owns no budget. */
  spendDigest?(person: string, now: Date): Promise<SpendDigest | undefined>;
}

export interface NotifyOptions {
  deliver: Deliver;
  directory: Directory;
  now: Date;
  /** The console's address for links: SELFHOST_PUBLIC_URL. Without it messages name the CLI. */
  consoleUrl?: string;
  /**
   * A laptop: the digest holds every open item from the person's own sessions, owned or not,
   * since nobody else reads that list.
   */
  solo?: boolean;
}

export interface NotifyResult {
  sent: number;
  failed: number;
}

/** Items opened longer ago than this are left to the digest: a new target gets no backlog. */
const INSTANT_WINDOW_MS = 60 * 60_000;
/** Budget alerts raised longer ago than this are not pushed any more. */
const SPEND_WINDOW_MS = 24 * 60 * 60_000;
const DIGEST_ITEMS = 50;
const PAGE = 1000;

const json = <T>(value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as T;

/** alert.raised data.alert values of the 50%, 80% and 100% budget alerts. */
const BUDGET_ALERTS = new Set(["budget", "budget_exceeded"]);

/**
 * A budget alert pushed at once: a share of a team, person or key budget, but not a run's cap,
 * which goes into the spend digest instead.
 */
export function isSpendAlert(event: LedgerEvent): boolean {
  const data = event.data ?? {};
  return (
    event.kind === "alert.raised" &&
    typeof data.alert === "string" &&
    BUDGET_ALERTS.has(data.alert) &&
    typeof data.limit_usd === "number" &&
    data.scope !== "run"
  );
}

/** Who gets an instant push for an item: its owners, else who the directory names. */
export async function recipientsOf(
  item: Pick<ReviewItem, "owners">,
  team: string | null,
  directory: Directory,
): Promise<string[]> {
  if (item.owners.length > 0) return item.owners;
  return directory.unowned(team);
}

async function alertsSince(ledger: Ledger, from: Date): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await ledger.query({
      kind: "alert.raised",
      from: from.toISOString(),
      limit: PAGE,
      cursor,
    });
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return events.reverse();
}

/**
 * One pass: pushes items agents wait on and budget alerts to the people they are for, then
 * sends each person's digest and the budget owner's spend digest when their window opens.
 * Every send is recorded by target name, and nothing is sent twice to the same target; a failed
 * send is tried again on later passes, up to three times. Only people with a target and access
 * are considered, so a server with no targets does a single query.
 */
export async function runNotify(ledger: Ledger, options: NotifyOptions): Promise<NotifyResult> {
  const db = databaseOf(ledger);
  const store = notifyStore(db);
  const { now, deliver, directory, consoleUrl } = options;
  const result: NotifyResult = { sent: 0, failed: 0 };
  const people: { person: string; settings: NotifySettingsInForce }[] = [];
  for (const person of await store.people()) {
    const settings = await directory.settingsFor(person);
    if (settings) people.push({ person, settings });
  }
  if (people.length === 0) return result;
  const byLower = new Map(people.map(({ person }) => [person.toLowerCase(), person]));
  const withTargets = (names: Iterable<string>) => [
    ...new Set(
      [...names]
        .map((name) => byLower.get(name.toLowerCase()))
        .filter((person) => person !== undefined),
    ),
  ];
  const send = (
    person: string,
    kind: NotifyKind,
    subject: string,
    build: () => Promise<Message | undefined> | Message | undefined,
  ) => sendOnce(store, deliver, now, result, { person, kind, subject, build });

  const waiting = await db.query<{ body: unknown; team: string | null }>(
    `SELECT body, team FROM review_items
     WHERE state = 'open' AND blocking AND created_at >= $1::timestamptz
     ORDER BY created_at, id`,
    [new Date(now.getTime() - INSTANT_WINDOW_MS).toISOString()],
  );
  for (const row of waiting) {
    const item = json<ReviewItem>(row.body);
    for (const person of withTargets(await recipientsOf(item, row.team, directory))) {
      await send(person, "item", item.id, () => itemMessage(item, consoleUrl));
    }
  }

  const alerts = await alertsSince(ledger, new Date(now.getTime() - SPEND_WINDOW_MS));
  // A laptop's own alerts are for that laptop; on a team server they arrive with its history.
  const spendAlerts = alerts.filter(
    (event) => isSpendAlert(event) && (options.solo === true || event.source !== "cli"),
  );
  for (const event of spendAlerts) {
    const owner = typeof event.data?.owner === "string" ? [event.data.owner] : [];
    const owners = [...(await directory.budgetOwners(event.team ?? null)), ...owner];
    for (const person of withTargets(owners)) {
      await send(person, "spend", event.id, () => spendAlertMessage(event, consoleUrl));
    }
  }

  const list = openReviewList(ledger, { now: () => now });
  for (const { person, settings } of people) {
    const cadence: NotifyCadence = (await store.digest(person)) ?? settings.digest;
    const window = digestWindow(cadence, now, settings.digest_hour);
    if (window && cadence !== "off") {
      await send(person, "digest", window.key, async () => {
        const page = await list.list({
          state: "open",
          ...(options.solo ? { for: person } : { owner: person }),
          limit: DIGEST_ITEMS,
        });
        const items = page.items.filter((item) => !isSnoozed(item, now));
        return items.length > 0 ? digestMessage(items, cadence, consoleUrl) : undefined;
      });
    }
    const spendDigest = directory.spendDigest;
    if (settings.spend_digest && spendDigest) {
      const spend = spendDigestWindow(now, settings.digest_hour);
      await send(person, "spend_digest", spend.key, async () => {
        const digest = await spendDigest(person, now);
        return digest && !isEmptyDigest(digest)
          ? spendDigestMessage(digest, consoleUrl)
          : undefined;
      });
    }
  }
  await store.prune(now);
  return result;
}

/**
 * Sends one thing to each of a person's targets that has not had it yet. The message is built
 * only when some target still needs it; undefined means there is nothing to send this time.
 */
async function sendOnce(
  store: NotifyStore,
  deliver: Deliver,
  now: Date,
  result: NotifyResult,
  send: {
    person: string;
    kind: NotifyKind;
    subject: string;
    build: () => Promise<Message | undefined> | Message | undefined;
  },
): Promise<void> {
  const done = await store.done(send.person, send.kind, send.subject);
  const pending = (await store.targets(send.person)).filter((target) => !done.has(target.name));
  if (pending.length === 0) return;
  const message = await send.build();
  if (!message) return;
  for (const target of pending) {
    const delivered = await deliver.send(target.url, message);
    await store.record(send.person, {
      at: now.toISOString(),
      target: target.name,
      kind: send.kind,
      subject: send.subject,
      ok: delivered.ok,
      ...(delivered.ok ? {} : { error: scrub(delivered.error, [target.url]) }),
    });
    if (delivered.ok) result.sent += 1;
    else result.failed += 1;
  }
}

/** Sends the test message to the person's targets, or the one named, and records each send. */
export async function sendTest(
  ledger: Ledger,
  person: string,
  deliver: Deliver,
  message: Message,
  now: Date,
  name?: string,
) {
  const store = notifyStore(databaseOf(ledger));
  const targets = (await store.targets(person)).filter(
    (target) => name === undefined || target.name === name,
  );
  const sends = [];
  for (const target of targets) {
    const delivered = await deliver.send(target.url, message);
    const send = {
      at: now.toISOString(),
      target: target.name,
      kind: "test" as const,
      ok: delivered.ok,
      ...(delivered.ok ? {} : { error: scrub(delivered.error, [target.url]) }),
    };
    await store.record(person, send);
    sends.push(send);
  }
  return sends;
}
