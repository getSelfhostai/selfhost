import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Webhooks } from "@octokit/webhooks";
import { manualClock, signWebhook } from "@selfhost/background";
import { createGitHubApp } from "@selfhost/github";
import { FAKE_HEAD_SHA, FakeGitHub } from "@selfhost/github/testing";
import { type Ledger, openLedger } from "@selfhost/ledger";
import { type ExecOptions, type FakeSandbox, fakeRuntime } from "@selfhost/runtime";
import {
  type BackgroundRun,
  type BackgroundRunsResponse,
  backgroundRunValidator,
  type CreateTeamResponse,
  EVENT_SCHEMA,
  type JoinResponse,
  parseConfig,
} from "@selfhost/schema";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  allTeams,
  BACKGROUND_WEBHOOK_PATH,
  createBackground,
  runModelCost,
  startScheduleJob,
} from "../src/background.js";
import { GITHUB_WEBHOOK_PATH } from "../src/github.js";
import { backgroundRunTests } from "../src/github-risk.js";
import { caller, TOKEN } from "./helpers.js";

const WEBHOOKS = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "github",
  "webhooks",
  "runs",
);
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const APP_ID = "123456";
const SECRET = "test-webhook-secret";
const signer = new Webhooks({ secret: SECRET });

const POLICY = `version = 1
[integrations.runtime]
tool = "e2b"
[review]
github_logins = { "lead@example.com" = "octocat" }
[background]
webhook_secret_env = "RUNS_SECRET"
[[background.schedules]]
name = "nightly"
cron = "0 2 * * *"
repo = "acme/acme-api"
task = "Update the lockfile"
`;

/** A sandbox where every step works: the agent changes a file and a test, which fails on the base. */
function answer(command: string, sandbox: FakeSandbox, options: ExecOptions) {
  const done = sandbox.commands.some((c) => c.startsWith("git add -A"));
  if (command === 'printf %s "$HOME"') return { stdout: "/home/user" };
  if (command.startsWith("git rev-parse --abbrev-ref")) return { stdout: "main\n" };
  if (command === "git rev-parse HEAD")
    return { stdout: done ? `${"2".repeat(40)}\n` : `${"1".repeat(40)}\n` };
  if (command.startsWith("git rev-list --count")) return { stdout: done ? "1\n" : "0\n" };
  if (command.startsWith("git diff --name-only"))
    return { stdout: "src/login.ts\nsrc/login.test.ts\n" };
  if (command === "ls -1A") return { stdout: "package.json\n" };
  if (command === "cat package.json") return { stdout: '{"scripts":{"test":"vitest run"}}' };
  if (command === "npm test") {
    return options.cwd?.startsWith("/tmp/selfhost-base-") ? { exitCode: 1 } : { exitCode: 0 };
  }
  if (command.startsWith("claude -p")) {
    options.onOutput?.({ stream: "stdout", text: "done\n" });
    return { exitCode: 0 };
  }
  return undefined;
}

const open: Ledger[] = [];
afterEach(async () => {
  for (const ledger of open.splice(0)) await ledger.close();
});

