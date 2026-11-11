import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeProjectName } from "@selfhost/importers";
import { type Ledger, openLedger } from "@selfhost/ledger";
import {
  type CreateTeamResponse,
  EVENT_SCHEMA,
  type JoinResponse,
  type LedgerEvent,
} from "@selfhost/schema";
import { createApp } from "@selfhost/server/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plantedValues, readPlanted } from "../../../fixtures/redaction/planted.js";
import { type HandoffIo, runHandoff, runShare, runTakeover } from "../src/handoff/commands.js";
import {
  changedFiles,
  checkoutBranch,
  type Git,
  systemGit,
  workState,
} from "../src/handoff/git.js";
import type { InboxReport } from "../src/inbox/commands.js";
import { run } from "./run.js";

/** A folder kept for the whole describe: run.js's tempDir is emptied after each test. */
function keptDir(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `selfhost-cli-${prefix}-`));
  const path = (...parts: string[]) => join(root, ...parts);
  return {
    root,
    path,
    write(relative: string, content: string) {
      const file = path(relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      return file;
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

const SERVER = "https://selfhost.acme.example.com";
const SESSION = "5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87";
const CODEX_SESSION = "019a5b01-0c3d-7e2f-8a10-2b3c4d5e6f70";
const BRANCH = "agent/rate-limits";
// Every event is dated against this clock, so nothing here depends on the day the tests run.
const NOW = new Date("2026-11-11T12:00:00Z");

const POLICY = `version = 1

[[redaction]]
name = "ticket"
pattern = "ACME-\\\\d+"

[handoff]
share_transcript = true
`;

let n = 0;
const event = (fields: Partial<LedgerEvent> & Pick<LedgerEvent, "kind" | "ts">): LedgerEvent => ({
  id: `01930c4e-2f1a-7b2c-9d3e-${(++n).toString(16).padStart(12, "0")}`,
  schema: EVENT_SCHEMA,
  source: "hook",
  actor: { kind: "person", id: "ana@example.com" },
  agent: { vendor: "claude_code", version: "2.1.0" },
  session_id: SESSION,
  repo: "acme/api",
  ...fields,
});

/** Real git over local repositories; origin reads as the GitHub repo the run worked in. */
const git: Git = (dir, args) =>
  args[0] === "remote" && args[1] === "get-url"
    ? "https://github.com/acme/api.git"
    : systemGit(dir, args);

const sh = (dir: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

describe("handing a run over and taking it over, two people on two machines", () => {
  let ledger: Ledger;
  let fetch: (url: string, init: RequestInit) => Promise<Response>;
  const root = keptDir("handoff");
  const anaHome = keptDir("handoff-ana");
  const benHome = keptDir("handoff-ben");
  const origin = root.path("origin.git");
  const anaClone = root.path("ana", "api");
  const benClone = root.path("ben", "api");
  let tokens: Record<"ana" | "ben", string>;
  let handoffId = "";

  const io = (who: "ana" | "ben", cwd: string, extra: Partial<HandoffIo> = {}) => {
    const out: string[] = [];
    const home = who === "ana" ? anaHome : benHome;
    return {
      out,
      io: {
        env: {},
        cwd,
        write: (line: string) => out.push(line),
        setExitCode: () => {},
        configPath: home.path(".selfhost", "config.json"),
        fetch,
        home: home.root,
        git,
        now: NOW,
        ...extra,
      } satisfies HandoffIo,
    };
  };

  beforeAll(async () => {
    ledger = await openLedger({ dataDir: "memory://" });
    const app = createApp({
      version: "test",
      ledger,
      token: "admin-token",
      now: () => NOW,
      github: { publicUrl: SERVER },
    });
    fetch = (url, init) => Promise.resolve(app.request(url.replace(SERVER, ""), init));
    const admin = (path: string, method: string, body: unknown) =>
      app.request(path, {
        method,
        headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const web = (await (
      await admin("/v1/teams", "POST", { name: "Web" })
    ).json()) as CreateTeamResponse;
    const join = async (person: string) => {
      const res = await app.request("/v1/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite: web.invite, person }),
      });
      return ((await res.json()) as JoinResponse).token;
    };
    await join("olga@example.com");
    tokens = { ana: await join("ana@example.com"), ben: await join("ben@example.com") };
    expect((await admin("/v1/policy?team=web", "PUT", { text: POLICY })).status).toBe(200);
    for (const [who, home] of [
      ["ana", anaHome],
      ["ben", benHome],
    ] as const) {
      home.write(
        ".selfhost/config.json",
        JSON.stringify({
          server: SERVER,
          token: tokens[who],
          person: `${who}@example.com`,
          team: "web",
        }),
      );
    }

    // Ana's machine: the run's branch is pushed, one file is still uncommitted.
    sh(root.root, "init", "--bare", "--initial-branch=main", origin);
    sh(root.root, "clone", origin, anaClone);
    root.write("ana/api/README.md", "# api\n");
    sh(anaClone, "add", ".");
    sh(anaClone, "commit", "-m", "Start");
    sh(anaClone, "push", "-u", "origin", "HEAD:main");
    sh(anaClone, "switch", "-c", BRANCH);
    root.write("ana/api/src/limits.ts", "export const LIMIT = 100;\n");
    sh(anaClone, "add", ".");
    sh(anaClone, "commit", "-m", "Rate limits");
    sh(anaClone, "push", "-u", "origin", BRANCH);
    root.write("ana/api/notes.txt", "half done\n");
    sh(root.root, "clone", origin, benClone);

    // Ana's Claude Code transcript of the session, with secrets in it.
    const project = claudeProjectName(anaClone) ?? "";
    anaHome.write(
      `.claude/projects/${project}/${SESSION}.jsonl`,
      readPlanted("events-with-secrets.jsonl"),
    );

    const events = [
      event({ kind: "session.started", ts: "2026-11-11T09:00:00.000Z", data: { cwd: anaClone } }),
      event({
        kind: "tool.called",
        ts: "2026-11-11T09:01:00.000Z",
        tool: { name: "Edit", input_summary: "src/limits.ts" },
        target: { type: "file", value: "src/limits.ts" },
      }),
      // An edit that failed: the file never changed, so the brief does not list it.
      event({
        kind: "tool.called",
        ts: "2026-11-11T09:02:00.000Z",
        tool: { name: "Edit", input_summary: "src/ghost.ts" },
        target: { type: "file", value: "src/ghost.ts" },
      }),
      event({
        kind: "session.started",
        ts: "2026-11-11T10:00:00.000Z",
        session_id: CODEX_SESSION,
        agent: { vendor: "codex" },
      }),
    ];
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.ana}`, "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });
    expect(res.status).toBe(200);
  });

  afterAll(async () => {
    await ledger.close();
    for (const dir of [root, anaHome, benHome]) dir.remove();
  });

  it("is refused inside a coding agent session, before anything is sent", async () => {
    for (const command of [
      ["handoff", SESSION, "--to", "ben@example.com"],
      ["takeover", "01930c4e"],
    ]) {
      const result = await run(command, {
        env: { CLAUDECODE: "1" },
        configPath: anaHome.path(".selfhost", "config.json"),
        fetch,
      });
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/runs inside a coding agent session \(CLAUDECODE is set\)/);
    }
    expect(await ledger.handoffs.list()).toEqual([]);
  });

  it("hands the run over from Ana's clone with its branch, what did not travel and the masked transcript", async () => {
    const { io: anaIo, out } = io("ana", root.root);
    const report = await runHandoff(
      SESSION,
      { to: "ben@example.com", note: "Limits work; ticket ACME-4521 has the numbers" },
      anaIo,
    );
    handoffId = report.handoff.id;
    expect(report.transcript).toBe("sent");
    expect(report.handoff).toMatchObject({
      from: "ana@example.com",
      to: "ben@example.com",
      branch: BRANCH,
      commit: sh(anaClone, "rev-parse", "HEAD"),
      pushed: true,
      uncommitted: ["notes.txt"],
      // From git: the branch's commit and the file written outside any tool call.
      files: ["src/limits.ts", "notes.txt"],
      note: "Limits work; ticket [redacted:ticket] has the numbers",
      transcript: { vendor: "claude_code", file_name: `${SESSION}.jsonl`, redacted: true },
    });
    expect(report.warnings).toEqual([
      "1 file(s) have changes that are not committed; they stay on this machine.",
    ]);
    expect(out[0]).toBe("Handed Claude Code run 5f0c2b1e to ben@example.com.");
    expect(out.join("\n")).toContain(
      `ben@example.com takes it over with: selfhost takeover ${handoffId.slice(-8)}`,
    );
  });

  it("shows the handoff in Ben's inbox", async () => {
    const result = await run(["inbox", "--json"], {
      env: {},
      configPath: benHome.path(".selfhost", "config.json"),
      fetch,
      now: NOW,
    });
    const report = JSON.parse(result.out) as InboxReport;
    expect(report.handoffs?.map((h) => h.id)).toEqual([handoffId]);
    const text = await run(["inbox"], {
      env: {},
      configPath: benHome.path(".selfhost", "config.json"),
      fetch,
      now: NOW,
    });
    expect(text.out).toContain("Handed to you:");
    expect(text.out).toContain(`${handoffId.slice(-8)}  run 5f0c2b1e from ana@example.com`);
  });

  it("lets only Ben take it over", async () => {
    const { io: anaIo } = io("ana", anaClone);
    await expect(runTakeover(handoffId, {}, anaIo)).rejects.toThrow(
      /handed to ben@example.com; only they can take it over/,
    );
  });

  it("takes it over in Ben's clone: branch, brief kept out of commits, and Claude Code's own resume", async () => {
    const { io: benIo, out } = io("ben", benClone);
    const report = await runTakeover(handoffId.slice(0, 8), {}, benIo);
    expect(report.checkout).toEqual({ fetched: true, remote: "origin", switched: true });
    expect(sh(benClone, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(sh(benClone, "rev-parse", "HEAD")).toBe(report.handoff.commit);
    expect(report.handoff.state).toBe("taken");

    const brief = readFileSync(join(benClone, ".selfhost", "handoff", `${handoffId}.md`), "utf8");
    expect(brief).toContain("ana@example.com handed this run to ben@example.com");
    expect(brief).toContain("Limits work; ticket [redacted:ticket] has the numbers");
    expect(brief).toContain("- src/limits.ts");
    expect(brief).toContain("notes.txt");
    expect(brief).toContain(`claude --resume ${SESSION}`);
    expect(readFileSync(join(benClone, ".git", "info", "exclude"), "utf8")).toContain(
      "/.selfhost/handoff/",
    );
    expect(sh(benClone, "status", "--porcelain")).toBe("");

    // Agents name the directory as the system resolves it (git and getcwd agree on macOS).
    const real = realpathSync(benClone);
    const placed = join(
      benHome.root,
      ".claude",
      "projects",
      claudeProjectName(real) ?? "",
      `${SESSION}.jsonl`,
    );
    expect(report.transcript_path).toBe(placed);
    const text = readFileSync(placed, "utf8");
    for (const { value } of plantedValues()) expect(text).not.toContain(value);
    expect(text).toContain(`"cwd":"${real}"`);
    const cwds = text
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { cwd?: string }).cwd)
      .filter(Boolean);
    expect(new Set(cwds)).toEqual(new Set([real]));
    expect(report.resume).toMatchObject({ native: true });
    expect(out.at(-1)).toBe(
      `  claude --resume ${SESSION} "Read .selfhost/handoff/${handoffId}.md first: ana@example.com handed this run to you."`,
    );

    await expect(runTakeover(handoffId, {}, io("ben", benClone).io)).rejects.toThrow(
      /was taken over at/,
    );
  });

  it("shows the new owner on the run and prints its link", async () => {
    const { io: benIo, out } = io("ben", benClone);
    const shared = await runShare(SESSION, {}, benIo);
    expect(shared.url).toBe(`${SERVER}/?screen=run&run=${SESSION}`);
    expect(out[0]).toBe(shared.url);
    const read = await fetch(`${SERVER}/v1/runs/${SESSION}`, {
      method: "GET",
      headers: { authorization: `Bearer ${tokens.ben}` },
    });
    const body = (await read.json()) as { run: { owner: string } };
    expect(body.run.owner).toBe("ben@example.com");
  });

  it("makes the brief the handoff when no transcript goes with it", async () => {
    const handed = await runHandoff(
      CODEX_SESSION,
      { to: "ben@example.com", transcript: false, repo: anaClone },
      io("ana", anaClone).io,
    );
    expect(handed.transcript).toBe("declined");
    const { io: benIo, out } = io("ben", benClone);
    const report = await runTakeover(handed.handoff.id, { print: true }, benIo);
    expect(report.brief_path).toBeNull();
    expect(report.resume).toEqual({
      command: `codex "Read .selfhost/handoff/${handed.handoff.id}.md and carry on with the work it describes."`,
      native: false,
      why: expect.stringMatching(/^No native resume: the team does not share transcripts/),
    });
    expect(out.join("\n")).toContain(`# Handoff: Codex run ${CODEX_SESSION}`);
  });

  it("fetches from the remote the branch was pushed to, and tells same-minute handoffs apart", async () => {
    const team = root.path("team.git");
    const teamBranch = "ana/team-only";
    sh(root.root, "init", "--bare", "--initial-branch=main", team);
    sh(anaClone, "remote", "add", "team", team);
    sh(anaClone, "switch", "-c", teamBranch);
    root.write("ana/api/src/team.ts", "export const TEAM = true;\n");
    sh(anaClone, "add", "src/team.ts");
    sh(anaClone, "commit", "-m", "Team only");
    sh(anaClone, "push", "-u", "team", teamBranch);
    root.write("ana/api/selfhost.toml", "version = 1\n");
    const sessions = [
      "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "8b2e3d4c-5f6a-4b7c-9d8e-0f1a2b3c4d5e",
    ];
    const res = await fetch(`${SERVER}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.ana}`, "content-type": "application/json" },
      body: JSON.stringify({
        events: sessions.map((session) =>
          event({
            kind: "session.started",
            ts: "2026-11-11T11:00:00.000Z",
            session_id: session,
            data: { cwd: anaClone },
          }),
        ),
      }),
    });
    expect(res.status).toBe(200);

    const handed = [];
    for (const session of sessions) {
      const { io: anaIo, out } = io("ana", root.root);
      const report = await runHandoff(session, { to: "ben@example.com" }, anaIo);
      handed.push({ report, out });
    }
    const [first, second] = handed.map(({ report }) => report.handoff.id) as [string, string];
    // Made the same minute: their start is the same timestamp, so the CLI shows their end.
    expect(first.slice(0, 8)).toBe(second.slice(0, 8));
    expect(handed[0]?.report.handoff.remote).toEqual({ url: team, branch: teamBranch });
    expect(handed[0]?.report.warnings).toEqual([
      "1 file(s) have changes that are not committed; they stay on this machine.",
      "selfhost.toml is not committed yet (selfhost config, not work in progress): commit it so teammates and the new owner get the same rules.",
    ]);
    expect(handed[0]?.out.at(-1)).toBe(
      `ben@example.com takes it over with: selfhost takeover ${first.slice(-8)}`,
    );
    expect(handed[1]?.out.at(-1)).toBe(
      `ben@example.com takes it over with: selfhost takeover ${second.slice(-8)}`,
    );
    await expect(runTakeover(first.slice(0, 8), {}, io("ben", benClone).io)).rejects.toThrow(
      /2 pending handoffs start or end with/,
    );

    // Ben calls the team's remote "upstream", and origin does not have the branch.
    sh(benClone, "remote", "add", "upstream", team);
    const { io: benIo, out } = io("ben", benClone);
    const taken = await runTakeover(first.slice(-8), {}, benIo);
    expect(taken.checkout).toEqual({ fetched: true, remote: "upstream", switched: true });
    expect(sh(benClone, "rev-parse", "--abbrev-ref", "HEAD")).toBe(teamBranch);
    expect(sh(benClone, "rev-parse", "HEAD")).toBe(taken.handoff.commit);
    expect(out).toContain(`  On branch ${teamBranch}, fetched from upstream.`);

    // A clone with no remote that has it: the exact command to fetch it from where it went.
    const other = root.path("ben", "other");
    sh(root.root, "clone", origin, other);
    const lost = await runTakeover(second.slice(-8), { repo: other }, io("ben", other).io);
    expect(lost.checkout).toMatchObject({ fetched: false });
    expect(lost.warnings[0]).toContain(
      `git fetch ${team} ${teamBranch}:${teamBranch} && git switch ${teamBranch}`,
    );
  });
});

describe("the branch's git state at handoff and takeover", () => {
  const root = keptDir("handoff-git");
  const origin = root.path("origin.git");
  const team = root.path("team.git");
  const ana = root.path("ana");
  afterAll(() => root.remove());

  beforeAll(() => {
    sh(root.root, "init", "--bare", "--initial-branch=main", origin);
    sh(root.root, "init", "--bare", "--initial-branch=main", team);
    sh(root.root, "clone", origin, ana);
    root.write("ana/README.md", "# api\n");
    sh(ana, "add", ".");
    sh(ana, "commit", "-m", "Start");
    sh(ana, "push", "-u", "origin", "HEAD:main");
    sh(ana, "remote", "add", "team", team);
    sh(ana, "push", "team", "main");
  });

  const branchWith = (name: string, file: string) => {
    sh(ana, "switch", "-c", name, "main");
    root.write(`ana/${file}`, `${name}\n`);
    sh(ana, "add", file);
    sh(ana, "commit", "-m", name);
  };

  it("records the remote a branch pushed without -u went to, and warns about none", () => {
    branchWith("ana/no-u", "src/no-u.ts");
    sh(ana, "push", "team", "ana/no-u");
    expect(systemGit(ana, ["config", "--get", "branch.ana/no-u.remote"])).toBeUndefined();
    const state = workState(systemGit, ana);
    expect(state).toMatchObject({
      branch: "ana/no-u",
      remote: { url: team, branch: "ana/no-u" },
      pushed: true,
    });
    expect(state.pushTo).toBeUndefined();

    // The new owner fetches it from that remote, not from origin first.
    const ben = root.path("ben-no-u");
    sh(root.root, "clone", origin, ben);
    sh(ben, "remote", "add", "team", team);
    const result = checkoutBranch(systemGit, ben, "ana/no-u", state.remote);
    expect(result).toEqual({ fetched: true, remote: "team", switched: true });
  });

  it("suggests the remote that takes pushes for a branch no remote has", () => {
    branchWith("ana/local", "src/local.ts");
    expect(workState(systemGit, ana)).toMatchObject({ branch: "ana/local", pushTo: "origin" });
    sh(ana, "remote", "set-url", "--push", "origin", "no_push");
    try {
      const state = workState(systemGit, ana);
      expect(state.pushed).toBeUndefined();
      expect(state.remote).toBeUndefined();
      expect(state.pushTo).toBe("team");
    } finally {
      sh(ana, "config", "--unset", "remote.origin.pushurl");
    }
  });

  it("lists the files the branch changed from git, and nothing to compare on the default branch", () => {
    branchWith("ana/files", "src/files.ts");
    root.write("ana/scripts/gen.sh", "echo made by a shell command\n");
    expect(workState(systemGit, ana).uncommitted).toEqual(["scripts/"]);
    root.write("ana/README.md", "# api, edited\n");
    expect(changedFiles(systemGit, ana)).toEqual(["src/files.ts", "README.md", "scripts/gen.sh"]);
    sh(ana, "checkout", "--", "README.md");
    rmSync(join(ana, "scripts"), { recursive: true });
    sh(ana, "switch", "main");
    expect(changedFiles(systemGit, ana)).toBeUndefined();
  });

  it("switches a clone whose only change is an untracked selfhost.toml", () => {
    branchWith("ana/switch", "src/switch.ts");
    sh(ana, "push", "origin", "ana/switch");
    const ben = root.path("ben-switch");
    sh(root.root, "clone", origin, ben);
    root.write("ben-switch/selfhost.toml", "version = 1\n");
    expect(sh(ben, "status", "--porcelain")).toBe("?? selfhost.toml");
    const result = checkoutBranch(systemGit, ben, "ana/switch");
    expect(result).toEqual({ fetched: true, remote: "origin", switched: true });
    expect(sh(ben, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ana/switch");
    expect(readFileSync(join(ben, "selfhost.toml"), "utf8")).toBe("version = 1\n");
  });

  it("still refuses changes to tracked files, and names an untracked file the branch has", () => {
    branchWith("ana/has-toml", "selfhost.toml");
    sh(ana, "push", "origin", "ana/has-toml");
    const ben = root.path("ben-refuse");
    sh(root.root, "clone", origin, ben);
    root.write("ben-refuse/selfhost.toml", "version = 1\n");
    expect(checkoutBranch(systemGit, ben, "ana/has-toml")).toEqual({
      fetched: true,
      remote: "origin",
      switched: false,
      why: "ana/has-toml has files this clone holds untracked (selfhost.toml); move them aside, then switch",
    });
    expect(sh(ben, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    root.write("ben-refuse/README.md", "# changed\n");
    expect(checkoutBranch(systemGit, ben, "ana/switch")).toMatchObject({
      switched: false,
      why: "the working tree has changes; commit or stash them, then switch",
    });
  });
});
