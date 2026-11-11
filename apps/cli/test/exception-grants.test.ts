import { execFileSync } from "node:child_process";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Ledger, openLedger } from "@selfhost/ledger";
import { openReviewList, refreshReviewList } from "@selfhost/review";
import {
  type CreateTeamResponse,
  type ExceptionGrant,
  type ExceptionGrantStatus,
  exceptionGrantPayload,
  type JoinResponse,
} from "@selfhost/schema";
import { createApp } from "@selfhost/server/app";
import { afterEach, describe, expect, it } from "vitest";
import { doctorReport } from "../src/doctor.js";
import { drainSpool } from "../src/hooks/drain.js";
import {
  claimServerGrant,
  exceptionKey,
  findGrant,
  readRequests,
  verifyServerGrant,
} from "../src/hooks/exceptions.js";
import { checkPreToolCall } from "../src/hooks/pretool.js";
import { runHook } from "../src/hooks/receive.js";
import { TRUST_SCHEMA, type TrustedKey, trustFileText, trustPath } from "../src/hooks/trust.js";
import { TeamClient } from "../src/team/client.js";
import { pinExceptionKeys, saveMembership, teamPolicyPath } from "../src/team/config.js";
import { installTeamManaged } from "../src/team/laptop.js";
import { RemoteWriter } from "../src/team/remote-writer.js";
import { pullGrants } from "../src/team/sync.js";
import { tempDir } from "./run.js";

/**
 * One-time exceptions in team mode (H4): the team server signs grants with an Ed25519 key only it
 * holds, and the hook accepts a grant only when it verifies with a pinned public key and names
 * this call, session, repository and person. A grant written with the laptop's own key, which an
 * agent running as the person can read, no longer lets a call through.
 */

const PERSON = "dev@example.com";
const LEAD = "lead@example.com";
const SERVER = "http://selfhost.test";
// Whole minutes from now: grants are pruned against the real clock on a sync.
const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const ID = /(?:one-time exception|selfhost inbox approve) ([0-9a-f-]{36})/;
const PLATFORM = "linux";

const ledgers: Ledger[] = [];
afterEach(async () => {
  for (const ledger of ledgers.splice(0)) await ledger.close();
});

function machine() {
  const workspace = tempDir("h4-ws");
  execFileSync("git", ["init", "-q", workspace.root]);
  execFileSync("git", [
    "-C",
    workspace.root,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/web.git",
  ]);
  const home = tempDir("h4-home");
  const system = tempDir("h4-system");
  const selfhost = home.path(".selfhost");
  return {
    workspace,
    home,
    system: system.root,
    configPath: join(selfhost, "config.json"),
    exceptions: join(selfhost, "exceptions"),
    spool: join(selfhost, "spool"),
  };
}

type Machine = ReturnType<typeof machine>;

const bash = (m: Machine, command: string, session = "sess-1") => ({
  session_id: session,
  cwd: m.workspace.root,
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
  tool_use_id: "toolu_1",
});

interface HookOut {
  decision: string | undefined;
  reason: string;
  systemMessage: string | undefined;
  errors: string[];
}

async function hook(m: Machine, payload: object, now: Date): Promise<HookOut> {
  let stdout = "";
  const errors: string[] = [];
  await runHook(["claude"], {
    env: { HOME: m.home.root },
    readStdin: async () => JSON.stringify(payload),
    writeOutput: (text) => {
      stdout += text;
    },
    writeError: (line) => errors.push(line),
    now,
    checkPreTool: (name, body, io) =>
      checkPreToolCall(name, body, io, {
        checkers: [],
        platform: PLATFORM,
        systemRoot: m.system,
      }),
  });
  const out = JSON.parse(stdout) as {
    hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string };
    systemMessage?: string;
  };
  return {
    decision: out.hookSpecificOutput?.permissionDecision,
    reason: out.hookSpecificOutput?.permissionDecisionReason ?? "",
    systemMessage: out.systemMessage,
    errors,
  };
}

/** Blocks `git reset --hard` and returns the exception id and the request's fingerprint. */
async function block(m: Machine, now = T0, session = "sess-1") {
  const out = await hook(m, bash(m, "git reset --hard", session), now);
  expect(out.decision).toBe("deny");
  const id = ID.exec(out.reason)?.[1] ?? "";
  const request = readRequests(m.exceptions).find((r) => r.id === id);
  expect(request).toBeDefined();
  return { id, fingerprint: request?.fingerprint ?? "" };
}

