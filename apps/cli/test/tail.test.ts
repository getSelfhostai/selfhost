import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  type CreateTeamResponse,
  EVENT_SCHEMA,
  type JoinResponse,
  type LedgerEvent,
  type ReviewItem,
} from "@selfhost/schema";
import { createApp } from "@selfhost/server/app";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startMonitor } from "../src/alerts/monitor.js";
import { appendToSpool, spoolDir } from "../src/hooks/receive.js";
import { createProgram } from "../src/program.js";
import {
  parseKinds,
  REVIEW_POLL_MS,
  runTail,
  type TailCommandOptions,
} from "../src/tail/command.js";
import { FeedReader, feedDir, readWatcher, startFeed } from "../src/tail/feed.js";
import type { TailLine } from "../src/tail/line.js";
import { tempDir } from "./run.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");
const SESSION = "5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87";

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  ts: "2026-11-09T10:00:00.000Z",
  source: "hook",
  actor: { kind: "person", id: "ada@example.com" },
  agent: { vendor: "claude_code" },
  session_id: SESSION,
  ...fields,
});

const cost = (read: number, write: number, extra: Partial<LedgerEvent> = {}) =>
  event({
    kind: "cost.recorded",
    source: "local_log",
    model: "claude-sonnet-4-5",
    cost: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: read,
      cache_write_tokens: write,
      usd: 0.25,
      estimated: true,
    },
    ...extra,
  });

/**
 * Runs the tail with a scripted clock: each sleep runs the next step (a batch landing), and the
 * tail stops once the script is done. Nothing waits on real time.
 */
async function tail(
  options: TailCommandOptions,
  home: ReturnType<typeof tempDir>,
  steps: (() => Promise<unknown> | unknown)[],
  extra: { fetch?: (url: string, init: RequestInit) => Promise<Response> } = {},
) {
  const out: string[] = [];
  const notes: string[] = [];
  const controller = new AbortController();
  const script = [...steps];
  await runTail(options, {
    env: { HOME: home.root, SELFHOST_PERSON: "ada@example.com" },
    write: (line) => out.push(line),
    note: (line) => notes.push(line),
    configPath: home.path(".selfhost", "config.json"),
    now: () => new Date("2026-11-09T12:00:00Z"),
    ...(extra.fetch ? { fetch: extra.fetch } : {}),
    signal: controller.signal,
    serverWaitSeconds: 0,
    sleep: async (ms) => {
      // The review list poll runs beside the events; only the events' polls step the script.
      if (ms === REVIEW_POLL_MS) return new Promise((resolve) => setTimeout(resolve, 2));
      const step = script.shift();
      if (step) await step();
      else controller.abort();
    },
  });
  return { out, notes };
}

describe("selfhost tail options", () => {
  it("is a command of the program with the filters", () => {
    const command = createProgram().commands.find((c) => c.name() === "tail");
    expect(command?.options.map((o) => o.long)).toEqual([
      "--agent",
      "--repo",
      "--person",
      "--kind",
      "--session",
      "--run",
      "--since",
      "--json",
      "--local",
      "--database",
      "--data-dir",
    ]);
  });

  it("takes event kinds, their first part and review", () => {
    expect(parseKinds("tool, policy.evaluated,review")).toEqual([
      "tool",
      "policy.evaluated",
      "review",
    ]);
    expect(() => parseKinds("tools")).toThrow(/--kind: unknown tools/);
  });
});

