import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { databaseOf, openLedger } from "@selfhost/ledger";
import { notifyStore } from "@selfhost/notify";
import { EVENT_SCHEMA, type LedgerEvent } from "@selfhost/schema";
import { describe, expect, it, vi } from "vitest";
import { runImport, startLaptopNotify } from "../src/import.js";
import { watchInbox } from "../src/inbox/sync.js";
import { localReviewList } from "../src/review-list.js";
import { run, tempDir } from "./run.js";

const PHONE = "tgram://123456:BOTSECRET/987";
const NOW = new Date("2026-11-20T12:00:00.000Z");

/**
 * A stand-in for the apprise command: it appends the URL it was given in APPRISE_URLS and its
 * arguments to $LOG, and fails for URLs on fail.example.com.
 */
function fakeApprise() {
  const dir = tempDir("apprise");
  const log = dir.path("sent.log");
  dir.write(
    "bin/apprise",
    [
      "#!/bin/sh",
      'printf "%s|%s\\n" "$APPRISE_URLS" "$*" >> "$LOG"',
      'case "$APPRISE_URLS" in *fail.example.com*) echo "ERROR - Failed to send to $APPRISE_URLS" >&2; exit 1 ;; esac',
      "",
    ].join("\n"),
    0o755,
  );
  return {
    bin: dir.path("bin"),
    log,
    lines: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

function laptop(path = tempDir("empty-bin").root) {
  const data = tempDir("data");
  return {
    env: { PATH: path, SELFHOST_PERSON: "dev@example.com" } as NodeJS.ProcessEnv,
    flags: ["--data-dir", data.root],
    dataDir: data.root,
  };
}

describe("selfhost notify on a laptop", () => {
  it("refuses to add or remove a target inside a coding agent session", async () => {
    const { env, flags } = laptop();
    const agent = { ...env, CLAUDECODE: "1" };
    for (const args of [
      ["add", PHONE],
      ["remove", "phone"],
    ]) {
      const result = await run(["notify", ...args, ...flags], { env: agent });
      expect(result.code, args[0]).toBe(1);
      expect(result.err).toContain("CLAUDECODE is set");
    }
    expect((await run(["notify", "--json", ...flags], { env })).out).toContain('"targets": []');
  });

  it("keeps targets in the local ledger and never prints their URLs", async () => {
    const { env, flags } = laptop();
    const empty = await run(["notify", ...flags], { env });
    expect(empty.out).toContain("No targets yet");

    const added = await run(["notify", "add", PHONE, "--name", "phone", ...flags], { env });
    expect(added.code).toBe(0);
    expect(added.out).toContain("Added phone (tgram://****) on this laptop.");

    const listed = await run(["notify", "list", "--json", ...flags], { env });
    expect(JSON.parse(listed.out)).toMatchObject({
      schema: "selfhost.notify/v1",
      person: "dev@example.com",
      targets: [{ name: "phone", service: "tgram", masked: "tgram://****" }],
      digest: "daily",
      digest_set: false,
      delivery: "none",
    });
    const all = [empty, added, listed].map((r) => r.out + r.err).join("\n");
    expect(all).not.toContain("BOTSECRET");

    expect(
      (await run(["notify", "add", PHONE, "--name", "phone", ...flags], { env })).err,
    ).toContain("already have a target named phone");
    expect((await run(["notify", "add", "not-a-url", ...flags], { env })).code).toBe(1);

    const weekly = await run(["notify", "digest", "weekly", ...flags], { env });
    expect(weekly.out).toContain("Digest: weekly.");
    expect((await run(["notify", "digest", "hourly", ...flags], { env })).code).toBe(1);

    expect((await run(["notify", "remove", "phone", ...flags], { env })).out).toBe(
      "Removed phone.",
    );
  });

  it("says so in one line when the apprise command is not installed", async () => {
    const { env, flags } = laptop();
    await run(["notify", "add", PHONE, ...flags], { env });
    const test = await run(["notify", "test", ...flags], { env });
    expect(test.code).toBe(1);
    expect(test.err).toContain("pipx install apprise");
  });

  it("sends a test through the apprise command, with the URL out of its arguments", async () => {
    const apprise = fakeApprise();
    const { env, flags } = laptop(apprise.bin);
    const withLog = { ...env, LOG: apprise.log };
    await run(["notify", "add", PHONE, "--name", "phone", ...flags], { env: withLog });
    await run(
      ["notify", "add", "mailtos://dev:MAILPASS@fail.example.com", "--name", "email", ...flags],
      {
        env: withLog,
      },
    );
    const test = await run(["notify", "test", ...flags], { env: withLog });
    expect(test.out).toContain("phone: sent");
    expect(test.out).toContain(
      "email: failed: apprise exited with 1: ERROR - Failed to send to mailtos://****",
    );
    expect(test.out).not.toContain("MAILPASS");
    expect(test.code).toBe(1);
    const [first] = apprise.lines().filter((line) => line.startsWith(PHONE));
    expect(first?.split("|")[1]).toBe(
      "-t selfhost: test notification -b This target works. Alerts and digests for dev@example.com will arrive here.",
    );
  });
});

describe("selfhost notify on a team", () => {
  it("adds targets on the team server and prints them masked", async () => {
    const config = tempDir("team-config");
    const configPath = config.write(
      "config.json",
      JSON.stringify({
        server: "https://selfhost.example.com",
        token: "selfhost_pt_test",
        person: "dev@example.com",
        team: "web",
      }),
    );
    const requests: { url: string; method?: string; body?: unknown }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      requests.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json(
        {
          person: "dev@example.com",
          targets: [
            {
              name: "tgram",
              service: "tgram",
              masked: "tgram://****",
              created_at: NOW.toISOString(),
            },
          ],
          digest: "daily",
          digest_set: false,
          delivery: "apprise_api",
        },
        { status: 201 },
      );
    };
    const added = await run(["notify", "add", PHONE], { configPath, fetch });
    expect(added.code).toBe(0);
    expect(added.out).toContain(
      "Added tgram (tgram://****) on team web on https://selfhost.example.com.",
    );
    expect(added.out).not.toContain("BOTSECRET");
    expect(requests).toEqual([
      {
        url: "https://selfhost.example.com/v1/notify/targets",
        method: "POST",
        body: { url: PHONE },
      },
    ]);
  });
});

let n = 0;
const cost = (usd: number): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  ts: "2026-11-20T10:00:00.000Z",
  source: "local_log",
  kind: "cost.recorded",
  actor: { kind: "person", id: "dev@example.com" },
  session_id: `s-${n}`,
  agent: { vendor: "claude_code" },
  cost: {
    input_tokens: 1,
    output_tokens: 1,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    usd,
    estimated: true,
  },
});