/** An Ed25519 key, as the team server holds one, and its pin. */
function signingKey(): { key: KeyObject; pin: TrustedKey } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  const id = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return { key: privateKey, pin: { id, public_key: raw.toString("base64url") } };
}

function signGrant(
  signer: { key: KeyObject; pin: TrustedKey },
  fields: Partial<ExceptionGrant> & { id: string; fingerprint: string },
): ExceptionGrant {
  const unsigned: Omit<ExceptionGrant, "signature"> = {
    schema: "selfhost.exception_grant/v2",
    nonce: randomBytes(16).toString("hex"),
    rules: ["guard.reset_hard"],
    agent: "claude_code",
    session_id: "sess-1",
    repo: "acme/web",
    requested_by: PERSON,
    approved_by: LEAD,
    decision_event_id: "019a5b02-0000-7000-8000-000000000002",
    team: "web",
    approved_at: T0.toISOString(),
    issued_at: T0.toISOString(),
    expires_at: minutes(30).toISOString(),
    key_id: signer.pin.id,
    ...fields,
  };
  const signature = sign(null, exceptionGrantPayload(unsigned), signer.key).toString("base64url");
  return { ...unsigned, signature };
}

const putGrant = (m: Machine, grant: unknown, id: string) => {
  mkdirSync(join(m.exceptions, "grants"), { recursive: true });
  writeFileSync(join(m.exceptions, "grants", `${id}.json`), JSON.stringify(grant));
};

/** A laptop in a team, with `keys` pinned in config.json (no managed settings). */
function joinWithPin(m: Machine, keys: TrustedKey[]) {
  mkdirSync(join(m.home.root, ".selfhost"), { recursive: true });
  writeFileSync(
    m.configPath,
    JSON.stringify({
      server: SERVER,
      token: "person-token",
      person: PERSON,
      team: "web",
      exception_keys: { schema: TRUST_SCHEMA, server: SERVER, keys },
    }),
  );
}

/** The root-owned trust file the managed settings install, under the test's system root. */
function installTrust(m: Machine, keys: TrustedKey[]) {
  const path = trustPath(PLATFORM, m.system) ?? "";
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, trustFileText(SERVER, keys));
}

/** What the L1 proof did: read the local key and the request, and sign a v1 grant by hand. */
function forgeWithLocalKey(m: Machine, id: string) {
  exceptionKey(m.exceptions, true);
  const key = Buffer.from(readFileSync(join(m.exceptions, "key"), "utf8").trim(), "hex");
  const request = JSON.parse(
    readFileSync(join(m.exceptions, "requests", `${id}.json`), "utf8"),
  ) as { id: string; fingerprint: string; rules: string[]; agent: string };
  const grant: Record<string, unknown> = {
    schema: "selfhost.exception_grant/v1",
    id: request.id,
    fingerprint: request.fingerprint,
    rules: request.rules,
    agent: request.agent,
    approved_by: LEAD,
    decision_event_id: "019a7000-0000-7000-8000-000000000999",
    approved_at: T0.toISOString(),
    expires_at: minutes(60).toISOString(),
  };
  grant.signature = createHmac("sha256", key)
    .update(
      `grant\n${JSON.stringify([grant.id, grant.fingerprint, grant.rules, grant.agent, grant.approved_by, grant.decision_event_id, grant.approved_at, grant.expires_at])}`,
    )
    .digest("hex");
  putGrant(m, grant, id);
  return { key, fingerprint: request.fingerprint, rules: request.rules };
}

