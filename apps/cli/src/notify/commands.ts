import { databaseOf, type Ledger, openLedger } from "@selfhost/ledger";
import {
  freeName,
  nameProblem,
  notifyStore,
  publicTarget,
  sendTest,
  serviceOf,
  testMessage,
  urlProblem,
} from "@selfhost/notify";
import {
  NOTIFY_CADENCES,
  type NotifyCadence,
  type NotifySend,
  type NotifySettings,
} from "@selfhost/schema";
import type { Command } from "commander";
import { table } from "../format.js";
import { agentSessionVariable } from "../human.js";
import { defaultPerson } from "../import.js";
import { type Fetch, serverUrl, TeamClient } from "../team/client.js";
import { readMembership } from "../team/config.js";
import { type LaptopNotifyIo, laptopConfig, laptopDeliver } from "./laptop.js";

export interface NotifyIo extends LaptopNotifyIo {
  write: (line: string) => void;
  setExitCode: (code: number) => void;
  now?: Date;
  configPath: string;
  fetch: Fetch;
  /** Reads an Apprise URL given as "-". */
  readStdin: () => Promise<string>;
}

interface NotifyOptions {
  json?: boolean;
  database?: string;
  dataDir?: string;
}

/** Most targets a person keeps on a laptop, as on a team server. */
const MAX_TARGETS = 10;

/**
 * Where the person's settings live: the team server they joined, through its API, or this
 * laptop's ledger, sending with the apprise command.
 */
interface Backend {
  where: string;
  settings(): Promise<NotifySettings>;
  add(url: string, name?: string): Promise<NotifySettings>;
  remove(name: string): Promise<NotifySettings>;
  digest(digest: NotifyCadence): Promise<NotifySettings>;
  test(name?: string): Promise<NotifySend[]>;
  close(): Promise<void>;
}

function teamBackend(io: NotifyIo): Backend | undefined {
  const membership = readMembership(io.configPath);
  if (!membership) return undefined;
  const client = new TeamClient(serverUrl(membership.server), membership.token, io.fetch);
  return {
    where: `team ${membership.team} on ${membership.server}`,
    settings: () => client.notify(),
    add: (url, name) => client.addNotifyTarget(url, name),
    remove: (name) => client.removeNotifyTarget(name),
    digest: (digest) => client.setNotifyDigest(digest),
    test: async (name) => (await client.testNotify(name)).sends,
    close: async () => {},
  };
}

async function laptopBackend(io: NotifyIo, options: NotifyOptions): Promise<Backend> {
  const ledger: Ledger = await openLedger({
    url: options.database ?? io.env.DATABASE_URL,
    dataDir: options.dataDir,
  });
  const store = notifyStore(databaseOf(ledger));
  const person = defaultPerson(io.env, io.cwd);
  const deliver = laptopDeliver(io);
  const settings = async (): Promise<NotifySettings> => {
    const own = await store.digest(person);
    return {
      person,
      targets: (await store.targets(person)).map(publicTarget),
      digest: own ?? laptopConfig(io).notify.digest,
      digest_set: own !== undefined,
      delivery: deliver ? deliver.kind : "none",
    };
  };
  return {
    where: "this laptop",
    settings,
    async add(url, name) {
      const targets = await store.targets(person);
      if (targets.length >= MAX_TARGETS) {
        throw new Error(`You have ${MAX_TARGETS} targets; remove one first.`);
      }
      const taken = new Set(targets.map((t) => t.name));
      const chosen = name ?? freeName(serviceOf(url), taken);
      if (
        taken.has(chosen) ||
        !(await store.addTarget(person, chosen, url, io.now ?? new Date()))
      ) {
        throw new Error(`You already have a target named ${chosen}.`);
      }
      return settings();
    },
    async remove(name) {
      if (!(await store.removeTarget(person, name))) {
        throw new Error(`You have no target named ${name}.`);
      }
      return settings();
    },
    async digest(digest) {
      await store.setDigest(person, digest);
      return settings();
    },
    async test(name) {
      if (!deliver) {
        throw new Error(
          "The apprise command is not on PATH, so this laptop cannot send. Install it with pipx install apprise, or join a team server that runs Apprise.",
        );
      }
      return sendTest(ledger, person, deliver, testMessage(person), io.now ?? new Date(), name);
    },
    close: () => ledger.close(),
  };
}

const DELIVERY_TEXT: Record<NotifySettings["delivery"], string> = {
  apprise_api: "through the server's Apprise",
  apprise_cli: "through the apprise command on this laptop",
  none: "nothing can send yet",
};

function settingsText(settings: NotifySettings, where: string): string[] {
  const lines = [`Notifications for ${settings.person} (${where}):`];
  if (settings.targets.length === 0) {
    lines.push("  No targets yet. Add one with selfhost notify add <apprise-url>.");
  } else {
    table(
      settings.targets.map((t) => [`  ${t.name}`, t.masked, `added ${t.created_at.slice(0, 10)}`]),
      (line) => lines.push(line),
    );
  }
  const source = settings.digest_set ? "your choice" : "the team default";
  lines.push(
    `Digest: ${settings.digest} (${source}). Delivery: ${DELIVERY_TEXT[settings.delivery]}.`,
  );
  return lines;
}

function checkName(name: string | undefined): void {
  if (name === undefined) return;
  const problem = nameProblem(name);
  if (problem) throw new Error(`--name: ${problem}`);
}

