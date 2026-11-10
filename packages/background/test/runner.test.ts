import { backgroundRunValidator, validateEvent } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import { GATE_CHECK_NAME, type StartResult } from "../src/index.js";
import { HEAD_SHA, harness } from "./harness.js";

function started(result: StartResult) {
  if ("refused" in result) throw new Error(`refused: ${result.refused}`);
  return result;
}

const claudeLine = (name: string, input: unknown, id: string) =>
  `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } })}\n`;

describe("background run lifecycle", () => {
  it("clones on a new branch, installs the agent and hooks, runs it, gates, opens one PR and stops the sandbox", async () => {
    const h = harness({
      agent: async ({ print }) => {
        print(claudeLine("Edit", { file_path: "src/login.ts" }, "t1"));
        print("plain progress line\n");
        return 0;
      },
    });
    const { run, done } = started(await h.runner.start(h.request()));
    expect(run.state).toBe("queued");
    expect(run.branch).toMatch(
      /^claude\/selfhost-fix-the-login-bug-where-empty-passwords-[a-z0-9]{8}$/,
    );
    const final = await done;

    expect(final.state).toBe("succeeded");
    expect(final.pr_url).toBe("https://github.com/acme/web/pull/7");
    expect(final.base).toBe("main");
    expect(final.credential).toBe("none");
    expect(final.gate?.result).toBe("passed");
    expect(backgroundRunValidator.validate(final).ok).toBe(true);
    expect(h.states(run.id)).toEqual([
      "queued",
      "starting",
      "running",
      "testing",
      "pushing",
      "succeeded",
    ]);

    const sandbox = [...h.runtime.sandboxes.values()][0];
    expect(sandbox).toBeDefined();
    expect(await sandbox?.status()).toBe("stopped");
    expect(sandbox?.spec.labels).toMatchObject({ selfhost_run: run.id, selfhost_team: "platform" });
    const commands = sandbox?.commands ?? [];
    expect(commands.some((c) => c.includes("clone --quiet https://github.com/acme/web.git"))).toBe(
      true,
    );
    expect(commands).toContain(`git checkout -b '${run.branch}'`);
    expect(
      commands.some(
        (c) => c.startsWith("command -v claude") && c.includes("@anthropic-ai/claude-code"),
      ),
    ).toBe(true);
    expect(
      commands.some((c) => c.startsWith("command -v selfhost") && c.includes("selfhostai@'0.4.0'")),
    ).toBe(true);
    expect(commands.some((c) => c.startsWith("claude -p 'Fix the login bug"))).toBe(true);
    expect(commands).toContain(`git push -q -u origin '${run.branch}'`);

    const settings = new TextDecoder().decode(
      sandbox?.files.get("/home/user/.claude/settings.json"),
    );
    expect(settings).toContain("selfhost hook claude_code");
    expect(settings).toContain("PreToolUse");
    expect(
      new TextDecoder().decode(sandbox?.files.get("/home/user/.selfhost/run/selfhost.toml")),
    ).toBe("version = 1\n");

    expect(h.pulls).toHaveLength(1);
    expect(h.pulls[0]).toMatchObject({ repo: "acme/web", head: run.branch, base: "main" });
    expect(h.pulls[0]?.body).toContain(
      "Generated with [Claude Code](https://claude.com/claude-code)",
    );
    expect(h.checks).toEqual([
      expect.objectContaining({ name: GATE_CHECK_NAME, conclusion: "success", headSha: HEAD_SHA }),
    ]);

    const kinds = h.kinds(run.id);
    expect(kinds).toContain("run.triggered");
    expect(kinds).toContain("run.output");
    expect(kinds).toContain("run.gate");
    expect(kinds).toContain("pr.opened");
    expect(kinds).toContain("policy.evaluated");
    for (const event of h.events) expect(validateEvent(event)).toMatchObject({ ok: true });
    const output = h.events
      .filter((e) => e.kind === "run.output")
      .flatMap((e) => ((e.data?.output ?? {}) as { lines: string[] }).lines);
    expect(output).toContain("plain progress line");
    const hook = h.events.find((e) => e.kind === "policy.evaluated");
    expect(hook).toMatchObject({ run_id: run.id, team: "platform", repo: "acme/web" });

    const last = h.events.filter((e) => e.kind === "run.updated").at(-1);
    expect(((last?.data?.background_run ?? {}) as { cost: unknown }).cost).toEqual(final.cost);
    expect(final.cost.model_usd).toBe(0.25);
    expect(h.alerts).toEqual([]);
  });

  it("gives two runs on the same repo their own sandbox and branch", async () => {
    const h = harness();
    const a = started(await h.runner.start(h.request()));
    const b = started(await h.runner.start(h.request()));
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect(ra.branch).not.toBe(rb.branch);
    expect(ra.state).toBe("succeeded");
    expect(rb.state).toBe("succeeded");
    expect(h.runtime.sandboxes.size).toBe(2);
    expect(h.pulls.map((p) => p.head).sort()).toEqual([ra.branch, rb.branch].sort());
  });

  it("stops a run with no output after stall_minutes and routes a stuck item to its owner", async () => {
    const h = harness({
      toml: 'version = 1\n[runtime]\ndefault = "e2b"\n[background]\nstall_minutes = 3\n',
      agent: ({ stopped }) => stopped.then(() => 0),
    });
    const { run, done } = started(await h.runner.start(h.request()));
    await h.agentStarted();
    await h.clock.advance(2.5 * 60_000);
    expect((await h.store.get(run.id))?.health?.status).toBe("quiet");
    await h.clock.advance(60_000);
    const final = await done;
    expect(final.state).toBe("stuck");
    expect(final.reason).toMatch(/no output for 3m/);
    expect(final.health).toMatchObject({ status: "stuck", reason: "no_output" });
    expect(h.pulls).toEqual([]);
    const alert = h.events.find((e) => e.kind === "alert.raised");
    expect(alert).toMatchObject({
      run_id: run.id,
      actor: { kind: "person", id: "alice@example.com" },
      data: { alert: "run_stuck" },
    });
    expect(h.alerts.map((a) => a.kind)).toEqual(["run_stuck"]);
    expect(await [...h.runtime.sandboxes.values()][0]?.status()).toBe("stopped");
    expect(h.kinds(run.id)).toContain("run.health");
  });

  it("stops a run that repeats the same tool call loop_repeats times", async () => {
    const h = harness({
      toml: 'version = 1\n[runtime]\ndefault = "e2b"\n[background]\nloop_repeats = 4\n',
      agent: async ({ print, stopped }) => {
        for (let i = 0; i < 5; i++) print(claudeLine("Bash", { command: "npm test" }, `call-${i}`));
        await stopped;
        return 0;
      },
    });
    const { done } = started(await h.runner.start(h.request()));
    await h.agentStarted();
    await h.clock.advance(30_000);
    const final = await done;
    expect(final.state).toBe("stuck");
    expect(final.health).toMatchObject({ status: "stuck", reason: "loop", repeats: 5 });
  });

  it("times out a run past its timeout and stops the sandbox", async () => {
    const h = harness({
      agent: async ({ print, stopped }) => {
        print("working\n");
        await stopped;
        return 0;
      },
    });
    const { done } = started(await h.runner.start(h.request({ timeoutMinutes: 2 })));
    const agent = await h.agentStarted();
    for (let i = 0; i < 5; i++) {
      agent.print("still working\n");
      await h.clock.advance(30_000);
    }
    const final = await done;
    expect(final.state).toBe("timed_out");
    expect(final.reason).toBe("Ran past its 2 minute timeout");
    expect(h.alerts.map((a) => a.kind)).toEqual(["run_timed_out"]);
  });

  it("retries a sandbox that could not be created, under the same run", async () => {
    const h = harness({ createFailures: 1 });
    const { run, done } = started(await h.runner.start(h.request()));
    const final = await done;
    expect(final.state).toBe("succeeded");
    expect(final.attempt).toBe(2);
    const attempts = h.events
      .filter((e) => e.run_id === run.id && e.kind === "run.updated")
      .map((e) => ((e.data?.background_run ?? {}) as { attempt: number }).attempt);
    expect(attempts).toContain(2);
    expect(h.states(run.id)).toEqual([
      "queued",
      "starting",
      "starting",
      "running",
      "testing",
      "pushing",
      "succeeded",
    ]);
  });

  it("fails after the last retry", async () => {
    const h = harness({ createFailures: 5 });
    const final = await started(await h.runner.start(h.request())).done;
    expect(final.state).toBe("failed");
    expect(final.attempt).toBe(2);
    expect(final.reason).toMatch(/could not be created: 503/);
    expect(h.events.some((e) => e.kind === "alert.raised" && e.data?.alert === "run_failed")).toBe(
      true,
    );
  });

  it("cancels a run on request and raises no alert", async () => {
    const h = harness({ agent: ({ stopped }) => stopped.then(() => 0) });
    const { run, done } = started(await h.runner.start(h.request()));
    await h.agentStarted();
    await h.runner.cancel(run.id, "bob@example.com");
    const final = await done;
    expect(final.state).toBe("cancelled");
    expect(final.cancel).toMatchObject({ by: "bob@example.com", scope: "run" });
    expect(final.reason).toBe("Stopped by bob@example.com");
    expect(h.alerts).toEqual([]);
  });

  it("team kill switch stops every run of the team and refuses new ones until cleared", async () => {
    const h = harness({ agent: ({ stopped }) => stopped.then(() => 0) });
    const a = started(await h.runner.start(h.request()));
    await h.agentStarted();
    const killed = await h.runner.kill("team", "platform", "carol@example.com", "incident");
    expect(killed).toEqual({ active: true, stopped: [a.run.id] });
    expect((await a.done).state).toBe("cancelled");
    expect((await h.store.get(a.run.id))?.cancel).toMatchObject({
      by: "carol@example.com",
      scope: "team",
    });

    const refused = await h.runner.start(h.request());
    expect(refused).toMatchObject({ code: "killed", status: 409 });
    const triggers = h.events.filter((e) => e.kind === "run.triggered");
    expect(triggers.at(-1)?.data?.trigger).toMatchObject({ accepted: false });

    expect(await h.runner.clearKill("team", "platform", "carol@example.com")).toBe(true);
    const again = await h.runner.start(h.request());
    expect("run" in again).toBe(true);
  });

  it("does not start when the person has no login on the runtime", async () => {
    const h = harness({
      credentials: async () => ({
        refused:
          "alice@example.com has no Claude login on e2b: run `selfhost run login --agent claude --runtime e2b`",
      }),
    });
    const final = await started(await h.runner.start(h.request())).done;
    expect(final.state).toBe("failed");
    expect(final.reason).toContain("selfhost run login");
    expect(h.runtime.sandboxes.size).toBe(0);
  });

  it("records the credential kind and passes secrets by reference", async () => {
    const revoked: (string | undefined)[] = [];
    let seen: { runtime: string; runtimeSetting?: string } | undefined;
    const h = harness({
      credentials: async (_run, { runtime, config }) => {
        seen = {
          runtime: runtime.kind,
          ...(config.runtime?.default ? { runtimeSetting: config.runtime.default } : {}),
        };
        return {
          kind: "team_api_key",
          secrets: [{ name: "GITHUB_TOKEN", from: "github-app:acme/web" }],
          egress: { allow: ["github.com", "*.anthropic.com"] },
          revoke: async (reason) => {
            revoked.push(reason);
          },
        };
      },
    });
    const final = await started(
      await h.runner.start(
        h.request({
          person: null,
          trigger: { source: "schedule", sender: "nightly", person: null },
        }),
      ),
    ).done;
    expect(final.credential).toBe("team_api_key");
    expect(revoked).toEqual(["succeeded"]);
    expect(seen).toEqual({ runtime: "e2b", runtimeSetting: "e2b" });
    const sandbox = [...h.runtime.sandboxes.values()][0];
    expect(sandbox?.spec.secrets).toEqual([{ name: "GITHUB_TOKEN", from: "github-app:acme/web" }]);
    expect(sandbox?.spec.egress).toEqual({ allow: ["github.com", "*.anthropic.com"] });
    const updated = h.events.find(
      (e) =>
        e.kind === "run.updated" &&
        ((e.data?.background_run ?? {}) as { credential?: string }).credential,
    );
    expect(((updated?.data?.background_run ?? {}) as { credential: string }).credential).toBe(
      "team_api_key",
    );
  });

  it("builds the sandbox from the broker's spec, masks the run's secrets and revokes as killed on cancel", async () => {
    const revoked: (string | undefined)[] = [];
    const h = harness({
      credentials: async () => ({
        kind: "gateway_key",
        secrets: [{ name: "ANTHROPIC_AUTH_TOKEN", from: "gateway:run" }],
        spec: (base) => ({
          ...base,
          env: { ...base.env, ANTHROPIC_BASE_URL: "https://gw.example.com/anthropic" },
          secrets: [{ name: "ANTHROPIC_AUTH_TOKEN", from: "gateway:run" }],
          egress: { allow: ["github.com", "gw.example.com"] },
        }),
        mask: (text) => text.replaceAll("sk-run-123", "[redacted:run]"),
        gaps: ["egress: modal cannot hold a wildcard host"],
        revoke: async (reason) => {
          revoked.push(reason);
        },
      }),
      agent: async ({ print, stopped }) => {
        print("using key sk-run-123 now\n");
        await stopped;
        return 0;
      },
    });
    const { run, done } = started(await h.runner.start(h.request()));
    await h.agentStarted();
    await h.clock.advance(30_000);
    await h.runner.cancel(run.id, "bob@example.com");
    const final = await done;
    expect(final.credential).toBe("gateway_key");
    const sandbox = [...h.runtime.sandboxes.values()][0];
    expect(sandbox?.spec.env).toMatchObject({
      SELFHOST_RUN_ID: run.id,
      ANTHROPIC_BASE_URL: "https://gw.example.com/anthropic",
    });
    expect(sandbox?.spec.egress).toEqual({ allow: ["github.com", "gw.example.com"] });
    const lines = h.events
      .filter((e) => e.kind === "run.output")
      .flatMap((e) => ((e.data?.output ?? {}) as { lines: string[] }).lines);
    expect(lines).toEqual(["using key [redacted:run] now"]);
    expect(revoked).toEqual(["killed"]);
  });

  it("fails without a sandbox when the broker cannot issue credentials", async () => {
    const h = harness({
      credentials: async () => {
        throw new Error("Credentials for run r: the GitHub App is not installed on acme/web");
      },
    });
    const final = await started(await h.runner.start(h.request())).done;
    expect(final.state).toBe("failed");
    expect(final.reason).toContain("not installed on acme/web");
    expect(h.runtime.sandboxes.size).toBe(0);
  });

  it("fails a run whose agent changed nothing, with no pull request", async () => {
    const h = harness({ files: [] });
    const final = await started(await h.runner.start(h.request())).done;
    expect(final.state).toBe("failed");
    expect(final.reason).toMatch(/without changing anything/);
    expect(h.pulls).toEqual([]);
  });

  it("fails when the agent exits non-zero", async () => {
    const h = harness({ agent: async () => 2 });
    const final = await started(await h.runner.start(h.request())).done;
    expect(final.state).toBe("failed");
    expect(final.reason).toMatch(/^claude exited 2/);
    expect(final.attempt).toBe(1);
  });
});