describe("H4: an agent cannot sign its own exception in team mode", () => {
  it("a grant forged with the local key does not let the call through, and is set aside", async () => {
    const m = machine();
    joinWithPin(m, [signingKey().pin]);
    const { id } = await block(m);
    const forged = forgeWithLocalKey(m, id);
    // The solo check would take it: this is the grant the L1 proof made.
    expect(
      findGrant(m.exceptions, forged.key, forged.fingerprint, forged.rules, minutes(1)),
    ).toBeDefined();

    const out = await hook(m, bash(m, "git reset --hard"), minutes(1));
    expect(out.decision).toBe("deny");
    expect(out.errors).toEqual([
      "selfhost hook: ignored 1 one-time exception grant signed on this laptop: in team mode only the team server signs grants. Ask for the exception again.",
    ]);
    expect(existsSync(join(m.exceptions, "ignored", `${id}.json`))).toBe(true);
    expect(existsSync(join(m.exceptions, "grants", `${id}.json`))).toBe(false);
  });

  it("refuses a grant signed with a key the agent made, even if it pins it in config.json under managed settings", async () => {
    const m = machine();
    const server = signingKey();
    joinWithPin(m, [server.pin]);
    installTrust(m, [server.pin]);
    const { id, fingerprint } = await block(m);
    const agent = signingKey();
    putGrant(m, signGrant(agent, { id, fingerprint }), id);
    // The agent rewrites config.json to pin its own key: the root-owned trust file wins.
    joinWithPin(m, [agent.pin]);
    expect((await hook(m, bash(m, "git reset --hard"), minutes(1))).decision).toBe("deny");
    // Taking the membership out of config.json does not make the laptop solo either.
    writeFileSync(m.configPath, "{}");
    forgeWithLocalKey(m, id);
    expect((await hook(m, bash(m, "git reset --hard"), minutes(2))).decision).toBe("deny");
  });
});

describe("a server-signed grant on the laptop", () => {
  async function granted(changes: Partial<ExceptionGrant> = {}) {
    const m = machine();
    const server = signingKey();
    joinWithPin(m, [server.pin]);
    const { id, fingerprint } = await block(m);
    const grant = signGrant(server, { id, fingerprint, ...changes });
    putGrant(m, grant, id);
    return { m, server, id, fingerprint, grant };
  }

  it("lets the identical call through once, then the nonce is spent", async () => {
    const { m, id, grant } = await granted();
    const out = await hook(m, bash(m, "git  reset --hard "), minutes(1));
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toContain(`${LEAD} approved exception ${id}`);
    expect(existsSync(join(m.exceptions, "nonces", `${grant.nonce}.json`))).toBe(true);
    expect(existsSync(join(m.exceptions, "used", `${id}.json`))).toBe(true);
    expect((await hook(m, bash(m, "git reset --hard"), minutes(2))).decision).toBe("deny");
  });

  it("refuses a replay: the used grant copied back into grants/", async () => {
    const { m, id } = await granted();
    await hook(m, bash(m, "git reset --hard"), minutes(1));
    copyFileSync(
      join(m.exceptions, "used", `${id}.json`),
      join(m.exceptions, "grants", `${id}.json`),
    );
    expect((await hook(m, bash(m, "git reset --hard"), minutes(2))).decision).toBe("deny");
  });

  it("refuses a tampered grant", async () => {
    const { m, id, grant } = await granted({ session_id: "sess-other" });
    putGrant(m, { ...grant, session_id: "sess-1" }, id);
    expect((await hook(m, bash(m, "git reset --hard"), minutes(1))).decision).toBe("deny");
    putGrant(m, { ...grant, session_id: "sess-1", expires_at: minutes(600).toISOString() }, id);
    expect((await hook(m, bash(m, "git reset --hard"), minutes(1))).decision).toBe("deny");
  });

  it("is for the session that asked", async () => {
    const { m } = await granted();
    expect((await hook(m, bash(m, "git reset --hard", "sess-2"), minutes(1))).decision).toBe(
      "deny",
    );
  });

  it("is for the repository that asked", async () => {
    const { m } = await granted({ repo: "acme/other" });
    expect((await hook(m, bash(m, "git reset --hard"), minutes(1))).decision).toBe("deny");
  });

  it("is for the call that asked", async () => {
    const { m } = await granted();
    expect((await hook(m, bash(m, "git reset --hard HEAD~1"), minutes(1))).decision).toBe("deny");
  });

  it("is for the person whose agent asked", async () => {
    const { m } = await granted({ requested_by: "someone@example.com" });
    expect((await hook(m, bash(m, "git reset --hard"), minutes(1))).decision).toBe("deny");
  });

  it("expires", async () => {
    const { m } = await granted();
    expect((await hook(m, bash(m, "git reset --hard"), minutes(31))).decision).toBe("deny");
  });

  it("is claimed by one hook of several", async () => {
    const { m, grant } = await granted();
    const results = [claimServerGrant(m.exceptions, grant), claimServerGrant(m.exceptions, grant)];
    expect(results).toEqual([true, false]);
  });

  it("verifies only with a pinned key and the exact fields signed", () => {
    const server = signingKey();
    const grant = signGrant(server, {
      id: "019a5b01-0000-7000-8000-000000000001",
      fingerprint: "ab".repeat(32),
    });
    expect(verifyServerGrant(grant, [server.pin])).toBe(true);
    expect(verifyServerGrant(grant, [signingKey().pin])).toBe(false);
    expect(verifyServerGrant({ ...grant, rules: ["guard.reset_hard", "x"] }, [server.pin])).toBe(
      false,
    );
    expect(verifyServerGrant({ ...grant, signature: "A".repeat(86) }, [server.pin])).toBe(false);
  });
});

