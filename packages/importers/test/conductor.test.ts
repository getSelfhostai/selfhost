import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  conductorVendor,
  importConductorExport,
  readConductorExport,
  repoSlug,
} from "../src/index.js";
import { FIXTURES, MemoryWriter, tempDir } from "./helpers.js";

const EXPORT = join(FIXTURES, "conductor", "export");
const PERSON = "dev@example.com";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scratch(): string {
  const dir = tempDir("conductor");
  cleanups.push(dir.cleanup);
  return dir.path;
}

describe("Conductor history export", () => {
  it("finds workspaces, sessions and messages wherever they sit in the files", async () => {
    const history = await readConductorExport(EXPORT, { actorId: PERSON });
    expect(history).toMatchObject({ files: 5, workspaces: 3, sessions: 5, messages: 14 });
    expect(history.skipped).toEqual([
      { path: "session ses_porto_2", reason: "no timestamp in the export" },
    ]);
    const started = history.events.filter((event) => event.kind === "session.started");
    expect(
      started.map((event) => [
        event.session_id,
        event.ts,
        event.agent?.vendor,
        event.model,
        event.repo,
        event.run_id,
      ]),
    ).toEqual([
      // Started at the SQL row's session_created_at, before its first message.
      [
        "ses_lisbon_1",
        "2026-10-20T09:01:00.000Z",
        "claude_code",
        "claude-opus-5-5",
        "acme/acme-web",
        "conductor:ws_lisbon",
      ],
      [
        "ses_lisbon_2",
        "2026-10-21T08:00:00.000Z",
        "claude_code",
        "sonnet-5-5-1m",
        "acme/acme-web",
        "conductor:ws_lisbon",
      ],
      // No repoUrl on the workspace: the repository comes from its project's gitRemote.
      [
        "ses_porto_1",
        "2026-11-02T14:00:00.000Z",
        "codex",
        "gpt-6.1-sol",
        "acme/acme-web",
        "conductor:ws_porto",
      ],
      // Known from a POST /v0/sql row and a page of GET /v0/sessions/{id}/messages only.
      [
        "ses_osaka_1",
        "2026-11-05T16:00:00.000Z",
        "claude_code",
        "opus-5-5-1m",
        "acme/acme-web",
        "conductor:ws_osaka",
      ],
    ]);
    expect(started[0]?.data).toEqual({
      via: "conductor",
      workspace: "lisbon",
      workspace_id: "ws_lisbon",
      workspace_state: "archived",
      session_name: "Add rate limiting to login",
      messages: 6,
      prompts: 2,
    });
    const ended = history.events.filter((event) => event.kind === "session.ended");
    expect(ended.map((event) => [event.session_id, event.ts])).toEqual([
      ["ses_lisbon_1", "2026-10-20T09:12:30.000Z"],
      ["ses_lisbon_2", "2026-10-21T08:03:10.000Z"],
      ["ses_porto_1", "2026-11-02T14:20:00.000Z"],
      ["ses_osaka_1", "2026-11-05T16:45:00.000Z"],
    ]);
    expect(history.events.every((event) => event.actor.id === PERSON)).toBe(true);
    expect(history.events.every((event) => event.source === "local_log")).toBe(true);
  });

  it("keeps prompt text only when asked, and never tool calls or token usage", async () => {
    const plain = await readConductorExport(EXPORT, { actorId: PERSON });
    expect(plain.events.map((event) => event.kind).sort()).toEqual([
      ...Array(4).fill("session.ended"),
      ...Array(4).fill("session.started"),
    ]);
    const withPrompts = await readConductorExport(EXPORT, { actorId: PERSON, logPrompts: true });
    const prompts = withPrompts.events.filter((event) => event.kind === "prompt.submitted");
    expect(prompts.map((event) => event.data?.prompt)).toEqual([
      "Add rate limiting to the /login route, 5 tries per minute per IP.",
      "Also add a test for the 429 response.",
      "Review the diff for missed edge cases.",
      "Move the config loader to zod and keep the env names.",
      "The checkout test fails one run in ten. Find out why.",
    ]);
    const kinds = new Set(withPrompts.events.map((event) => event.kind));
    expect(kinds).toEqual(new Set(["session.started", "session.ended", "prompt.submitted"]));
  });

  it("writes valid events once: a second import finds only duplicates", async () => {
    const writer = new MemoryWriter();
    const first = await importConductorExport(writer, EXPORT, {
      actorId: PERSON,
      logPrompts: true,
    });
    expect(first.accepted).toBe(13);
    expect(first.duplicates).toBe(0);
    const second = await importConductorExport(writer, EXPORT, {
      actorId: PERSON,
      logPrompts: true,
    });
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(13);
    expect(writer.events.size).toBe(13);
  });

  it("reads one JSON Lines file of messages", async () => {
    const file = join(scratch(), "messages.jsonl");
    const message = (id: string, index: number, type: string, receivedAt: string) =>
      JSON.stringify({
        id,
        sessionId: "ses_x",
        sessionIndex: index,
        type,
        content: {},
        receivedAt,
      });
    writeFileSync(
      file,
      `${[
        message("m0", 0, "userMessage", "2026-11-01T10:00:00Z"),
        message("m1", 1, "agent", "2026-11-01T10:05:00Z"),
      ].join("\n")}\n`,
    );
    const history = await readConductorExport(file, { actorId: PERSON });
    expect(history).toMatchObject({ files: 1, sessions: 1, messages: 2 });
    expect(history.events.map((event) => [event.kind, event.ts, event.agent?.vendor])).toEqual([
      ["session.started", "2026-11-01T10:00:00.000Z", "other"],
      ["session.ended", "2026-11-01T10:05:00.000Z", "other"],
    ]);
  });

  it("finds nothing in files of another shape, and skips files that are not JSON", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark", sounds: [] }));
    writeFileSync(join(dir, "broken.json"), "{ not json");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "readme.txt"), "not read");
    const history = await readConductorExport(dir, { actorId: PERSON });
    expect(history).toMatchObject({ files: 1, workspaces: 0, sessions: 0, events: [] });
    expect(history.skipped).toEqual([{ path: "broken.json", reason: "not JSON or JSON Lines" }]);
  });

  it("asks for a zip archive to be unpacked and names a missing path", async () => {
    await expect(readConductorExport(join(scratch(), "conductor-export.zip"))).rejects.toThrow(
      /zip archive\. Unpack it first/,
    );
    await expect(readConductorExport(join(scratch(), "missing"))).rejects.toThrow(/does not exist/);
  });
});

describe("repoSlug and conductorVendor", () => {
  it("reads owner/name from SSH and HTTPS remotes", () => {
    expect(repoSlug("git@github.com:acme/acme-web.git")).toBe("acme/acme-web");
    expect(repoSlug("https://github.com/acme/acme-web")).toBe("acme/acme-web");
    expect(repoSlug("ssh://git@git.example.com/acme/acme-web.git/")).toBe("acme/acme-web");
    expect(repoSlug("not a remote")).toBeUndefined();
  });

  it("takes the agent from its name, else from the model id", () => {
    expect(conductorVendor("claude", undefined)).toBe("claude_code");
    expect(conductorVendor("codex", "opus-5-5-1m")).toBe("codex");
    expect(conductorVendor(undefined, "sonnet-5-5-1m")).toBe("claude_code");
    expect(conductorVendor(undefined, "gpt-6.1-sol")).toBe("codex");
    expect(conductorVendor(undefined, "composer-2.5")).toBe("cursor");
    expect(conductorVendor("acp", "mystery-1")).toBe("other");
  });
});