async function harness(env: NodeJS.ProcessEnv = { RUNS_SECRET: "runs-secret" }) {
  const ledger = await openLedger({ dataDir: "memory://" });
  open.push(ledger);
  const clock = manualClock("2026-11-09T01:59:00Z");
  const github = new FakeGitHub({ appId: APP_ID, publicKey: PUBLIC_KEY });
  github.addPull("acme/acme-api", 42, { author: "alice" });
  const app = createGitHubApp(
    { appId: APP_ID, privateKey: PRIVATE_KEY, webhookSecret: SECRET },
    { fetch: github.fetch, log: () => {} },
  );
  const runtime = fakeRuntime({ now: () => clock.now(), exec: answer });
  const parsed = parseConfig("version = 1\n");
  if (!parsed.ok) throw new Error("bad defaults");
  const lines: string[] = [];
  const background = createBackground(ledger, {
    config: parsed.config,
    version: "0.4.0",
    runtime: () => runtime,
    github: app,
    clock,
    env,
    fetch: async () => new Response("{}", { status: 404 }),
    log: (line) => lines.push(line),
  });
  const server: Hono = createApp({
    version: "test",
    ledger,
    token: TOKEN,
    github: { app, team: "web", log: (line) => lines.push(line) },
    background,
  });
  const admin = caller(server, TOKEN);
  const created = (await (
    await admin("/v1/teams", "POST", { name: "Web" })
  ).json()) as CreateTeamResponse;
  const other = (await (
    await admin("/v1/teams", "POST", { name: "Data" })
  ).json()) as CreateTeamResponse;
  const join = async (invite: string, person: string) => {
    const res = await server.request("/v1/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite, person }),
    });
    return ((await res.json()) as JoinResponse).token;
  };
  const lead = caller(server, await join(created.invite, "lead@example.com"));
  const outsider = caller(server, await join(other.invite, "dora@example.com"));
  expect((await admin("/v1/policy?team=web", "PUT", { text: POLICY })).status).toBe(200);
  return { ledger, clock, github, runtime, background, server, admin, lead, outsider, lines };
}