/**
 * `selfhost notify`: where a person's alerts and digests go, as Apprise URLs (Telegram, Slack,
 * email, Teams, Discord, ntfy and the rest), and how often their digest comes. On a team the
 * server keeps the URLs and sends; on a laptop the local ledger keeps them and the apprise
 * command sends. URLs are never printed back.
 */
export function registerNotify(
  program: Command,
  deps: () => NotifyIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const notify = program
    .command("notify")
    .description("phone, chat and email alerts and digests, through Apprise");

  const withLedger = (command: Command) =>
    command
      .option("--json", "print JSON")
      .option(
        "--database <url>",
        "Postgres url, solo mode (default: DATABASE_URL, else the embedded ledger)",
      )
      .option("--data-dir <path>", "embedded ledger folder, solo mode (default: ~/.selfhost/data)");

  async function run(
    options: NotifyOptions,
    action: (backend: Backend, io: NotifyIo) => Promise<void>,
  ): Promise<void> {
    const io = deps();
    try {
      const backend = teamBackend(io) ?? (await laptopBackend(io, options));
      try {
        await action(backend, io);
      } finally {
        await backend.close();
      }
    } catch (error) {
      fail(error, options.json);
    }
  }

  const show = (io: NotifyIo, backend: Backend, settings: NotifySettings, json?: boolean) => {
    if (json) io.write(JSON.stringify({ schema: "selfhost.notify/v1", ...settings }, null, 2));
    else for (const line of settingsText(settings, backend.where)) io.write(line);
  };

  withLedger(
    notify
      .command("list", { isDefault: true })
      .description("your targets (masked), digest cadence and how they are delivered"),
  ).action((options: NotifyOptions) =>
    run(options, async (backend, io) => show(io, backend, await backend.settings(), options.json)),
  );

  withLedger(
    notify
      .command("add")
      .description("add an Apprise URL, like tgram://<bot token>/<chat id>; - reads it from stdin")
      .argument(
        "<apprise-url>",
        "the target, or - to read it from stdin and keep it out of shell history",
      )
      .option("--name <name>", "a name for it (default: its service, like tgram)"),
  ).action((value: string, options: NotifyOptions & { name?: string }) =>
    run(options, async (backend, io) => {
      refuseAgent("selfhost notify add", io.env);
      checkName(options.name);
      const url = (value === "-" ? await io.readStdin() : value).trim();
      const problem = urlProblem(url);
      if (problem) throw new Error(`<apprise-url>: ${problem}`);
      const settings = await backend.add(url, options.name);
      if (options.json) return show(io, backend, settings, true);
      const added = settings.targets.at(-1);
      io.write(
        `Added ${added?.name ?? "the target"} (${added?.masked ?? "masked"}) on ${backend.where}.`,
      );
      io.write("Check it with selfhost notify test.");
    }),
  );

  withLedger(
    notify.command("remove").description("remove a target").argument("<name>", "the target's name"),
  ).action((name: string, options: NotifyOptions) =>
    run(options, async (backend, io) => {
      refuseAgent("selfhost notify remove", io.env);
      const settings = await backend.remove(name);
      if (options.json) return show(io, backend, settings, true);
      io.write(`Removed ${name}.`);
    }),
  );

  withLedger(
    notify
      .command("test")
      .description("send a test message to each of your targets")
      .option("--name <name>", "only this target"),
  ).action((options: NotifyOptions & { name?: string }) =>
    run(options, async (backend, io) => {
      checkName(options.name);
      const sends = await backend.test(options.name);
      if (options.json)
        io.write(JSON.stringify({ schema: "selfhost.notify_test/v1", sends }, null, 2));
      else if (sends.length === 0)
        io.write("No targets yet. Add one with selfhost notify add <apprise-url>.");
      else {
        for (const send of sends) {
          io.write(
            send.ok
              ? `${send.target}: sent`
              : `${send.target}: failed: ${send.error ?? "no reason given"}`,
          );
        }
      }
      if (sends.some((send) => !send.ok)) io.setExitCode(1);
    }),
  );

  withLedger(
    notify
      .command("digest")
      .description("how often your digest of review items comes: daily, weekly or off")
      .argument("<cadence>", NOTIFY_CADENCES.join(", ")),
  ).action((cadence: string, options: NotifyOptions) =>
    run(options, async (backend, io) => {
      if (!(NOTIFY_CADENCES as readonly string[]).includes(cadence)) {
        throw new Error(
          `<cadence>: expected one of ${NOTIFY_CADENCES.join(", ")}, got "${cadence}"`,
        );
      }
      const settings = await backend.digest(cadence as NotifyCadence);
      if (options.json) return show(io, backend, settings, true);
      io.write(
        cadence === "off"
          ? "Digest off. Agents that wait on you are still pushed at once."
          : `Digest: ${cadence}. Agents that wait on you are pushed at once; the rest comes in it.`,
      );
    }),
  );
}

/**
 * Adding or removing a target decides where a person's summaries go, so an agent session may
 * not. Stdin may be a pipe here (add - reads the URL from it), so only the agent check applies.
 */
function refuseAgent(what: string, env: Readonly<Record<string, string | undefined>>): void {
  const marker = agentSessionVariable(env);
  if (marker !== undefined) {
    throw new Error(
      `${what} is a person's decision, and this runs inside a coding agent session (${marker} is set), so it was refused. Run it yourself in a terminal outside the agent.`,
    );
  }
}