describe("selfhost tail on a laptop with import --watch running", () => {
  let ledger: Ledger;
  let home: ReturnType<typeof tempDir>;

  beforeEach(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    home = tempDir("tail-home");
  });

  afterEach(async () => {
    await ledger.close();
  });

  it("follows the watcher's feed without opening the ledger, one line per event", async () => {
    const dir = feedDir({}, home.path(".selfhost", "config.json"));
    const feed = startFeed(dir, { now: () => new Date("2026-11-09T12:00:00Z") });
    const writer = feed.tap(ledger);
    // Before the tail starts: not shown.
    await writer.append([event({ kind: "session.started", repo: "acme/api" })]);
    const { out, notes } = await tail({}, home, [
      () =>
        writer.append([
          event({ kind: "prompt.submitted", data: { prompt: "ship the secret plan" } }),
          event({
            kind: "tool.called",
            tool: { name: "Bash", input_summary: "git push --force origin main" },
          }),
          event({
            kind: "policy.evaluated",
            actor: { kind: "system", id: "selfhost-policy" },
            tool: { name: "Bash" },
            decision: { verdict: "block", rule_id: "guard.force_push", mode: "enforce" },
          }),
          cost(0, 9000),
          cost(9000, 0),
        ]),
      // The same batch again: the ledger reports duplicates, the tail prints nothing new.
      () => writer.append([cost(9000, 0, { id: "01930c4e-2f1a-7b2c-9d3e-0000000000ff" })]),
      () => writer.append([cost(9000, 0, { id: "01930c4e-2f1a-7b2c-9d3e-0000000000ff" })]),
    ]);
    feed.close();
    const link = `http://127.0.0.1:4400/runs/${SESSION}`;
    expect(out).toEqual([
      `10:00:00  ada@example.com  claude_code  prompt  ${link}`,
      `10:00:00  ada@example.com  claude_code  tool Bash: git push --force origin main  ${link}`,
      `10:00:00  selfhost-policy  claude_code  BLOCKED guard.force_push on Bash  ${link}`,
      `10:00:00  ada@example.com  claude_code  cost $0.25 claude-sonnet-4-5, 9.2k tokens, cache 0%  ${link}`,
      `10:00:00  ada@example.com  claude_code  cost $0.25 claude-sonnet-4-5, 9.2k tokens, cache 49%  ${link}`,
      `10:00:00  ada@example.com  claude_code  cost $0.25 claude-sonnet-4-5, 9.2k tokens, cache 66%  ${link}`,
    ]);
    expect(out.join("\n")).not.toContain("secret plan");
    expect(notes).toEqual(["Tailing this laptop. Press Ctrl-C to stop."]);
    expect(readWatcher(dir)).toBeUndefined();
  });

  it("narrows by kind, agent, person and repo, and prints JSON lines", async () => {
    const dir = feedDir({}, home.path(".selfhost", "config.json"));
    const feed = startFeed(dir);
    const writer = feed.tap(ledger);
    const batch = [
      event({ kind: "session.started", repo: "acme/api" }),
      event({ kind: "tool.called", tool: { name: "Edit", input_summary: "src/app.ts" } }),
      event({
        kind: "tool.called",
        session_id: "codex-1",
        agent: { vendor: "codex" },
        actor: { kind: "person", id: "bo@example.com" },
        tool: { name: "shell", input_summary: "ls" },
      }),
      cost(0, 9000),
    ];
    const lines = async (options: TailCommandOptions) =>
      (await tail({ json: true, since: "1d", ...options }, home, [])).out.map(
        (line) => JSON.parse(line) as TailLine,
      );
    await writer.append(batch);
    const all = await lines({});
    expect(all).toHaveLength(4);
    expect(all[3]).toEqual({
      schema: "selfhost.tail_line/v1",
      ts: "2026-11-09T10:00:00.000Z",
      kind: "cost.recorded",
      id: batch[3]?.id,
      who: "ada@example.com",
      person: "ada@example.com",
      agent: "claude_code",
      model: "claude-sonnet-4-5",
      repo: "acme/api",
      session_id: SESSION,
      run_id: null,
      tool: null,
      input: null,
      verdict: null,
      rule_id: null,
      mode: null,
      usd: 0.25,
      tokens: 9150,
      cache_hit_rate: 0,
      message: null,
      run_url: `http://127.0.0.1:4400/runs/${SESSION}`,
    });
    expect((await lines({ kind: "tool" })).map((l) => l.tool)).toEqual(["Edit", "shell"]);
    expect((await lines({ agent: "codex" })).map((l) => l.tool)).toEqual(["shell"]);
    expect((await lines({ person: "bo@example.com" })).map((l) => l.who)).toEqual([
      "bo@example.com",
    ]);
    // The cost event has no repo of its own: the feed adds its run's.
    expect((await lines({ repo: "acme/api" })).map((l) => l.kind)).toEqual([
      "session.started",
      "tool.called",
      "cost.recorded",
    ]);
    feed.close();
  });

  it("prints the cache alert the watcher raises when a session's hit rate collapses", async () => {
    const configPath = home.path(".selfhost", "config.json");
    const feed = startFeed(feedDir({}, configPath));
    const monitor = await startMonitor(ledger, {
      person: "ada@example.com",
      env: {},
      configPath,
      cwd: home.root,
      write: () => {},
      cachePath: home.path("statusline.json"),
      now: () => new Date("2026-11-09T10:40:00Z"),
      minIntervalMs: 0,
    });
    const writer = monitor.tap(feed.tap(ledger));
    const minute = (i: number) => new Date(Date.UTC(2026, 10, 9, 10, i)).toISOString();
    const warm = Array.from({ length: 10 }, (_, i) =>
      cost(i === 0 ? 0 : 9000, i === 0 ? 9000 : 0, { ts: minute(i) }),
    );
    const cold = Array.from({ length: 15 }, (_, i) => cost(0, 9000, { ts: minute(10 + i) }));
    const { out } = await tail({ kind: "alert" }, home, [
      async () => {
        await writer.append([...warm, ...cold]);
        monitor.check();
        await new Promise((resolve) => setTimeout(resolve, 30));
        await monitor.close();
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(
      /^10:40:00 {2}selfhost {2}claude_code {2}ALERT Prompt cache hit rate of session 5f0c2b1e .* fell to 0%/,
    );
    const alerts = (await ledger.query({ kind: "alert.raised" })).events;
    expect(alerts.map((a) => a.data?.alert)).toEqual(["cache_hit_low"]);
    feed.close();
  });
});

describe("selfhost tail on a laptop with no watcher", () => {
  it("follows the hook spool itself and shows new review items from the inbox copy", async () => {
    const home = tempDir("tail-spool");
    const spool = spoolDir({ HOME: home.root }) ?? "";
    const hook = JSON.parse(
      readFileSync(join(FIXTURES, "hooks", "claude-code", "PreToolUse.json"), "utf8"),
    );
    const now = new Date("2026-11-09T11:59:00Z");
    // Already in the spool when the tail starts: skipped.
    appendToSpool(spool, "claude", { ...hook, tool_use_id: "toolu_old" }, now);
    const inbox = home.path(".selfhost", "inbox.json");
    const item = (id: string, title: string): ReviewItem =>
      ({
        id,
        schema: "selfhost.review_item/v1",
        kind: "approval",
        title,
        created_at: "2026-11-09T11:59:30.000Z",
        updated_at: "2026-11-09T11:59:30.000Z",
        state: "open",
        blocking: true,
        risk: { score: 80, reasons: [] },
        owners: ["ada@example.com"],
        session_id: SESSION,
        source_event_ids: [],
      }) as unknown as ReviewItem;
    const writeInbox = (items: ReviewItem[]) =>
      writeFileSync(
        inbox,
        JSON.stringify({
          schema: "selfhost.inbox_cache/v1",
          written_at: now.toISOString(),
          pid: null,
          server: null,
          team: null,
          person: "ada@example.com",
          all: false,
          items,
          snoozed: {},
        }),
      );
    writeInbox([item("01930c4e-2f1a-7b2c-9d3e-00000000aaaa", "Old item")]);
    const { out, notes } = await tail({ dataDir: home.path("no-ledger") }, home, [
      () => appendToSpool(spool, "claude", hook, now),
      () =>
        writeInbox([
          item("01930c4e-2f1a-7b2c-9d3e-00000000aaaa", "Old item"),
          item("01930c4e-2f1a-7b2c-9d3e-00000000bbbb", "Approve git push --force for acme/api"),
        ]),
      () => {},
      () => {},
    ]);
    expect(notes).toContain(
      "No selfhost import --watch is running: showing hook events from the spool. Start it to see model costs too.",
    );
    expect(out).toEqual([
      expect.stringMatching(/ {2}tool Bash: git add src\/app\.ts .*\/runs\/665bce74/),
      expect.stringMatching(
        /^11:59:30 {2}ada@example\.com {2}- {2}review item opened, agent waiting: Approve git push --force for acme\/api {2}http:\/\/127\.0\.0\.1:4400\/runs\//,
      ),
    ]);
  });
});

describe("selfhost tail --since with no watcher", () => {
  it("reads the past from the embedded ledger once, then closes it", async () => {
    const home = tempDir("tail-since");
    const dataDir = home.path("data");
    const ledger = await openLedger({ dataDir });
    await ledger.append([
      event({ kind: "session.started", repo: "acme/api", ts: "2026-11-09T11:50:00.000Z" }),
      cost(0, 9000, { ts: "2026-11-09T11:51:00.000Z" }),
      event({ kind: "session.ended", ts: "2026-11-09T09:00:00.000Z" }),
    ]);
    await ledger.close();
    const { out } = await tail({ since: "30m", dataDir, kind: "session,cost" }, home, []);
    expect(out).toEqual([
      expect.stringMatching(/^11:50:00 .* session started /),
      expect.stringMatching(/^11:51:00 .* cost \$0\.25 .* cache 0% /),
    ]);
    // Closed again: another process can open it.
    const again = await openLedger({ dataDir });
    await again.close();
  });
});

describe("selfhost tail in a team", () => {
  it("streams from the server, only the person's teams, with links to the team console", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    try {
      const app = createApp({ version: "test", ledger, token: "admin-token" });
      const admin = (path: string, body?: unknown) =>
        app.request(path, {
          method: body ? "POST" : "GET",
          headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      const team = async (name: string) =>
        (await (await admin("/v1/teams", { name })).json()) as CreateTeamResponse;
      const join = async (invite: string, person: string) =>
        (
          (await (
            await app.request("/v1/join", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ invite, person }),
            })
          ).json()) as JoinResponse
        ).token;
      const web = await team("Web");
      const data = await team("Data");
      const ada = await join(web.invite, "ada@example.com");
      const dora = await join(data.invite, "dora@example.com");
      const server = "https://selfhost.acme.example.com";
      const fetch = (url: string, init: RequestInit) =>
        Promise.resolve(app.request(url.replace(server, ""), init));
      const push = (token: string, events: LedgerEvent[]) =>
        app.request("/v1/events", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ events }),
        });

      const home = tempDir("tail-team");
      home.write(
        ".selfhost/config.json",
        JSON.stringify({ server, token: ada, person: "ada@example.com", team: "web" }),
      );
      const { out } = await tail(
        { kind: "tool,policy" },
        home,
        [
          async () => {
            await push(ada, [
              event({ kind: "tool.called", tool: { name: "Bash", input_summary: "npm test" } }),
              event({ kind: "session.started" }),
            ]);
            await push(dora, [
              event({
                kind: "tool.called",
                actor: { kind: "person", id: "dora@example.com" },
                session_id: "data-run",
                tool: { name: "Bash", input_summary: "dbt run" },
              }),
            ]);
          },
          () => {},
        ],
        { fetch },
      );
      expect(out).toEqual([
        `10:00:00  ada@example.com  claude_code  tool Bash: npm test  ${server}/runs/${SESSION}`,
      ]);
    } finally {
      await ledger.close();
    }
  });
});

describe("the feed", () => {
  it("is written for this user only, keeps two days and survives a cut-off line", async () => {
    const home = tempDir("feed");
    const dir = home.path("feed");
    let clock = new Date("2026-11-07T10:00:00Z");
    const feed = startFeed(dir, { now: () => clock });
    const sink = {
      append: async (events: LedgerEvent[]) => ({
        accepted: events.map((e) => e.id),
        duplicates: [],
      }),
    };
    const writer = feed.tap(sink);
    await writer.append([event({ kind: "session.started" })]);
    clock = new Date("2026-11-09T10:00:00Z");
    await writer.append([event({ kind: "session.ended" })]);
    // The day before yesterday's file is gone; today's is this user's only.
    expect(readdirSync(dir).sort()).toEqual(["events-2026-11-09.jsonl", "watcher.json"]);
    expect(statSync(join(dir, "events-2026-11-09.jsonl")).mode & 0o777).toBe(0o600);
    const reader = new FeedReader(dir);
    expect(reader.read().map((e) => e.kind)).toEqual(["session.ended"]);
    writeFileSync(join(dir, "events-2026-11-09.jsonl"), '{"id":', { flag: "a" });
    expect(reader.read()).toEqual([]);
    feed.close();
  });
});