describe("budget alerts on a solo laptop", () => {
  it("raises the highest share crossed from the local ledger on import, once, and sends it", async () => {
    const repo = tempDir("repo");
    repo.write("selfhost.toml", "version = 1\n[budget]\ndaily_usd = 1\n");
    const logs = tempDir("logs");
    mkdirSync(logs.path("claude"), { recursive: true });
    mkdirSync(logs.path("codex"), { recursive: true });
    const apprise = fakeApprise();
    const ledger = await openLedger({ dataDir: "memory://" });
    const lines: string[] = [];
    const io = {
      env: { PATH: apprise.bin, LOG: apprise.log },
      cwd: repo.root,
      now: NOW,
      write: (line: string) => lines.push(line),
      configPath: tempDir("config").path("config.json"),
    };
    const options = {
      person: "dev@example.com",
      claudeDir: logs.path("claude"),
      codexDir: logs.path("codex"),
      spoolDir: logs.path("spool"),
    };
    try {
      await ledger.append([cost(0.6)]);
      const first = await runImport(options, io, ledger);
      expect(first.notify?.budget_alerts).toEqual(["You spent 50% of the day's budget of $1"]);
      expect(lines).toContain("Budget alert: You spent 50% of the day's budget of $1");

      // No targets yet, so nothing was sent. A target added later gets what is raised after
      // it, not the 50% alert from before; spend that jumps past 80% and 100% raises 100% only.
      const added = new Date(NOW.getTime() + 60_000);
      await notifyStore(databaseOf(ledger)).addTarget("dev@example.com", "phone", PHONE, added);
      await ledger.append([cost(0.6)]);
      const later = { ...io, now: new Date(NOW.getTime() + 120_000) };
      const second = await runImport(options, later, ledger);
      expect(second.notify?.budget_alerts).toEqual([
        "You went over the day's budget of $1: $1.2 spent, $0.2 over",
      ]);
      expect(second.notify?.sent).toBe(1);
      // Each message's first line is its URL and title; the body follows on its own lines.
      expect(apprise.lines().filter((line) => line.startsWith(`${PHONE}|-t `))).toHaveLength(1);

      const third = await runImport(options, later, ledger);
      expect(third.notify).toBeUndefined();

      const alerts = (await ledger.query({ kind: "alert.raised" })).events;
      expect(alerts.map((a) => [a.source, a.actor.id, a.data?.owner])).toEqual(
        Array(2).fill(["cli", "selfhost", "dev@example.com"]),
      );
    } finally {
      await ledger.close();
    }
  });

  it("skips sending with a one-line note when apprise is not on PATH", async () => {
    const repo = tempDir("repo");
    repo.write("selfhost.toml", "version = 1\n[budget]\ndaily_usd = 1\n");
    const ledger = await openLedger({ dataDir: "memory://" });
    const lines: string[] = [];
    try {
      await notifyStore(databaseOf(ledger)).addTarget("dev@example.com", "phone", PHONE);
      await ledger.append([cost(2)]);
      const report = await runImport(
        {
          person: "dev@example.com",
          claudeDir: tempDir("c").root,
          codexDir: tempDir("x").root,
          spoolDir: tempDir("s").root,
        },
        {
          env: { PATH: tempDir("bin").root },
          cwd: repo.root,
          now: NOW,
          write: (l) => lines.push(l),
          configPath: tempDir("cfg").path("config.json"),
        },
        ledger,
      );
      expect(report.notify?.budget_alerts).toHaveLength(1);
      expect(report.notify?.skipped).toBe(
        "Notifications skipped: the apprise command is not on PATH (install it with pipx install apprise).",
      );
      expect(lines.filter((line) => line.startsWith("Notifications skipped"))).toHaveLength(1);
    } finally {
      await ledger.close();
    }
  });
});