describe("team mode against the real server", () => {
  async function team() {
    const ledger = await openLedger({ dataDir: "memory://" });
    ledgers.push(ledger);
    let clock = T0;
    const now = () => clock;
    const app = createApp({ version: "test", ledger, token: "admin-token", now });
    const fetch = async (url: string, init: RequestInit) => app.request(url, init);
    const admin = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const created = (await (
      await admin("/v1/teams", { name: "Web" })
    ).json()) as CreateTeamResponse;
    const join = async (person: string) =>
      (
        (await (
          await app.request("/v1/join", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ invite: created.invite, person }),
          })
        ).json()) as JoinResponse
      ).token;
    // The first person to join a new team is its owner.
    const lead = await join(LEAD);
    const dev = await join(PERSON);
    return {
      ledger,
      fetch,
      dev,
      refresh: () => refreshReviewList(ledger, openReviewList(ledger, { now })),
      approve: (id: string) =>
        app.request(`/v1/review-items/${id}/decision`, {
          method: "POST",
          headers: { authorization: `Bearer ${lead}`, "content-type": "application/json" },
          body: JSON.stringify({ verdict: "approve" }),
        }),
      grantOf: async (id: string) =>
        (await (
          await app.request(`/v1/exception-grants/${id}`, {
            headers: { authorization: `Bearer ${dev}` },
          })
        ).json()) as ExceptionGrantStatus,
      setNow(at: Date) {
        clock = at;
      },
    };
  }

  it("pins the keys, pulls the signed grant, allows the call once and reports the use", async () => {
    const m = machine();
    const t = await team();
    saveMembership(m.configPath, { server: SERVER, token: t.dev, person: PERSON, team: "web" });
    const client = new TeamClient(SERVER, t.dev, t.fetch);
    const pinned = await pinExceptionKeys(client, m.configPath);
    expect(pinned).toHaveLength(1);

    const { id } = await block(m);
    // The sync sends the block, as selfhost import does.
    await drainSpool(new RemoteWriter(client, { person: PERSON, retries: 0 }), m.spool, {
      person: PERSON,
      now: T0,
      repoOf: () => "acme/web",
    });
    await t.refresh();
    const where = { platform: PLATFORM, systemRoot: m.system } as const;
    expect(await pullGrants(client, m.configPath, minutes(1), where)).toBe(0);
    expect(readRequests(m.exceptions).map((r) => r.id)).toEqual([id]);

    t.setNow(minutes(2));
    expect((await t.approve(id)).status).toBe(200);
    expect(await pullGrants(client, m.configPath, minutes(3), where)).toBe(1);
    const grant = JSON.parse(
      readFileSync(join(m.exceptions, "grants", `${id}.json`), "utf8"),
    ) as ExceptionGrant;
    expect(grant).toMatchObject({
      schema: "selfhost.exception_grant/v2",
      session_id: "sess-1",
      repo: "acme/web",
      requested_by: PERSON,
      approved_by: LEAD,
    });

    const allowed = await hook(m, bash(m, "git reset --hard"), minutes(4));
    expect(allowed.decision).toBeUndefined();
    expect(allowed.systemMessage).toContain(`approved exception ${id}`);
    expect((await hook(m, bash(m, "git reset --hard"), minutes(5))).decision).toBe("deny");

    // The next sync reports the use; the server hands the grant out no more.
    await pullGrants(client, m.configPath, minutes(6), where);
    expect((await t.grantOf(id)).state).toBe("used");
  });
});

