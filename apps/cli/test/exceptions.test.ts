import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import type { ReviewItem } from "@selfhost/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainSpool } from "../src/hooks/drain.js";
import { exceptionKey, findGrant, issueGrants, readRequests } from "../src/hooks/exceptions.js";
import { explain, GUARDRAILS_DOCS, PACKAGES_DOCS } from "../src/hooks/explain.js";
import { checkPreToolCall } from "../src/hooks/pretool.js";
import { runHook, type SpoolLine } from "../src/hooks/receive.js";
import { type AnswerText, answerText, type HookAgent } from "../src/hooks/vendors.js";
import { agentSessionVariable } from "../src/human.js";
import { type InboxIo, runInboxDecide } from "../src/inbox/commands.js";
import { localReviewList } from "../src/review-list.js";
import { run, tempDir } from "./run.js";

/**
 * Errors that teach (F38): every block names the rule, says why and what to do instead, links
 * to the rule, and names a review item that allows the call once. These tests cover each
 * agent's response format, and the one-time exception end to end: block, item on import,
 * approve, grant, one allowed call, block again, expiry, concurrency and secrets.
 */

const T0 = new Date("2026-11-08T10:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const PERSON = "dev@example.com";
const POLICY = `version = 1

[[rules]]
id = "ask-before-migrations"
mode = "enforce"
match = { path = "db/migrations/**" }
action = "ask"
message = "Migrations need a person's review."

[[rules]]
id = "no-curl"
mode = "enforce"
match = { command = '\\bcurl\\b' }
action = "block"
message = "Agents do not call curl."
alternative = "Use the HTTP client in src/http.ts."
docs = "https://wiki.example.com/rules/no-curl"
`;

function machine() {
  const workspace = tempDir("teach-ws");
  workspace.write(".git/HEAD", "ref: refs/heads/main\n");
  workspace.write("selfhost.toml", POLICY);
  const home = tempDir("teach-home");
  const selfhost = home.path(".selfhost");
  return {
    workspace,
    home,
    configPath: join(selfhost, "config.json"),
    exceptions: join(selfhost, "exceptions"),
    spool: join(selfhost, "spool"),
  };
}

type Machine = ReturnType<typeof machine>;

const bash = (cwd: string, command: string) => ({
  session_id: "sess-1",
  cwd,
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
  tool_use_id: "toolu_1",
});

async function hook(m: Machine, agent: HookAgent, payload: object, now: Date) {
  let stdout = "";
  const errors: string[] = [];
  await runHook([agent], {
    env: { HOME: m.home.root },
    readStdin: async () => JSON.stringify(payload),
    writeOutput: (text) => {
      stdout += text;
    },
    writeError: (line) => errors.push(line),
    now,
    checkPreTool: (name, body, io) => checkPreToolCall(name, body, io, { checkers: [] }),
  });
  expect(errors).toEqual([]);
  return stdout;
}

const spoolLines = (m: Machine): SpoolLine[] =>
  readdirSync(m.spool).flatMap((name) =>
    readFileSync(join(m.spool, name), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as SpoolLine),
  );

const claudeOut = (stdout: string) =>
  JSON.parse(stdout) as {
    hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string };
    systemMessage?: string;
  };

const ID = /(?:one-time exception|selfhost inbox approve) ([0-9a-f-]{36})/;

function inboxIo(m: Machine, now: Date): InboxIo {
  const env = { HOME: m.home.root, SELFHOST_PERSON: PERSON };
  return {
    env,
    platform: "darwin",
    write: () => {},
    setExitCode: () => {},
    now,
    configPath: m.configPath,
    fetch: vi.fn(),
    localReviewList: localReviewList({
      env,
      cwd: m.workspace.root,
      write: () => {},
      now,
      configPath: m.configPath,
    }),
  };
}

const ledgers: Ledger[] = [];
afterEach(async () => {
  for (const ledger of ledgers.splice(0)) await ledger.close();
});

async function memoryLedger() {
  const ledger = await openLedger({ dataDir: "memory://" });
  ledgers.push(ledger);
  return ledger;
}