describe("pushes from selfhost import --watch on a solo laptop", () => {
  it("pushes an item an agent waits on with no later batch of events, after the list refresh", async () => {
    const repo = tempDir("repo");
    repo.write("selfhost.toml", "version = 1\n");
    const apprise = fakeApprise();
    const ledger = await openLedger({ dataDir: "memory://" });
    const configPath = tempDir("config").path("config.json");
    const lines: string[] = [];
    const env = { PATH: apprise.bin, LOG: apprise.log, SELFHOST_PERSON: "dev@example.com" };
    const io = { env, cwd: repo.root, write: (line: string) => lines.push(line), configPath };
    const inbox = await watchInbox(ledger, {
      membership: undefined,
      person: "dev@example.com",
      configPath,
      fetch: async () => {
        throw new Error("no server in solo mode");
      },
      localReviewList: localReviewList({ ...io, cwd: repo.root }),
      write: io.write,
    });
    if (!inbox) throw new Error("no inbox refresh");
    const refreshNow = vi.spyOn(inbox, "refreshNow");
    const notifier = startLaptopNotify(ledger, "dev@example.com", io, {
      intervalMs: 20,
      refresh: () => inbox.refreshNow(),
    });
    try {
      await notifyStore(databaseOf(ledger)).addTarget(
        "dev@example.com",
        "phone",
        PHONE,
        new Date(Date.now() - 60_000),
      );
      // The agent asks and then waits: this is the last event until someone answers.
      await ledger.append([
        {
          id: "01930c4e-2f1a-7b2c-9d3e-00000000a001",
          schema: EVENT_SCHEMA,
          ts: new Date().toISOString(),
          source: "hook",
          kind: "approval.requested",
          actor: { kind: "person", id: "dev@example.com" },
          session_id: "waiting-session",
          agent: { vendor: "claude_code" },
          data: { message: "Claude needs your permission to use Bash" },
        },
      ]);
      // Nobody calls kick(): the timer alone sends the push.
      await vi.waitFor(
        () => expect(apprise.lines().some((line) => line.includes("an agent waits"))).toBe(true),
        { timeout: 10_000 },
      );
      expect(refreshNow).toHaveBeenCalled();
      expect(lines).toContain("Notifications: 1 sent, 0 failed.");
    } finally {
      await notifier.close();
      await inbox.close();
      await ledger.close();
    }
  });
});
