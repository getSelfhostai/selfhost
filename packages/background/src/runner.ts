import type { Fetch } from "@selfhost/package-guard";
import {
  labelValue,
  type RuntimeAdapter,
  type Sandbox,
  type SandboxCost,
  type SandboxSpec,
} from "@selfhost/runtime";
import {
  BACKGROUND_RUN_SCHEMA,
  type BackgroundAgent,
  type BackgroundRun,
  type BackgroundRunState,
  backgroundSettings,
  isFinalRunState,
  type KillScope,
  type LedgerEvent,
  PERSON_VERDICTS,
  type ResolvedBackgroundConfig,
  type RunHealth,
  type RunTrigger,
  validateEvent,
} from "@selfhost/schema";
import { AGENT_CLIS, runBranch, sh } from "./agents.js";
import {
  alertEvent,
  gateEvent,
  healthEvent,
  OUTPUT_LINES_PER_EVENT,
  outputEvent,
  pullOpenedEvent,
  RUNNER_ACTOR_ID,
  triggeredEvent,
  updatedEvent,
  uuidv7,
} from "./events.js";
import { runGate } from "./gate.js";
import { HealthMonitor } from "./health.js";
import { type Prepared, prepareSandbox, RunFailure, RuntimeError, runEnv } from "./setup.js";
import {
  type Clock,
  type EventSink,
  type IssueGatewayKey,
  noCredentials,
  type PrepareCredentials,
  type RevokeReason,
  type RunAlert,
  type RunCredentials,
  type RunGitHub,
  type RunStore,
  type RuntimeFor,
  type RuntimeRefused,
  type SendAlert,
  type SettingsFor,
  systemClock,
} from "./types.js";

/** The check run the tests-first gate posts on the pull request. */
export const GATE_CHECK_NAME = "selfhost/tests-first";

/**
 * What `selfhost import --hook-events` may hand the run from the sandbox: the kinds the agent's
 * hooks map to, and the guard's own records. Anything else (decisions, pull requests, reviews,
 * credentials, run events) is not the sandbox's to write.
 */
export const HOOK_EVENT_KINDS: ReadonlySet<string> = new Set([
  "session.started",
  "session.ended",
  "prompt.submitted",
  "tool.called",
  "tool.result",
  "approval.requested",
  "cost.recorded",
  "policy.evaluated",
  "egress.blocked",
]);

/** The guard's actor and decision.by on policy.evaluated, as the CLI writes them. */
const GUARD_ACTOR_ID = "selfhost-policy";

/** Text with the run's secrets masked, once its credentials are in. */
const masked = (entry: { mask?: (text: string) => string }, text: string) =>
  entry.mask ? entry.mask(text) : text;

/** Every string in a JSON value, masked. */
function maskStrings(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map((item) => maskStrings(item, mask));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskStrings(item, mask)]),
    );
  }
  return value;
}

/** The sandbox outlives the run's own timeout by this much, so selfhost stops it first. */
const SANDBOX_GRACE_MINUTES = 5;

/** States of a run that is not over. */
export const ACTIVE_STATES: readonly BackgroundRunState[] = [
  "queued",
  "starting",
  "running",
  "testing",
  "pushing",
];

export interface RunnerOptions {
  store: RunStore;
  events: EventSink;
  /** The runtime seam: which adapter a run's sandbox goes on. */
  runtime: RuntimeFor;
  settings: SettingsFor;
  /** The credentials seam. Default: no credentials (kind none). */
  credentials?: PrepareCredentials;
  /** A per-run AI gateway key for the agent's model traffic, when the team has a gateway. */
  gateway?: IssueGatewayKey;
  /** Opens the pull request and posts the gate's check. Without it a run pushes and stops there. */
  github?: RunGitHub;
  /** Tells the run's owner about a failed, stuck or timed out run (notifications). */
  alert?: SendAlert;
  /** Model spend so far for a run: cost.recorded events carrying its run id. */
  modelCost?: (runId: string) => Promise<number>;
  /**
   * Reads what the AI gateway recorded for the run into the ledger now, called once its agent
   * is done and before its cost is figured, so model spend is not left for the next usage read.
   * `refusal` says why the gateway refused the run's key (its budget), when it did.
   */
  settleUsage?: (run: BackgroundRun) => Promise<{ refusal?: string } | undefined>;
  /**
   * Why a team may not run on a repo, or undefined when it may: the server answers from the
   * repos each team owns, so naming another team's repo does not get a write token for it.
   * Checked for every trigger. Without it every repo the GitHub App reaches is allowed.
   */
  repoAccess?: (team: string, repo: string, org: string | undefined) => Promise<string | undefined>;
  /**
   * Revokes what a run a previous process left going still holds (its gateway key; a GitHub
   * token's expiry is recorded), called by recover() for each such run once it is marked failed.
   */
  orphaned?: (run: BackgroundRun) => Promise<void>;
  /**
   * Why a run may not go on the runtime picked for it, or undefined when it may: the server
   * refuses a runtime that cannot hold the team's enforced [egress] allow list.
   */
  admit?: (
    run: BackgroundRun,
    runtime: RuntimeAdapter,
    config: Awaited<ReturnType<SettingsFor>>["config"],
  ) => string | undefined;
  /** Registry lookups for the gate's dependency check. Without it they are skipped. */
  fetch?: Fetch;
  clock?: Clock;
  /** The selfhost CLI version installed in sandboxes that lack one. */
  selfhostVersion: string;
  log?: (line: string) => void;
}