describe("background runs over HTTP", () => {
  it("starts a run as the calling person, opens the PR through the App and reads it back", async () => {
    const h = await harness();
    const res = await h.lead("/v1/background-runs", "POST", {
      task: "Fix the empty password login",
      repo: "acme/acme-api",
      source: "cli",
    });
    expect(res.status).toBe(202);
    const started = (await res.json()) as BackgroundRun;
    expect(started).toMatchObject({
      state: "queued",
      team: "web",
      person: "lead@example.com",
      trigger: { source: "cli" },
    });
    await h.background.runner.idle();

    const run = (await (await h.lead(`/v1/background-runs/${started.id}`)).json()) as BackgroundRun;
    expect(backgroundRunValidator.validate(run).ok).toBe(true);
    expect(run).toMatchObject({
      state: "succeeded",
      pr_url: "https://github.com/acme/acme-api/pull/43",
      runtime: "e2b",
    });
    const created = h.github.writes.find(
      (w) => w.method === "POST" && w.path === "/repos/acme/acme-api/pulls",
    );
    expect(created?.body).toMatchObject({
      head: run.branch,
      base: "main",
      title: "Fix the empty password login",
    });
    expect(h.github.checkRuns).toEqual([
      expect.objectContaining({
        name: "selfhost/tests-first",
        head_sha: FAKE_HEAD_SHA,
        conclusion: "success",
      }),
    ]);
    const opened = (await h.ledger.query({ kind: "pr.opened" })).events;
    expect(opened).toEqual([
      expect.objectContaining({
        run_id: run.id,
        links: expect.objectContaining({ pr_url: run.pr_url }),
        team: "web",
      }),
    ]);

    // Credentials came from the broker: a GitHub token for this one repository, by reference,
    // issued and revoked in the ledger, and the run marked succeeded on the revocation.
    const [sandbox] = [...h.runtime.sandboxes.values()];
    expect(sandbox?.spec.secrets).toEqual([{ name: "GITHUB_TOKEN", from: "github-app:repo" }]);
    expect(sandbox?.spec.labels).toMatchObject({ "selfhost-run": run.id, selfhost_run: run.id });
    const issued = (await h.ledger.query({ kind: "credential.issued" })).events;
    const revoked = (await h.ledger.query({ kind: "credential.revoked" })).events;
    expect(issued.map((e) => e.run_id)).toEqual([run.id]);
    expect(revoked.map((e) => e.run_id)).toEqual([run.id]);
    expect(JSON.stringify(revoked[0]?.data)).toContain('"succeeded"');

    // The gate's result is an input to the pull request's risk score.
    expect(await backgroundRunTests(h.ledger)(run.pr_url ?? "")).toBe("passed");
    expect(
      await backgroundRunTests(h.ledger)("https://github.com/acme/acme-api/pull/1"),
    ).toBeUndefined();

    // The run's model spend counts toward its live cost.
    await h.ledger.append([
      {
        id: "01930c4e-2f1a-7b2c-8d3e-00000000c057",
        schema: EVENT_SCHEMA,
        ts: "2026-11-09T02:00:00Z",
        source: "gateway",
        kind: "cost.recorded",
        actor: { kind: "person", id: "lead@example.com" },
        run_id: run.id,
        cost: {
          input_tokens: 10,
          output_tokens: 10,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          usd: 0.5,
          estimated: true,
        },
      },
    ]);
    expect(await runModelCost(h.ledger)(run.id)).toBe(0.5);
    const list = (await (await h.lead("/v1/background-runs")).json()) as BackgroundRunsResponse;
    expect(list.runs.map((r) => r.id)).toEqual([run.id]);
    expect((await h.outsider(`/v1/background-runs/${run.id}`)).status).toBe(403);
    expect(
      ((await (await h.outsider("/v1/background-runs")).json()) as BackgroundRunsResponse).runs,
    ).toEqual([]);
  });

  it("refuses the admin token and people outside the team", async () => {
    const h = await harness();
    expect(
      (await h.admin("/v1/background-runs", "POST", { task: "x", repo: "acme/web", team: "web" }))
        .status,
    ).toBe(403);
    expect(
      (
        await h.outsider("/v1/background-runs", "POST", {
          task: "x",
          repo: "acme/web",
          team: "web",
        })
      ).status,
    ).toBe(403);
    expect(
      (await h.lead("/v1/background-runs", "POST", { task: "", repo: "acme/web" })).status,
    ).toBe(400);
  });

  it("turns the team kill switch on and off, refusing runs while it is on", async () => {
    const h = await harness();
    const kill = await h.lead("/v1/background-runs/kill", "POST", {
      scope: "team",
      target: "web",
      reason: "incident",
    });
    expect(kill.status).toBe(200);
    expect(await kill.json()).toEqual({ scope: "team", target: "web", active: true, stopped: [] });
    const refused = await h.lead("/v1/background-runs", "POST", { task: "x", repo: "acme/web" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("killed");
    expect(
      ((await (await h.lead("/v1/background-runs")).json()) as BackgroundRunsResponse).kills,
    ).toEqual([expect.objectContaining({ scope: "team", target: "web", by: "lead@example.com" })]);
    expect(
      (await h.outsider("/v1/background-runs/kill", "POST", { scope: "team", target: "web" }))
        .status,
    ).toBe(403);
    expect((await h.lead("/v1/background-runs/kill?scope=team&target=web", "DELETE")).status).toBe(
      200,
    );
    expect(
      (await h.lead("/v1/background-runs", "POST", { task: "x", repo: "acme/web" })).status,
    ).toBe(202);
    await h.background.runner.idle();
  });

  it("starts a run from a /selfhost run comment by a mapped login, answers on the issue, and refuses others", async () => {
    const h = await harness();
    const payload = JSON.parse(
      readFileSync(join(WEBHOOKS, "issue_comment.created.run.json"), "utf8"),
    );
    const deliver = async (body: unknown, id: string) => {
      const text = JSON.stringify(body);
      return h.server.request(GITHUB_WEBHOOK_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": id,
          "x-github-event": "issue_comment",
          "x-hub-signature-256": await signer.sign(text),
        },
        body: text,
      });
    };
    const res = await deliver(payload, "d-run");
    expect(await res.json()).toMatchObject({ delivery: "d-run", handled: true });
    expect(await (await deliver(payload, "d-run")).json()).toMatchObject({ duplicate: true });
    await h.background.runner.idle();
    const [run] = await h.ledger.backgroundRuns.list();
    expect(run).toMatchObject({
      agent: "codex",
      person: "lead@example.com",
      trigger: {
        source: "github_comment",
        sender: "octocat",
        ref: "https://github.com/acme/acme-api/issues/42#issuecomment-9001",
      },
      task: "Add a regression test for the empty password case and fix it",
    });
    const comments = h.github.pull("acme/acme-api", 42).comments.map((c) => c.body);
    expect(comments[0]).toContain(`started background run \`${run?.id}\``);

    const stranger = {
      ...payload,
      comment: { ...payload.comment, user: { login: "mallory", type: "User" } },
    };
    expect(await (await deliver(stranger, "d-stranger")).json()).toMatchObject({ handled: false });
    expect(h.github.pull("acme/acme-api", 42).comments.at(-1)?.body).toContain(
      "mallory is not mapped to a selfhost person",
    );
    const triggers = (await h.ledger.query({ kind: "run.triggered" })).events.map((e) => [
      e.actor.id,
      e.data?.trigger,
    ]);
    expect(triggers).toEqual(
      expect.arrayContaining([
        [
          "selfhost-runner",
          expect.objectContaining({
            source: "github_comment",
            sender: "mallory",
            accepted: false,
            person: null,
          }),
        ],
        [
          "lead@example.com",
          expect.objectContaining({ source: "github_comment", sender: "octocat", accepted: true }),
        ],
      ]),
    );
  });

  it("starts a run from a signed webhook and records a refused one with a bad signature", async () => {
    const h = await harness();
    const body = JSON.stringify({
      task: "Rotate the test fixtures",
      repo: "acme/acme-api",
      sender: "lead@example.com",
      team: "web",
    });
    const send = (signature: string) =>
      h.server.request(BACKGROUND_WEBHOOK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", "x-selfhost-signature-256": signature },
        body,
      });
    expect((await send("sha256=00")).status).toBe(401);
    expect((await send(signWebhook("runs-secret", body))).status).toBe(202);
    await h.background.runner.idle();
    // The mapped person is the event's actor, which the ledger keeps; emails under data are masked.
    const triggers = (await h.ledger.query({ kind: "run.triggered" })).events.map((e) => [
      e.actor,
      e.data?.trigger,
    ]);
    expect(triggers).toEqual(
      expect.arrayContaining([
        [
          { kind: "system", id: "selfhost-runner" },
          expect.objectContaining({
            source: "webhook",
            accepted: false,
            reason: "The webhook signature does not match",
          }),
        ],
        [
          { kind: "person", id: "lead@example.com" },
          expect.objectContaining({ source: "webhook", accepted: true }),
        ],
      ]),
    );
  });

  it("starts each schedule once per due minute, with no person", async () => {
    const h = await harness();
    const job = startScheduleJob(h.ledger, h.background, allTeams(h.ledger));
    await h.clock.advance(90_000);
    await h.background.runner.idle();
    const runs = await h.ledger.backgroundRuns.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      person: null,
      task: "Update the lockfile",
      trigger: {
        source: "schedule",
        sender: "nightly",
        ref: "schedule:nightly@2026-11-09T02:00:00.000Z",
      },
    });
    await h.clock.advance(5 * 60_000);
    expect(await h.ledger.backgroundRuns.list()).toHaveLength(1);
    job.stop();
  });

  it("answers 503 when background runs are not set up", async () => {
    const ledger = await openLedger({ dataDir: "memory://" });
    open.push(ledger);
    const server = createApp({ version: "test", ledger, token: TOKEN });
    expect(
      (
        await caller(server, TOKEN)("/v1/background-runs/kill", "POST", {
          scope: "team",
          target: "web",
        })
      ).status,
    ).toBe(503);
    expect((await caller(server, TOKEN)("/v1/background-runs")).status).toBe(200);
  });
});