describe("each agent's response carries the reason in the field that agent reads", () => {
  const text: AnswerText = { agent: "AGENT TEXT", user: "USER TEXT" };

  it("Claude Code: the model reads a deny's reason, the person reads systemMessage", () => {
    expect(JSON.parse(answerText("claude", "PreToolUse", "deny", text))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "AGENT TEXT",
      },
      systemMessage: "USER TEXT",
    });
    // An ask's reason is shown to the person in the permission prompt.
    expect(JSON.parse(answerText("claude", "PreToolUse", "ask", text))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "USER TEXT",
      },
    });
    // An allow decides nothing; a used exception only tells the person.
    expect(answerText("claude", "PreToolUse", "allow")).toBe("");
    expect(JSON.parse(answerText("claude", "PreToolUse", "allow", text))).toEqual({
      systemMessage: "USER TEXT",
    });
  });

  it("Codex: permissionDecisionReason for the model, systemMessage for the person", () => {
    const out = JSON.parse(answerText("codex", "PreToolUse", "deny", text));
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("AGENT TEXT");
    expect(out.systemMessage).toBe("USER TEXT");
    // Codex fails a PreToolUse hook run that returns continue, stopReason or suppressOutput.
    expect(Object.keys(out).sort()).toEqual(["hookSpecificOutput", "systemMessage"]);
  });

  it("Cursor: agent_message for the agent, user_message for the person", () => {
    expect(JSON.parse(answerText("cursor", "beforeShellExecution", "deny", text))).toEqual({
      permission: "deny",
      user_message: "USER TEXT",
      agent_message: "AGENT TEXT",
    });
    expect(JSON.parse(answerText("cursor", "beforeMCPExecution", "ask", text))).toMatchObject({
      permission: "ask",
      agent_message: "AGENT TEXT",
    });
    // beforeReadFile has no agent_message.
    expect(JSON.parse(answerText("cursor", "beforeReadFile", "deny", text))).toEqual({
      permission: "deny",
      user_message: "USER TEXT",
    });
    expect(answerText("cursor", "preToolUse", "allow", text)).toBe('{"permission":"allow"}');
  });

  it("OpenCode: the plugin throws reason, which the model and the person both see", () => {
    expect(JSON.parse(answerText("opencode", "tool.execute.before", "deny", text))).toEqual({
      decision: "deny",
      reason: "AGENT TEXT",
    });
    expect(answerText("opencode", "tool.execute.before", "allow", text)).toBe(
      '{"decision":"allow"}',
    );
  });
});