describe("solo mode is unchanged", () => {
  it("still takes a grant signed with the local key, which is all solo mode promises", async () => {
    const m = machine();
    const { id } = await block(m);
    forgeWithLocalKey(m, id);
    const out = await hook(m, bash(m, "git reset --hard"), minutes(1));
    expect(out.decision).toBeUndefined();
    expect(out.errors).toEqual([]);
  });
});

describe("pins, managed settings and doctor", () => {
  const doctorOf = (m: Machine) =>
    doctorReport({
      cwd: m.workspace.root,
      env: { HOME: m.home.root },
      version: "test",
      write: () => {},
      configPath: m.configPath,
      platform: PLATFORM,
      systemRoot: m.system,
      home: m.home.root,
    });

  it("warns when the server key is pinned only in config.json, which an agent can rewrite", () => {
    const m = machine();
    joinWithPin(m, [signingKey().pin]);
    const { exceptions } = doctorOf(m);
    expect(exceptions).toMatchObject({ mode: "team", pinned: "config", keys: 1 });
    expect(exceptions.warnings).toEqual([
      expect.stringMatching(
        /A coding agent running as you can write that file and pin a key of its own/,
      ),
    ]);
  });

  it("says solo mode holds only against agents that follow the rules", () => {
    const m = machine();
    expect(doctorOf(m).exceptions).toEqual({
      mode: "solo",
      pinned: "none",
      path: null,
      keys: 0,
      warnings: [],
    });
  });

  it("installs the trust file and an absolute hook path, and doctor checks both", () => {
    const m = machine();
    const server = signingKey();
    joinWithPin(m, [server.pin]);
    mkdirSync(m.home.path(".claude"), { recursive: true });
    writeFileSync(teamPolicyPath(m.configPath), "version = 1\n");
    const binary = m.home.write("bin/selfhost", "#!/bin/sh\n", 0o755);
    const { report } = installTeamManaged(
      m.configPath,
      { server: SERVER, token: "person-token", person: PERSON, team: "web" },
      {
        platform: PLATFORM,
        systemRoot: m.system,
        hostname: "test",
        version: "test",
        agents: {
          home: m.home.root,
          env: {},
          platform: PLATFORM,
          which: (name) => (name === "selfhost" ? binary : undefined),
          root: m.system,
        },
      },
      false,
    );
    expect(report?.files.map((file) => [file.vendor, file.status])).toEqual([
      ["claude_code", "written"],
      ["selfhost", "written"],
    ]);
    const real = realpathSync(binary);
    const settings = readFileSync(
      join(m.system, "etc/claude-code/managed-settings.d/selfhost.json"),
      "utf8",
    );
    expect(settings).toContain(`${real} hook claude_code`);
    const trust = JSON.parse(readFileSync(trustPath(PLATFORM, m.system) ?? "", "utf8"));
    expect(trust).toEqual({ schema: TRUST_SCHEMA, server: SERVER, keys: [server.pin] });

    const doctor = doctorOf(m);
    expect(doctor.exceptions).toMatchObject({ mode: "team", pinned: "managed", keys: 1 });
    // Under a test folder the user can write both, which doctor reports.
    expect(doctor.exceptions.warnings).toEqual([expect.stringMatching(/you can write/)]);
    expect(doctor.managed_hooks).toEqual([
      expect.objectContaining({ agent: "claude_code", binaries: [real], writable: real }),
    ]);
  });

  it("warns when the managed hook runs selfhost through PATH", () => {
    const m = machine();
    const path = join(m.system, "etc/claude-code/managed-settings.d/selfhost.json");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "selfhost hook claude_code" }] }],
        },
      }),
    );
    expect(doctorOf(m).managed_hooks).toEqual([
      expect.objectContaining({ agent: "claude_code", binaries: [], writable: null }),
    ]);
    expect(readdirSync(join(path, ".."))).toEqual(["selfhost.json"]);
  });
});