describe("admission", () => {
  it("refuses people outside the team or allowed list, and records every trigger", async () => {
    const h = harness({
      toml: 'version = 1\n[runtime]\ndefault = "e2b"\n[background]\nallowed = ["alice@example.com"]\n',
    });
    const refused = await h.runner.start(
      h.request({
        person: "bob@example.com",
        trigger: { source: "api", sender: "bob@example.com", person: "bob@example.com" },
      }),
    );
    expect(refused).toMatchObject({ code: "not_allowed", status: 403 });
    const unmapped = await h.runner.start(
      h.request({
        person: null,
        trigger: { source: "github_comment", sender: "octocat", person: null },
      }),
    );
    expect(unmapped).toMatchObject({ code: "not_allowed" });
    expect("refused" in unmapped && unmapped.refused).toContain("octocat is not mapped");
    const triggers = h.events.filter((e) => e.kind === "run.triggered").map((e) => e.data?.trigger);
    expect(triggers).toEqual([
      expect.objectContaining({ sender: "bob@example.com", accepted: false }),
      expect.objectContaining({ sender: "octocat", accepted: false, person: null }),
    ]);
  });

  it("limits runs per hour and runs at once", async () => {
    const h = harness({
      toml: 'version = 1\n[runtime]\ndefault = "e2b"\n[background]\nrate_limit_per_hour = 2\nmax_concurrent = 1\n',
      agent: ({ stopped }) => stopped.then(() => 0),
    });
    const first = started(await h.runner.start(h.request()));
    expect(await h.runner.start(h.request())).toMatchObject({ code: "rate_limited", status: 429 });
    await h.runner.cancel(first.run.id, "alice@example.com");
    await first.done;
    started(await h.runner.start(h.request()));
    const third = await h.runner.start(h.request());
    expect("refused" in third && third.refused).toMatch(/started 2 runs in the last hour/);
    await h.runner.kill("team", "platform", "alice@example.com");
    await h.runner.idle();
  });

  it("refuses when the team has no runtime", async () => {
    const h = harness({ noRuntime: true });
    const none = await h.runner.start(h.request());
    expect(none).toMatchObject({ code: "no_runtime", status: 503 });
    expect("refused" in none && none.refused).toContain("set [runtime] default");
    expect("refused" in none && none.refused).not.toContain("integrations");
  });

  it("says the runtime seam's own reason, such as the missing key", async () => {
    const message =
      "Set the environment variable E2B_API_KEY (api_key_env) where selfhost runs, to an E2B API key. It is not set.";
    const h = harness({ runtimeRefusal: { rule: "runtime.key", message } });
    const refused = await h.runner.start(h.request());
    expect(refused).toMatchObject({
      code: "no_runtime",
      status: 503,
      refused: `No runtime for team platform (runtime.key): ${message}`,
    });
  });

  it("marks runs a stopped server left going as failed", async () => {
    const h = harness();
    const { run } = started(await h.runner.start(h.request()));
    await h.runner.idle();
    await h.store.save({ ...run, state: "running", sandbox_id: "fake-e2b-1" });
    const other = harness();
    for (const [id, saved] of h.store.runs) other.store.runs.set(id, saved);
    // A fresh runner over the same store, as after a restart.
    expect(await other.runner.recover()).toEqual([run.id]);
    expect((await other.store.get(run.id))?.state).toBe("failed");
  });
});