describe("the reason", () => {
  it("tells the agent the rule, why, the alternative, not to retry and how to ask", () => {
    const { agent, user } = explain({
      agent: "Claude Code",
      hit: {
        rule_id: "guard.force_push",
        verdict: "block",
        message: "Force pushes rewrite shared history.",
        alternative: "Push to a new branch.",
      },
      answer: "deny",
      link: GUARDRAILS_DOCS,
      exceptionId: "019a5b01-0000-7000-8000-000000000001",
    });
    expect(agent.split("\n")).toEqual([
      "selfhost blocked this call under rule guard.force_push: Force pushes rewrite shared history.",
      "Instead: Push to a new branch.",
      "Do not retry this call, or a variant of it, to get around the rule: it will be blocked again. Take the alternative above, or, if this exact call is needed, ask the user to approve one-time exception 019a5b01-0000-7000-8000-000000000001. Only a person can approve it, in their own terminal or the console; do not run the approval yourself. Once they approve, make the identical call again and it is allowed once.",
      `Rule: ${GUARDRAILS_DOCS}`,
    ]);
    expect(user.split("\n")).toEqual([
      "selfhost blocked a Claude Code call under rule guard.force_push: Force pushes rewrite shared history.",
      "Instead: Push to a new branch.",
      "To allow it once, run: selfhost inbox approve 019a5b01-0000-7000-8000-000000000001",
      `Rule: ${GUARDRAILS_DOCS}`,
    ]);
    for (const line of [...agent.split("\n"), ...user.split("\n")]) {
      expect(line).not.toMatch(/\u2014/);
    }
  });

  it("links a repository rule to its line in selfhost.toml, with its docs", async () => {
    const m = machine();
    const out = claudeOut(
      await hook(m, "claude", bash(m.workspace.root, "curl -s https://example.com"), T0),
    );
    const reason = out.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(reason).toContain("under rule no-curl: Agents do not call curl.");
    expect(reason).toContain("Instead: Use the HTTP client in src/http.ts.");
    expect(reason).toContain(`Rule: ${m.workspace.path("selfhost.toml")}:10`);
    expect(reason).toContain("More: https://wiki.example.com/rules/no-curl");
    expect(out.systemMessage).toContain(`Rule: ${m.workspace.path("selfhost.toml")}:10`);
  });

  it("links a team rule to its line in the pulled team policy, not to the repository's file", async () => {
    const m = machine();
    m.home.write(
      ".selfhost/config.json",
      JSON.stringify({ server: "http://127.0.0.1:4400", token: "t", person: PERSON, team: "web" }),
    );
    m.home.write(
      ".selfhost/team-policy.toml",
      `version = 1

[[rules]]
id = "team-warn"
mode = "observe"
match = { command = '\\bwarn\\b' }
action = "block"
message = "Warn."

[[rules]]
id = "team-no-npm-publish"
mode = "enforce"
match = { command = '\\bnpm\\s+publish\\b' }
action = "block"
message = "Agents do not publish packages."
`,
    );
    const team = m.home.path(".selfhost/team-policy.toml");
    const teamOut = claudeOut(await hook(m, "claude", bash(m.workspace.root, "npm publish"), T0));
    const teamReason = teamOut.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(teamReason).toContain(`Rule: ${team}:10 (team web's policy)`);
    expect(teamReason).not.toContain(m.workspace.path("selfhost.toml"));
    // A repository rule on the same machine still points at the repository's file.
    const repoOut = claudeOut(await hook(m, "claude", bash(m.workspace.root, "curl -s x"), T0));
    expect(repoOut.hookSpecificOutput?.permissionDecisionReason).toContain(
      `Rule: ${m.workspace.path("selfhost.toml")}:10 (this repository's selfhost.toml)`,
    );
    // Composed on the server from an org floor: the link says what the file is made of.
    m.home.write(
      ".selfhost/team-policy.toml",
      `#:schema https://selfhost.ai/schema/selfhost.toml.v1.json\n# The policy in use: org acme, then team web. Change those, not this file.\n${readFileSync(team, "utf8")}`,
    );
    const orgOut = claudeOut(await hook(m, "claude", bash(m.workspace.root, "npm publish"), T0));
    expect(orgOut.hookSpecificOutput?.permissionDecisionReason).toContain(
      `Rule: ${team}:12 (team web's policy, made of org acme then team web)`,
    );
  });

  it("says why Codex was blocked on an ask it cannot put to a person", async () => {
    const m = machine();
    const payload = {
      session_id: "sess-cx",
      cwd: m.workspace.root,
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: {
        command:
          "*** Begin Patch\n*** Add File: db/migrations/001.sql\n+select 1;\n*** End Patch\n",
      },
    };
    const out = claudeOut(await hook(m, "codex", payload, T0));
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(
      /^selfhost blocked this call: rule ask-before-migrations needs a person's approval first, and Codex cannot ask from a hook\./,
    );
    expect(out.systemMessage).toMatch(/To allow it once, run: selfhost inbox approve /);
  });

  it("puts the ask in Claude Code's prompt with the rule, and asks for no exception", async () => {
    const m = machine();
    const payload = {
      session_id: "s",
      cwd: m.workspace.root,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: m.workspace.path("db/migrations/001.sql"), content: "x" },
    };
    const out = claudeOut(await hook(m, "claude", payload, T0));
    expect(out.hookSpecificOutput).toMatchObject({
      permissionDecision: "ask",
      permissionDecisionReason: `selfhost: rule ask-before-migrations asks a person first: Migrations need a person's review.\nRule: ${m.workspace.path("selfhost.toml")}:3`,
    });
    expect(out.systemMessage).toBeUndefined();
    expect(readRequests(m.exceptions)).toEqual([]);
  });

  it("gives every built-in guardrail and package check an alternative and a docs link", async () => {
    const { GUARDRAILS } = await import("@selfhost/policy");
    const { PACKAGE_ALTERNATIVES } = await import("@selfhost/package-guard");
    for (const guardrail of Object.values(GUARDRAILS)) {
      expect(guardrail.alternative.length).toBeGreaterThan(20);
    }
    expect(Object.keys(PACKAGE_ALTERNATIVES).sort()).toEqual([
      "packages.blocked_registry",
      "packages.deny",
      "packages.install_scripts",
      "packages.malicious",
      "packages.not_found",
      "packages.too_new",
    ]);
    const m = machine();
    const reason = claudeOut(await hook(m, "claude", bash(m.workspace.root, "cat .env"), T0))
      .hookSpecificOutput?.permissionDecisionReason;
    expect(reason).toContain("Instead: Read .env.example");
    expect(reason).toContain(`Rule: ${GUARDRAILS_DOCS}`);
    expect(PACKAGES_DOCS).toMatch(/package-guard\/README\.md#rules-and-verdicts$/);
  });
});