export interface StartRequest {
  team: string;
  repo: string;
  task: string;
  agent?: BackgroundAgent;
  /** A runtime kind the caller asked for; the runtime seam decides. */
  runtime?: string;
  base?: string;
  timeoutMinutes?: number;
  /** The person the run works for and whose login it uses; null for schedules and team triggers. */
  person: string | null;
  trigger: RunTrigger;
}

export type Refusal = {
  refused: string;
  /** HTTP status the API answers with. */
  status: 403 | 409 | 429 | 503;
  code: "not_allowed" | "killed" | "rate_limited" | "no_runtime";
};

export type StartResult = { run: BackgroundRun; done: Promise<BackgroundRun> } | Refusal;

export interface Runner {
  /**
   * Checks the trigger (allowed list, kill switches, rate limits, a runtime), records it in the
   * ledger whatever the answer, and starts the run in the background. `done` settles when it ends.
   */
  start(request: StartRequest): Promise<StartResult>;
  /** Stops one run. undefined when there is no such run; the run as it is when it was final. */
  cancel(id: string, by: string): Promise<BackgroundRun | undefined>;
  /** Turns a team or org kill switch on and stops every run in its scope. */
  kill(
    scope: KillScope,
    target: string,
    by: string,
    reason?: string,
  ): Promise<{ active: boolean; stopped: string[] }>;
  clearKill(scope: KillScope, target: string, by: string): Promise<boolean>;
  /**
   * Marks runs a previous process left going as failed and stops their sandboxes. Call it once
   * on start, before any run starts.
   */
  recover(): Promise<string[]>;
  /** Waits for every run this process is driving. */
  idle(): Promise<void>;
}

interface Stop {
  state: Extract<BackgroundRunState, "cancelled" | "timed_out" | "stuck" | "failed">;
  reason: string;
  /** Lost sandboxes are a runtime error: the attempt may be tried again. */
  retry?: boolean;
  health?: RunHealth;
}

class Stopped extends Error {
  constructor(readonly stop: Stop) {
    super(stop.reason);
  }
}

interface Live {
  run: BackgroundRun;
  stop?: Stop;
  sandbox?: Sandbox;
  phase: "setup" | "agent" | "after";
  health?: HealthMonitor;
  pending: string[];
  partial: string;
  costs: SandboxCost[];
  lastStatus?: RunHealth["status"];
  /** The gateway's usage for the run, once read at its end. */
  settled?: Promise<{ refusal?: string } | undefined>;
  /** Masks the run's secret values, from the credentials seam. */
  mask?: (text: string) => string;
  /** Writes of the run, one at a time, so a watchdog write never undoes a state change. */
  writes: Promise<unknown>;
  halt(stop: Stop): Promise<void>;
  done: Promise<BackgroundRun>;
}

const firstLine = (text: string, max = 72) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Why a run has no runtime, as the person who started it sees it: the runtime seam's own reason
 * (the rule and what to change) when it gave one.
 */
function noRuntime(team: string, found: RuntimeRefused | undefined): string {
  if (found) return `No runtime for team ${team} (${found.refusal.rule}): ${found.refusal.message}`;
  return `No runtime is set up for team ${team}: set [runtime] default in its selfhost.toml, with that runtime's key in the team server's environment`;
}