describe("a one-time exception, end to end", () => {
  async function blockForcePush(m: Machine, now: Date) {
    const out = claudeOut(
      await hook(m, "claude", bash(m.workspace.root, "git push --force origin main"), now),
    );
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    const id = ID.exec(out.hookSpecificOutput?.permissionDecisionReason ?? "")?.[1];
    expect(id).toBeDefined();
    expect(out.systemMessage).toContain(`To allow it once, run: selfhost inbox approve ${id}`);
    return id as string;
  }

  it("blocks, opens an item on import, allows the call once on approval, then blocks again", async () => {
    const m = machine();
    const ledger = await memoryLedger();
    const id = await blockForcePush(m, T0);

    // The hook wrote the request and the spool line; it never opened the ledger.
    expect(readRequests(m.exceptions).map((request) => request.id)).toEqual([id]);
    const line = spoolLines(m).at(-1);
    expect(line?.guard?.exception).toMatchObject({ id, rules: ["guard.force_push"] });

    // The person approves in the inbox: the block is read in, the item made and answered.
    const approved = await runInboxDecide(
      "approve",
      id,
      { reason: "release branch" },
      inboxIo(m, minutes(1)),
      ledger,
    );
    expect(approved.item?.deadline).toBeUndefined();
    expect(approved).toMatchObject({
      outcome: "applied",
      // The agent was denied and went on: no agent waits on it, and no timeout denies it.
      item: { id, kind: "exception", state: "answered", blocking: false },
      grant: {
        id,
        rules: ["guard.force_push"],
        approved_by: PERSON,
        expires_at: minutes(31).toISOString(),
      },
    });
    expect(existsSync(join(m.exceptions, "grants", `${id}.json`))).toBe(true);
    expect(readRequests(m.exceptions)).toEqual([]);

    // The identical call goes through once: nothing decided, a note for the person.
    const allowed = claudeOut(
      await hook(m, "claude", bash(m.workspace.root, "git  push --force origin main "), minutes(2)),
    );
    expect(allowed).toEqual({
      systemMessage: `selfhost allowed this call once under rule guard.force_push: ${PERSON} approved exception ${id}. The next identical call is blocked again.`,
    });
    expect(spoolLines(m).at(-1)?.guard).toMatchObject({
      answer: "allow",
      exception: { id, used: true, approved_by: PERSON },
    });
    expect(existsSync(join(m.exceptions, "used", `${id}.json`))).toBe(true);

    // A different call is not covered, and the third identical call is blocked again.
    const other = claudeOut(
      await hook(m, "claude", bash(m.workspace.root, "git push --force origin dev"), minutes(3)),
    );
    expect(other.hookSpecificOutput?.permissionDecision).toBe("deny");
    const again = await blockForcePush(m, minutes(4));
    expect(again).not.toBe(id);

    // The ledger holds the request, the approval and the use.
    await drainSpool(ledger, m.spool, { person: PERSON, now: minutes(5) });
    const evaluated = (await ledger.query({ kind: "policy.evaluated", limit: 100 })).events;
    const forItem = evaluated
      .filter((event) => event.links?.item_id === id)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    expect(forItem.map((event) => [event.decision?.verdict, event.data?.exception])).toEqual([
      [
        "block",
        { id, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), rules: ["guard.force_push"] },
      ],
      [
        "allow",
        {
          id,
          rules: ["guard.force_push"],
          used: true,
          // Emails under data are masked like every ledger write; the decision names the person.
          approved_by: "[redacted]",
          decision_event_id: approved.decision_event?.id,
        },
      ],
    ]);
    expect(forItem[1]?.decision).toMatchObject({
      verdict: "allow",
      rule_id: "guard.force_push",
      mode: "enforce",
      reason: expect.stringMatching(/^Allowed once: .+ approved exception /),
    });
    const decisions = (await ledger.query({ kind: "decision.recorded" })).events;
    expect(decisions.map((event) => [event.decision?.item_id, event.decision?.verdict])).toEqual([
      [id, "approve"],
    ]);
  });

  it("expires an approved exception that was not used in time", async () => {
    const m = machine();
    const ledger = await memoryLedger();
    const id = await blockForcePush(m, T0);
    await runInboxDecide("approve", id, {}, inboxIo(m, minutes(1)), ledger);
    // [review] exception_expiry_minutes is 30 by default: 31 minutes after the approval it is gone.
    const late = claudeOut(
      await hook(m, "claude", bash(m.workspace.root, "git push --force origin main"), minutes(32)),
    );
    expect(late.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(existsSync(join(m.exceptions, "grants", `${id}.json`))).toBe(false);
  });

  it("takes the expiry from [review] exception_expiry_minutes", async () => {
    const m = machine();
    m.workspace.write("selfhost.toml", `${POLICY}\n[review]\nexception_expiry_minutes = 5\n`);
    const ledger = await memoryLedger();
    const id = await blockForcePush(m, T0);
    const { grant } = await runInboxDecide("approve", id, {}, inboxIo(m, minutes(1)), ledger);
    expect(grant?.expires_at).toBe(minutes(6).toISOString());
  });

  it("writes no grant for a denied item, and the call stays blocked", async () => {
    const m = machine();
    const ledger = await memoryLedger();
    const id = await blockForcePush(m, T0);
    const denied = await runInboxDecide("deny", id, {}, inboxIo(m, minutes(1)), ledger);
    expect(denied).toMatchObject({ item: { state: "answered" }, grant: null });
    expect(readRequests(m.exceptions)).toEqual([]);
    expect(readdirSync(join(m.exceptions, "grants"))).toEqual([]);
    await blockForcePush(m, minutes(2));
  });

  it("ignores a grant that was edited or written without the key", async () => {
    const m = machine();
    const ledger = await memoryLedger();
    const id = await blockForcePush(m, T0);
    const { grant } = await runInboxDecide("approve", id, {}, inboxIo(m, minutes(1)), ledger);
    const path = join(m.exceptions, "grants", `${id}.json`);
    writeFileSync(path, JSON.stringify({ ...grant, expires_at: "2099-01-01T00:00:00.000Z" }));
    await blockForcePush(m, minutes(2));
    // An agent cannot read the key that signs grants.
    const read = claudeOut(
      await hook(m, "claude", bash(m.workspace.root, "cat ~/.selfhost/exceptions/key"), minutes(2)),
    );
    expect(read.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("lets only one of several hooks running at once use a grant", async () => {
    const m = machine();
    const ledger = await memoryLedger();
    // The hooks below run with the real clock, so this flow does too.
    const now = new Date();
    const id = await blockForcePush(m, now);
    await runInboxDecide("approve", id, {}, inboxIo(m, now), ledger);
    const cli = join(import.meta.dirname, "..");
    const once = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", join(cli, "src", "main.ts"), "hook", "claude"],
          { cwd: cli, env: { PATH: process.env.PATH, HOME: m.home.root } },
        );
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk;
        });
        child.on("error", reject);
        child.on("close", () => resolve(out.trim()));
        child.stdin.end(JSON.stringify(bash(m.workspace.root, "git push --force origin main")));
      });
    const answers = await Promise.all([once(), once(), once(), once()]);
    const decisions = answers.map(
      (out) => claudeOut(out).hookSpecificOutput?.permissionDecision ?? "allow",
    );
    expect(decisions.filter((decision) => decision === "allow")).toHaveLength(1);
    expect(decisions.filter((decision) => decision === "deny")).toHaveLength(3);
  }, 60_000);

  it("keeps secrets out of the request, the grant, the item and the decision", async () => {
    const m = machine();
    const ledger = await memoryLedger();
    const token = ["ghp", "_", "b".repeat(36)].join("");
    const out = claudeOut(
      await hook(
        m,
        "claude",
        bash(m.workspace.root, `GH_TOKEN=${token} git push --force origin main`),
        T0,
      ),
    );
    expect(JSON.stringify(out)).not.toContain(token);
    const id = ID.exec(out.hookSpecificOutput?.permissionDecisionReason ?? "")?.[1] ?? "";
    const files = () =>
      ["requests", "grants", "used"].flatMap((folder) => {
        const dir = join(m.exceptions, folder);
        return existsSync(dir) ? readdirSync(dir).map((name) => readFileSync(join(dir, name))) : [];
      });
    expect(files().join("\n")).not.toContain(token);
    const approved = await runInboxDecide("approve", id, {}, inboxIo(m, minutes(1)), ledger);
    expect(approved.item?.title).toContain("GH_TOKEN=[redacted");
    expect(JSON.stringify(approved)).not.toContain(token);
    expect(files().length).toBeGreaterThan(0);
    expect(files().join("\n")).not.toContain(token);
    const events = (await ledger.query({ limit: 100 })).events;
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it("lets Cursor's own shell hook use the grant after preToolUse looked at it", async () => {
    const m = machine();
    const ledger = await memoryLedger();
    const command = "git push --force origin main";
    const cursor = (event: string, fields: object) => ({
      conversation_id: "conv-1",
      hook_event_name: event,
      workspace_roots: [m.workspace.root],
      ...fields,
    });
    const pre = cursor("preToolUse", {
      tool_name: "Shell",
      tool_input: { command, working_directory: m.workspace.root },
    });
    const blocked = JSON.parse(await hook(m, "cursor", pre, T0));
    expect(blocked.permission).toBe("deny");
    expect(blocked.agent_message).toContain("Do not retry this call");
    const id = ID.exec(blocked.user_message)?.[1] ?? "";
    await runInboxDecide("approve", id, {}, inboxIo(m, minutes(1)), ledger);

    expect(JSON.parse(await hook(m, "cursor", pre, minutes(2)))).toEqual({ permission: "allow" });
    expect(existsSync(join(m.exceptions, "grants", `${id}.json`))).toBe(true);
    const shell = cursor("beforeShellExecution", { command, cwd: m.workspace.root });
    expect(JSON.parse(await hook(m, "cursor", shell, minutes(2)))).toEqual({ permission: "allow" });
    expect(existsSync(join(m.exceptions, "used", `${id}.json`))).toBe(true);
    expect(JSON.parse(await hook(m, "cursor", shell, minutes(3))).permission).toBe("deny");
  });
});