export function createRunner(options: RunnerOptions): Runner {
  const { store, events, clock = systemClock } = options;
  const log = options.log ?? (() => {});
  const live = new Map<string, Live>();

  const append = async (list: LedgerEvent[]) => {
    const valid = list.filter((event) => {
      const ok = validateEvent(event).ok;
      if (!ok) log(`background: dropped an invalid ${event.kind} event for ${event.run_id}`);
      return ok;
    });
    if (valid.length === 0) return;
    try {
      await events.append(valid);
    } catch (error) {
      log(`background: could not record ${valid.length} events: ${message(error)}`);
    }
  };

  function save(entry: Live, patch: Partial<BackgroundRun>): Promise<void> {
    const write = entry.writes.then(async () => {
      entry.run = await store.save({
        ...entry.run,
        ...patch,
        updated_at: clock.now().toISOString(),
      });
    });
    entry.writes = write.catch(() => {});
    return write;
  }

  async function moveTo(
    entry: Live,
    state: BackgroundRunState,
    patch: Partial<BackgroundRun> = {},
  ) {
    await save(entry, { ...patch, state });
    await append([updatedEvent(entry.run, clock.now())]);
  }

  function flushLines(entry: Live, all = false): LedgerEvent[] {
    if (all && entry.partial) {
      entry.pending.push(entry.partial);
      entry.partial = "";
    }
    const out: LedgerEvent[] = [];
    const mask = entry.mask ?? ((text: string) => text);
    while (entry.pending.length > 0) {
      const lines = entry.pending.splice(0, OUTPUT_LINES_PER_EVENT).map(mask);
      out.push(outputEvent(entry.run, lines, clock.now()));
    }
    return out;
  }

  /**
   * Hook events from the sandbox's spool, mapped by the same selfhost CLI a laptop runs. The
   * sandbox runs the agent's code, so its output is only trusted as far as hooks go: kinds a
   * hook writes, as the run's person (or the runner) and agent, or as the policy engine for the
   * guard's own records, tied to the run and with the run's secrets masked.
   */
  async function hookEvents(entry: Live, prepared: Prepared): Promise<LedgerEvent[]> {
    const sandbox = entry.sandbox;
    if (!sandbox) return [];
    try {
      const result = await sandbox.exec("selfhost import --hook-events", {
        cwd: prepared.dir,
        env: runEnv(entry.run, prepared.home, false),
        timeoutMs: 60_000,
      });
      if (result.exitCode !== 0) return [];
      const out: LedgerEvent[] = [];
      for (const line of result.stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const event = fromSandbox(entry, JSON.parse(line) as LedgerEvent);
          if (event) out.push(event);
        } catch {
          // A line that is not an event is skipped.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** One event the sandbox printed, as the run may record it, or undefined when it may not. */
  function fromSandbox(entry: Live, event: LedgerEvent): LedgerEvent | undefined {
    if (event === null || typeof event !== "object" || !HOOK_EVENT_KINDS.has(event.kind)) {
      return undefined;
    }
    const run = entry.run;
    const guard = event.kind === "policy.evaluated" || event.kind === "egress.blocked";
    const decision = event.decision;
    if (decision && (PERSON_VERDICTS as readonly string[]).includes(decision.verdict)) {
      return undefined;
    }
    const actor: LedgerEvent["actor"] = guard
      ? { kind: "system", id: GUARD_ACTOR_ID }
      : run.person
        ? { kind: "person", id: run.person }
        : { kind: "system", id: RUNNER_ACTOR_ID };
    const mask = entry.mask ?? ((text: string) => text);
    const masked = maskStrings(event, mask) as LedgerEvent;
    return {
      ...masked,
      source: "hook",
      actor,
      agent: { ...(masked.agent ?? {}), vendor: AGENT_CLIS[run.agent].vendor },
      ...(decision
        ? { decision: { ...masked.decision, by: GUARD_ACTOR_ID } as LedgerEvent["decision"] }
        : {}),
      team: run.team,
      ...(run.org ? { org: run.org } : {}),
      repo: run.repo,
      run_id: run.id,
    };
  }

  /** Reads the run's gateway usage once; a failed read leaves it to the periodic one. */
  function settle(entry: Live): Promise<{ refusal?: string } | undefined> {
    entry.settled ??= (options.settleUsage?.(entry.run) ?? Promise.resolve(undefined)).catch(
      (error) => {
        log(`background: ${entry.run.id}: reading its gateway usage failed: ${message(error)}`);
        return undefined;
      },
    );
    return entry.settled;
  }

  async function costOf(entry: Live): Promise<BackgroundRun["cost"]> {
    let runtime = 0;
    let source: "provider" | "list_price" = "list_price";
    for (const cost of entry.costs) {
      runtime += cost.usd;
      if (cost.source === "provider") source = "provider";
    }
    if (entry.sandbox) {
      try {
        const current = await entry.sandbox.cost();
        runtime += current.usd;
        if (current.source === "provider") source = "provider";
      } catch {
        // The last figure stands when the sandbox does not answer.
        return entry.run.cost;
      }
    }
    const model = (await options.modelCost?.(entry.run.id).catch(() => 0)) ?? 0;
    const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
    return {
      runtime_usd: round(runtime),
      model_usd: round(model),
      usd: round(runtime + model),
      source,
    };
  }

  async function settingsOf(team: string): Promise<{
    background: ResolvedBackgroundConfig;
    settings: Awaited<ReturnType<SettingsFor>>;
  }> {
    const settings = await options.settings(team);
    return { settings, background: backgroundSettings(settings.config) };
  }

  /** One watchdog pass: cancel, kill switches, timeout, sandbox heartbeat, health and cost. */
  async function tick(entry: Live, deadline: number) {
    if (entry.stop) return;
    const now = clock.now();
    const fresh = await store.get(entry.run.id).catch(() => undefined);
    if (fresh?.cancel && !entry.run.cancel) {
      entry.run = { ...entry.run, cancel: fresh.cancel };
      const by =
        fresh.cancel.scope === "run"
          ? fresh.cancel.by
          : `the ${fresh.cancel.scope} kill switch (${fresh.cancel.by})`;
      return entry.halt({ state: "cancelled", reason: `Stopped by ${by}` });
    }
    const kills = await store
      .activeKills({ teams: [entry.run.team], ...(entry.run.org ? { orgs: [entry.run.org] } : {}) })
      .catch(() => []);
    const kill = kills[0];
    if (kill) {
      entry.run = {
        ...entry.run,
        cancel: { by: kill.by, at: now.toISOString(), scope: kill.scope },
      };
      return entry.halt({
        state: "cancelled",
        reason: `Stopped by the ${kill.scope} kill switch (${kill.by})`,
      });
    }
    if (now.getTime() >= deadline) {
      return entry.halt({
        state: "timed_out",
        reason: `Ran past its ${entry.run.timeout_minutes} minute timeout`,
      });
    }
    const sandbox = entry.sandbox;
    let health: RunHealth | undefined;
    if (sandbox && entry.health && entry.phase === "agent") {
      let state: string;
      try {
        state = await sandbox.status();
      } catch {
        state = "lost";
      }
      if (entry.stop) return;
      if (state !== "running") {
        const lost = entry.health.lost(now);
        const { stop: _stop, ...shown } = lost;
        return entry.halt({ state: "failed", reason: lost.line, retry: true, health: shown });
      }
      entry.health.beat(now);
      const checked = entry.health.check(now);
      const { stop, ...shown } = checked;
      health = shown;
      if (stop) {
        return entry.halt({
          state: "stuck",
          reason: `Run health stopped it: ${checked.line}`,
          health: shown,
        });
      }
    }
    const cost = await costOf(entry);
    if (entry.stop) return;
    const output = flushLines(entry);
    const changed = health && health.status !== entry.lastStatus;
    if (health) entry.lastStatus = health.status;
    await save(entry, { cost, ...(health ? { health } : {}) });
    await append([...output, ...(changed && health ? [healthEvent(entry.run, health, now)] : [])]);
  }

  async function execute(entry: Live): Promise<BackgroundRun> {
    let credentials: RunCredentials | undefined;
    let stopWatch: (() => void) | undefined;
    let prepared: Prepared | undefined;
    let outcome: Stop | { state: "succeeded" } = {
      state: "failed",
      reason: "The run did not finish",
    };
    try {
      const { background, settings } = await settingsOf(entry.run.team);
      const startedAt = clock.now();
      const deadline = startedAt.getTime() + entry.run.timeout_minutes * 60_000;
      await moveTo(entry, "starting", { started_at: startedAt.toISOString() });
      stopWatch = clock.every(background.heartbeat_seconds * 1000, () =>
        tick(entry, deadline).catch((error) =>
          log(`background: ${entry.run.id} watchdog: ${message(error)}`),
        ),
      );

      const found = await options.runtime(entry.run, settings.config);
      if (!found || "refusal" in found) throw new RunFailure(noRuntime(entry.run.team, found));
      const adapter = found;

      const prepare = options.credentials ?? noCredentials;
      let granted: Awaited<ReturnType<PrepareCredentials>>;
      try {
        granted = await prepare(entry.run, { runtime: adapter, config: settings.config });
      } catch (error) {
        throw new RunFailure(message(error));
      }
      if ("refused" in granted) throw new RunFailure(granted.refused);
      credentials = granted;
      entry.mask = granted.mask;
      // Observe mode, or a weaker hold: reported. An enforced allow list the runtime cannot
      // hold refused the run at start (admit) and again when its credentials were prepared.
      for (const gap of granted.gaps ?? []) log(`background: ${entry.run.id}: ${gap}`);
      await save(entry, { credential: granted.kind });

      for (;;) {
        try {
          outcome = await attempt(entry, adapter, granted, settings, background, deadline, (p) => {
            prepared = p;
          });
          break;
        } catch (error) {
          const stop = error instanceof Stopped ? error.stop : entry.stop;
          const retryable = stop ? stop.retry === true : error instanceof RuntimeError;
          if (!retryable || entry.run.attempt >= entry.run.max_attempts) {
            throw error;
          }
          const reason = masked(
            entry,
            `Attempt ${entry.run.attempt} hit a runtime error: ${stop?.reason ?? message(error)}`,
          );
          log(`background: ${entry.run.id}: ${reason}`);
          await endSandbox(entry);
          entry.stop = undefined;
          entry.phase = "setup";
          await moveTo(entry, "starting", {
            attempt: entry.run.attempt + 1,
            reason,
            sandbox_id: null,
          });
        }
      }
    } catch (error) {
      if (error instanceof Stopped) outcome = error.stop;
      else if (entry.stop) outcome = entry.stop;
      else {
        outcome = {
          state: "failed",
          reason:
            error instanceof RunFailure || error instanceof RuntimeError
              ? error.message
              : `Unexpected error: ${message(error)}`,
        };
        if (!(error instanceof RunFailure || error instanceof RuntimeError)) {
          log(`background: ${entry.run.id} failed: ${message(error)}`);
        }
      }
    } finally {
      stopWatch?.();
    }
    return finish(entry, outcome, credentials, prepared);
  }

  function checkStop(entry: Live) {
    if (entry.stop) throw new Stopped(entry.stop);
  }

  async function attempt(
    entry: Live,
    adapter: RuntimeAdapter,
    credentials: RunCredentials,
    settings: Awaited<ReturnType<SettingsFor>>,
    background: ResolvedBackgroundConfig,
    deadline: number,
    onPrepared: (prepared: Prepared) => void,
  ): Promise<{ state: "succeeded" }> {
    const run = entry.run;
    const agent = AGENT_CLIS[run.agent];
    let sandbox: Sandbox;
    try {
      const base: SandboxSpec = {
        timeoutMinutes: run.timeout_minutes + SANDBOX_GRACE_MINUTES,
        env: { SELFHOST_RUN_ID: run.id },
        // A person id may be an email address, which providers refuse as a label value: it is
        // hashed here, and the run in the ledger maps it back.
        labels: {
          selfhost_run: run.id,
          selfhost_team: run.team,
          ...(run.person ? { selfhost_person: labelValue(run.person) } : {}),
        },
        // Recorded on the run before the provider is waited on, so a create that fails or hangs
        // later still leaves the sandbox's id where cancel, recover and the reaper look.
        onCreated: async (id) => {
          await save(entry, { sandbox_id: id, runtime: adapter.kind });
        },
      };
      sandbox = await adapter.create(
        credentials.spec
          ? credentials.spec(base)
          : {
              ...base,
              secrets: credentials.secrets,
              ...(credentials.egress ? { egress: credentials.egress } : {}),
            },
      );
    } catch (error) {
      throw new RuntimeError(`The ${adapter.kind} sandbox could not be created: ${message(error)}`);
    }
    entry.sandbox = sandbox;
    await save(entry, { sandbox_id: sandbox.id, runtime: adapter.kind });
    checkStop(entry);

    const prepared = await prepareSandbox(sandbox, run, {
      ...(settings.policyText !== undefined ? { policyText: settings.policyText } : {}),
      ...(run.base ? { base: run.base } : {}),
      selfhostVersion: options.selfhostVersion,
    });
    onPrepared(prepared);
    checkStop(entry);
    if (credentials.setup) await credentials.setup(sandbox, prepared.home);
    for (const note of prepared.notes) log(`background: ${run.id}: ${note}`);
    await save(entry, { base: prepared.base });

    const gateway = await options.gateway?.(entry.run);
    const env = {
      ...agent.env,
      ...runEnv(entry.run, prepared.home, settings.policyText !== undefined),
      ...(gateway ? agent.gatewayEnv(gateway) : {}),
    };
    const agentStart = clock.now();
    entry.health = new HealthMonitor({
      stallMinutes: background.stall_minutes,
      loopRepeats: background.loop_repeats,
      startedAt: agentStart,
    });
    entry.phase = "agent";
    await moveTo(entry, "running", {
      reason: null,
      health: { status: "ok", line: "starting", heartbeat_at: null, last_output_at: null },
      ...(gateway && entry.run.credential === "none" ? { credential: "gateway_key" } : {}),
    });
    checkStop(entry);

    let result: Awaited<ReturnType<Sandbox["exec"]>>;
    try {
      result = await sandbox.exec(agent.command(run.task), {
        cwd: prepared.dir,
        env,
        timeoutMs: Math.max(1000, deadline - clock.now().getTime()),
        onOutput: ({ text }) => {
          entry.health?.output(text, clock.now());
          const lines = (entry.partial + text).split("\n");
          entry.partial = lines.pop() ?? "";
          entry.pending.push(...lines);
        },
      });
    } catch (error) {
      checkStop(entry);
      throw new RuntimeError(
        `The sandbox stopped answering while ${agent.bin} ran: ${message(error)}`,
      );
    }
    entry.phase = "after";
    checkStop(entry);
    if (result.timedOut) {
      throw new Stopped({
        state: "timed_out",
        reason: `Ran past its ${run.timeout_minutes} minute timeout`,
      });
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim().split("\n").slice(-3).join(" ");
      // An agent whose model calls the gateway refused says little more than its exit code.
      const keyed = gateway !== undefined || entry.run.credential === "gateway_key";
      const refusal = keyed ? (await settle(entry))?.refusal : undefined;
      throw new RunFailure(
        `${agent.bin} exited ${result.exitCode}${refusal ? `: the AI gateway refused its model calls: ${refusal}` : ""}${detail ? `${refusal ? ". " : ": "}${detail}` : ""}`,
      );
    }

    // The agent's work, committed on the run's branch.
    const commit = [
      "git add -A",
      `(git diff --cached --quiet || git commit -q -m ${sh(`${firstLine(run.task)}\n\nselfhost-run: ${run.id}`)})`,
    ].join(" && ");
    await sandbox.exec(commit, { cwd: prepared.dir });
    const count = await sandbox.exec(`git rev-list --count ${prepared.baseSha}..HEAD`, {
      cwd: prepared.dir,
    });
    if (count.exitCode !== 0 || Number(count.stdout.trim()) === 0) {
      throw new RunFailure(
        `${agent.bin} finished without changing anything, so there is no pull request`,
      );
    }
    const headSha = (await sandbox.exec("git rev-parse HEAD", { cwd: prepared.dir })).stdout.trim();
    checkStop(entry);

    await moveTo(entry, "testing");
    const gate = await runGate(
      { sandbox, dir: prepared.dir, baseSha: prepared.baseSha, runId: run.id },
      {
        mode: background.tests_first,
        ...(background.test_command ? { testCommand: background.test_command } : {}),
        ...(settings.config.runtime?.setup ? { setup: settings.config.runtime.setup } : {}),
        sizeCap: background.pr_size_cap,
        config: settings.config,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        now: () => clock.now(),
      },
    );
    if (gate.output && entry.mask) gate.output = entry.mask(gate.output);
    await save(entry, { gate });
    await append([gateEvent(entry.run, gate, clock.now())]);
    checkStop(entry);
    if (gate.blocked) throw new RunFailure(`No pull request: ${gate.summary}`);

    await moveTo(entry, "pushing");
    const push = await sandbox.exec(`git push -q -u origin ${sh(run.branch)}`, {
      cwd: prepared.dir,
    });
    if (push.exitCode !== 0) {
      const detail = push.stderr.trim().split("\n").slice(-2).join(" ");
      throw new RunFailure(`Pushing ${run.branch} failed${detail ? `: ${detail}` : ""}`);
    }
    checkStop(entry);
    if (entry.run.pr_url) return { state: "succeeded" };
    if (!options.github) {
      throw new RunFailure(
        `Pushed ${run.branch}, but no GitHub App is set up to open the pull request`,
      );
    }
    const title = firstLine(run.task);
    const body = [
      run.task.trim(),
      "",
      "---",
      `Background run \`${run.id}\` by ${run.person ?? run.trigger.sender} (${run.trigger.source}), ${agent.bin} on ${entry.run.runtime}.`,
      ...(gate.result !== "skipped" ? [`Tests first (${gate.mode}): ${gate.summary}`] : []),
      "",
      agent.footer,
    ].join("\n");
    let pull: Awaited<ReturnType<RunGitHub["openPull"]>>;
    try {
      pull = await options.github.openPull({
        repo: run.repo,
        head: run.branch,
        base: prepared.base,
        title,
        body,
      });
    } catch (error) {
      throw new RunFailure(
        `Pushed ${run.branch}, but GitHub refused the pull request: ${message(error)}`,
      );
    }
    await save(entry, { pr_url: pull.url });
    await append([
      pullOpenedEvent(entry.run, { ...pull, title, headSha: pull.headSha ?? headSha }, clock.now()),
    ]);
    if (gate.result !== "skipped") {
      await options.github
        .check({
          repo: run.repo,
          headSha: pull.headSha ?? headSha,
          name: GATE_CHECK_NAME,
          conclusion:
            gate.result === "passed" ? "success" : gate.mode === "enforce" ? "failure" : "neutral",
          title: gate.result === "passed" ? "Tests first: passed" : "Tests first: failed",
          summary: gate.summary,
          text: gate.checks
            .map((check) => `- ${check.ok ? "pass" : "fail"} ${check.name}: ${check.detail}`)
            .join("\n"),
        })
        .catch((error) =>
          log(`background: ${run.id}: the gate check was not posted: ${message(error)}`),
        );
    }
    return { state: "succeeded" };
  }

  async function endSandbox(entry: Live) {
    const sandbox = entry.sandbox;
    if (!sandbox) return;
    try {
      await sandbox.stop();
    } catch (error) {
      log(`background: ${entry.run.id}: stopping ${sandbox.id} failed: ${message(error)}`);
    }
    try {
      entry.costs.push(await sandbox.cost());
    } catch {
      // A sandbox that is gone reports no cost; what was read before stands.
    }
    entry.sandbox = undefined;
  }

  async function finish(
    entry: Live,
    outcome: Stop | { state: "succeeded" },
    credentials: RunCredentials | undefined,
    prepared: Prepared | undefined,
  ): Promise<BackgroundRun> {
    const lost = "retry" in outcome && outcome.retry;
    const hooks = prepared && entry.sandbox && !lost ? await hookEvents(entry, prepared) : [];
    await append([...flushLines(entry, true), ...hooks]);
    await endSandbox(entry);
    await credentials?.revoke(revokeReason(outcome, entry)).catch((error) => {
      log(`background: ${entry.run.id}: revoking credentials failed: ${message(error)}`);
    });
    if (entry.health) await settle(entry);
    const cost = await costOf(entry);
    const now = clock.now();
    // A reason can carry the agent's stderr, which can carry a secret: masked before it reaches
    // the run record, the API, the ledger and notifications.
    const reason = outcome.state === "succeeded" ? null : masked(entry, outcome.reason);
    const stopped = "health" in outcome && outcome.health ? outcome.health : undefined;
    const health =
      stopped ??
      (entry.health && entry.run.health?.status !== "stuck" && entry.run.health?.status !== "lost"
        ? entry.health.finished()
        : entry.run.health);
    await save(entry, {
      state: outcome.state,
      reason,
      ended_at: now.toISOString(),
      sandbox_id: null,
      cost,
      health,
    });
    const final: LedgerEvent[] = [updatedEvent(entry.run, now)];
    if (health && (stopped || health.status !== entry.lastStatus)) {
      final.push(healthEvent(entry.run, health, now));
    }
    const alert = alertFor(entry.run);
    if (alert) final.push(alertEvent(entry.run, alert, now));
    await append(final);
    if (alert) {
      await options.alert?.(entry.run, alert).catch((error) => {
        log(`background: ${entry.run.id}: the alert was not sent: ${message(error)}`);
      });
    }
    live.delete(entry.run.id);
    return entry.run;
  }

  function track(run: BackgroundRun): Live {
    const entry: Live = {
      run,
      phase: "setup",
      pending: [],
      partial: "",
      costs: [],
      writes: Promise.resolve(),
      async halt(stop) {
        if (entry.stop) return;
        entry.stop = stop;
        await entry.sandbox?.stop().catch(() => {});
      },
      done: Promise.resolve(run),
    };
    live.set(run.id, entry);
    return entry;
  }

  async function refuse(
    request: StartRequest,
    refusal: Refusal,
    org: string | undefined,
  ): Promise<Refusal> {
    await append([
      triggeredEvent(
        { ...request.trigger, accepted: false, reason: refusal.refused },
        { team: request.team, ...(org ? { org } : {}), repo: request.repo },
        clock.now(),
      ),
    ]);
    return refusal;
  }

  return {
    async start(request) {
      const { settings, background } = await settingsOf(request.team);
      const org = settings.org;
      const now = clock.now();
      const person = request.person;
      if (request.trigger.source !== "schedule") {
        if (!person) {
          return refuse(
            request,
            {
              refused: `${request.trigger.sender} is not mapped to a selfhost person in this team, so they cannot start runs`,
              status: 403,
              code: "not_allowed",
            },
            org,
          );
        }
        // Only people in the team start its runs, also when [background] allowed names someone
        // who was revoked from it (or never joined).
        const id = person.toLowerCase();
        const inTeam = settings.people?.some((p) => p.toLowerCase() === id) ?? true;
        const listed = background.allowed.length === 0 || background.allowed.includes(person);
        if (!inTeam || !listed) {
          return refuse(
            request,
            {
              refused: !inTeam
                ? `${person} is not in team ${request.team}`
                : `${person} is not on [background] allowed for team ${request.team}`,
              status: 403,
              code: "not_allowed",
            },
            org,
          );
        }
      }
      const denied = await options.repoAccess?.(request.team, request.repo, org);
      if (denied !== undefined) {
        return refuse(request, { refused: denied, status: 403, code: "not_allowed" }, org);
      }
      const kills = await store.activeKills({
        teams: [request.team],
        ...(org ? { orgs: [org] } : {}),
      });
      const kill = kills[0];
      if (kill) {
        return refuse(
          request,
          {
            refused: `The ${kill.scope} kill switch for ${kill.target} is on (${kill.by}); clear it to start runs`,
            status: 409,
            code: "killed",
          },
          org,
        );
      }
      if (background.rate_limit_per_hour > 0) {
        const recent = await store.countSince(request.team, new Date(now.getTime() - 3_600_000));
        if (recent >= background.rate_limit_per_hour) {
          return refuse(
            request,
            {
              refused: `Team ${request.team} started ${recent} runs in the last hour, its limit ([background] rate_limit_per_hour)`,
              status: 429,
              code: "rate_limited",
            },
            org,
          );
        }
      }
      if (background.max_concurrent > 0) {
        const going = await store.countActive(request.team);
        if (going >= background.max_concurrent) {
          return refuse(
            request,
            {
              refused: `Team ${request.team} has ${going} runs going, its limit ([background] max_concurrent)`,
              status: 429,
              code: "rate_limited",
            },
            org,
          );
        }
      }

      const id = uuidv7(now);
      const agent = request.agent ?? background.agent;
      const run: BackgroundRun = {
        schema: BACKGROUND_RUN_SCHEMA,
        id,
        team: request.team,
        ...(org ? { org } : {}),
        repo: request.repo,
        task: request.task,
        agent,
        runtime: request.runtime ?? settings.config.runtime?.default ?? "unset",
        state: "queued",
        reason: null,
        person,
        trigger: request.trigger,
        credential: null,
        base: request.base ?? null,
        branch: runBranch(agent, request.task, id),
        sandbox_id: null,
        attempt: 1,
        max_attempts: 1 + background.max_retries,
        timeout_minutes: request.timeoutMinutes ?? background.timeout_minutes,
        pr_url: null,
        created_at: now.toISOString(),
        started_at: null,
        ended_at: null,
        updated_at: now.toISOString(),
        cancel: null,
        cost: { runtime_usd: 0, model_usd: 0, usd: 0, source: "list_price" },
        health: null,
        gate: null,
      };
      const adapter = await options.runtime(run, settings.config);
      if (!adapter || "refusal" in adapter) {
        return refuse(
          request,
          { refused: noRuntime(request.team, adapter), status: 503, code: "no_runtime" },
          org,
        );
      }
      const inadmissible = options.admit?.(run, adapter, settings.config);
      if (inadmissible !== undefined) {
        return refuse(request, { refused: inadmissible, status: 403, code: "not_allowed" }, org);
      }
      run.runtime = adapter.kind;
      await store.create(run);
      await append([
        triggeredEvent(
          { ...request.trigger, accepted: true, run_id: id },
          { team: run.team, ...(org ? { org } : {}), repo: run.repo, runId: id },
          now,
        ),
        updatedEvent(run, now),
      ]);
      const entry = track(run);
      entry.done = execute(entry);
      return { run, done: entry.done };
    },

    async cancel(id, by) {
      const found = await store.get(id);
      if (!found) return undefined;
      if (isFinalRunState(found.state)) return found;
      const at = clock.now();
      const cancel = { by, at: at.toISOString(), scope: "run" as const };
      await store.requestCancel(id, cancel);
      const entry = live.get(id);
      if (entry) {
        entry.run = { ...entry.run, cancel };
        await entry.halt({ state: "cancelled", reason: `Stopped by ${by}` });
      }
      return (await store.get(id)) ?? found;
    },

    async kill(scope, target, by, reason) {
      const at = clock.now();
      const active = await store.kill({
        scope,
        target,
        by,
        at: at.toISOString(),
        ...(reason ? { reason } : {}),
      });
      const going = await store.list({ states: ACTIVE_STATES, limit: 500 });
      const stopped: string[] = [];
      for (const run of going) {
        if ((scope === "team" ? run.team : run.org) !== target) continue;
        const cancel = { by, at: at.toISOString(), scope };
        await store.requestCancel(run.id, cancel);
        stopped.push(run.id);
        const entry = live.get(run.id);
        if (entry) {
          entry.run = { ...entry.run, cancel };
          await entry.halt({
            state: "cancelled",
            reason: `Stopped by the ${scope} kill switch (${by})`,
          });
        }
      }
      log(
        `background: ${scope} kill switch for ${target} turned on by ${by}; ${stopped.length} runs stopped`,
      );
      if (!active) log(`background: ${scope} kill switch for ${target} was already on`);
      return { active: true, stopped };
    },

    async clearKill(scope, target, by) {
      const cleared = await store.clearKill(scope, target, by, clock.now());
      if (cleared) log(`background: ${scope} kill switch for ${target} cleared by ${by}`);
      return cleared;
    },

    async recover() {
      const left = await store.list({ states: ACTIVE_STATES, limit: 500 });
      const recovered: string[] = [];
      for (const run of left) {
        if (live.has(run.id)) continue;
        if (run.sandbox_id) {
          try {
            const { settings } = await settingsOf(run.team);
            const found = await options.runtime(run, settings.config);
            const adapter = found && !("refusal" in found) ? found : undefined;
            await (await adapter?.get(run.sandbox_id))?.stop();
          } catch (error) {
            log(
              `background: ${run.id}: could not stop sandbox ${run.sandbox_id}: ${message(error)}`,
            );
          }
        }
        const now = clock.now();
        const ended: BackgroundRun = await store.save({
          ...run,
          state: "failed",
          reason: "The server stopped while the run was going",
          sandbox_id: null,
          ended_at: now.toISOString(),
          updated_at: now.toISOString(),
        });
        const alert = alertFor(ended);
        await append([updatedEvent(ended, now), ...(alert ? [alertEvent(ended, alert, now)] : [])]);
        // The process that held the run's credentials is gone, and with it the revoke at its end.
        await options.orphaned?.(ended).catch((error) => {
          log(`background: ${run.id}: revoking what it held failed: ${message(error)}`);
        });
        recovered.push(run.id);
      }
      return recovered;
    },

    async idle() {
      while (live.size > 0) await Promise.allSettled([...live.values()].map((entry) => entry.done));
    },
  };
}

/** Why the run's credentials are revoked, from how it ended. */
function revokeReason(
  outcome: { state: BackgroundRunState },
  entry: { run: BackgroundRun },
): RevokeReason {
  if (outcome.state === "succeeded") return "succeeded";
  if (outcome.state === "timed_out") return "timed_out";
  if (outcome.state === "cancelled" || outcome.state === "stuck" || entry.run.cancel) {
    return "killed";
  }
  return "failed";
}

/** The alert a final run raises, or undefined when it needs no one. */
export function alertFor(run: BackgroundRun): RunAlert | undefined {
  const what = `${AGENT_CLIS[run.agent].bin} on ${run.repo}: ${firstLine(run.task, 60)}`;
  const body = run.reason ?? "";
  if (run.state === "failed") return { kind: "run_failed", title: `Run failed: ${what}`, body };
  if (run.state === "stuck") return { kind: "run_stuck", title: `Run stuck: ${what}`, body };
  if (run.state === "timed_out") {
    return { kind: "run_timed_out", title: `Run timed out: ${what}`, body };
  }
  return undefined;
}