// Team mode, where the server signs grants, is in exception-grants.test.ts.
describe("solo grant requests", () => {
  it("keeps a request while the server is unreachable or its item is still open", async () => {
    const m = machine();
    await hook(m, "claude", bash(m.workspace.root, "git reset --hard"), T0);
    const [request] = readRequests(m.exceptions);
    const down = await issueGrants(
      m.exceptions,
      async () => {
        throw new Error("unreachable");
      },
      minutes(1),
    );
    expect(down).toEqual({ issued: [], waiting: 1, error: "unreachable" });
    const open = await issueGrants(
      m.exceptions,
      async (id) => ({ id, kind: "exception", state: "open" }) as ReviewItem,
      minutes(1),
    );
    expect(open).toEqual({ issued: [], waiting: 1 });
    expect(readRequests(m.exceptions)).toEqual([request]);
    // A grant this machine could not have written does not match.
    const key = exceptionKey(m.exceptions, false);
    expect(key).toBeDefined();
    expect(
      findGrant(m.exceptions, key as Buffer, request?.fingerprint ?? "", [], minutes(1)),
    ).toBeUndefined();
  });
});

describe("only a person approves", () => {
  it("blocks an agent's own selfhost inbox approve, offers no exception for it", async () => {
    const m = machine();
    m.workspace.write("selfhost.toml", `${POLICY}\n[guardrails]\nmode = "off"\n`);
    for (const command of [
      "selfhost inbox approve 019a5b01-0000-7000-8000-000000000001",
      "CLAUDECODE=1 npx selfhostai review approve 019a5b01 < /dev/null",
    ]) {
      const out = claudeOut(await hook(m, "claude", bash(m.workspace.root, command), T0));
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("guard.selfhost_decision");
      expect(out.hookSpecificOutput?.permissionDecisionReason).not.toMatch(ID);
    }
    expect(readRequests(m.exceptions)).toEqual([]);
  });

  it("refuses the decision commands inside an agent session or without a terminal", async () => {
    const id = "019a5b01-0000-7000-8000-000000000001";
    for (const env of [
      { CLAUDECODE: "1" },
      { CODEX_SANDBOX: "seatbelt" },
      { AI_AGENT: "claude-code" },
      { CLAUDE_CODE_SESSION_ID: "5d1f2c" },
      { OPENCODE_CLIENT: "cli" },
      { CURSOR_EXTENSION_HOST_ROLE: "agent-exec" },
    ]) {
      for (const args of [
        ["inbox", "approve", id],
        ["review", "deny", id],
        ["decide", id, "approve"],
        ["policy", "promote", "no-curl", "--to", "off"],
      ]) {
        const result = await run(args, { env });
        expect(result.code).toBe(1);
        expect(result.err).toMatch(
          /inside a coding agent session \((CLAUDECODE|CODEX_SANDBOX|AI_AGENT|CLAUDE_CODE_SESSION_ID|OPENCODE_CLIENT|CURSOR_EXTENSION_HOST_ROLE) is set\)/,
        );
      }
    }
    // A Cursor terminal a person opened is not the agent's.
    expect(
      agentSessionVariable({ CURSOR_EXTENSION_HOST_ROLE: "user", CURSOR_TRACE_ID: "abc" }),
    ).toBeUndefined();
    const piped = await run(["inbox", "approve", id], { stdinIsTTY: false });
    expect(piped.code).toBe(1);
    expect(piped.err).toContain("needs a person at a terminal");
    expect(piped.err).toContain("can set SELFHOST_PERSON_SCRIPT=1 to run it without one");
  });

  it("lets a person's script answer without a terminal, never an agent session", async () => {
    const id = "019a5b01-0000-7000-8000-000000000001";
    const scripted = await run(["inbox", "approve", id], {
      stdinIsTTY: false,
      env: { SELFHOST_PERSON_SCRIPT: "1" },
    });
    expect(scripted.err).not.toContain("person's decision");
    const agent = await run(["inbox", "approve", id], {
      stdinIsTTY: false,
      env: { SELFHOST_PERSON_SCRIPT: "1", CLAUDECODE: "1" },
    });
    expect(agent.code).toBe(1);
    expect(agent.err).toContain("inside a coding agent session (CLAUDECODE is set)");
  });

  it("refuses init --undo and the gateway commands in an agent session, not in a person's script", async () => {
    for (const args of [
      ["init", "--undo"],
      ["gateway", "disconnect"],
      ["gateway", "disconnect", "claude-code"],
      ["gateway", "connect", "claude-code"],
      ["gateway", "connect", "codex", "--rotate"],
      ["gateway", "connect", "claude-code", "--undo"],
    ]) {
      const refused = await run(args, { env: { CLAUDECODE: "1" } });
      expect(refused.code, args.join(" ")).toBe(1);
      expect(refused.err).toMatch(
        /^selfhost (init --undo|gateway (dis)?connect( --rotate)?) is a person's decision, and this runs inside a coding agent session \(CLAUDECODE is set\)/,
      );
    }
    // Without a terminal, outside an agent: a person's script undoes (here, nothing to undo).
    const home = tempDir("undo-home");
    const undo = await run(["init", "--undo", "--home", home.root], { stdinIsTTY: false });
    expect(undo.err).not.toContain("person's decision");
    expect(undo.out).toContain("Nothing to undo");
    const disconnect = await run(["gateway", "disconnect"], {
      stdinIsTTY: false,
      home: home.root,
    });
    expect(disconnect.err).not.toContain("person's decision");
    // A dry run changes nothing, so an agent may look.
    expect(
      (
        await run(["init", "--undo", "--dry-run", "--home", home.root], {
          env: { CLAUDECODE: "1" },
        })
      ).err,
    ).not.toContain("person's decision");
  });
});

describe("an exception is for the session that asked", () => {
  it("does not let another session use the grant", async () => {
    const m = machine();
    const ledger = await memoryLedger();
    const out = claudeOut(
      await hook(m, "claude", bash(m.workspace.root, "git reset --hard HEAD"), T0),
    );
    const id = ID.exec(out.hookSpecificOutput?.permissionDecisionReason ?? "")?.[1] ?? "";
    await runInboxDecide("approve", id, {}, inboxIo(m, minutes(1)), ledger);

    const other = { ...bash(m.workspace.root, "git reset --hard HEAD"), session_id: "sess-2" };
    const elsewhere = claudeOut(await hook(m, "claude", other, minutes(2)));
    expect(elsewhere.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(existsSync(join(m.exceptions, "grants", `${id}.json`))).toBe(true);

    const own = claudeOut(
      await hook(m, "claude", bash(m.workspace.root, "git reset --hard HEAD"), minutes(3)),
    );
    expect(own.systemMessage).toContain(`approved exception ${id}`);
  });
});
