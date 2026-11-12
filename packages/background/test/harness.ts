import {
  type ExecOptions,
  type FakeSandbox,
  fakeRuntime,
  type RuntimeAdapter,
} from "@selfhost/runtime";
import {
  type LedgerEvent,
  parseConfig,
  type ResolvedSelfhostConfig,
  type RunTrigger,
} from "@selfhost/schema";
import {
  createRunner,
  type GatewayAccess,
  manualClock,
  memoryRunStore,
  type PrepareCredentials,
  type RunAlert,
  type Runner,
  type RunnerOptions,
  type StartRequest,
} from "../src/index.js";

export const BASE_SHA = "1111111111111111111111111111111111111111";
export const HEAD_SHA = "2222222222222222222222222222222222222222";
export const HOME = "/home/user";

export interface AgentControl {
  /** Prints a chunk as the agent. */
  print(text: string): void;
  /** Resolves when the sandbox is stopped. */
  stopped: Promise<void>;
  options: ExecOptions;
  sandbox: FakeSandbox;
}

export interface Scenario {
  /** What the agent does; resolves with its exit code. Default: change a file and a test, exit 0. */
  agent?: (control: AgentControl) => Promise<number>;
  /** Files the run's diff touches. */
  files?: string[];
  /** Whether the test command passes on the base checkout. Default false (tests-first holds). */
  basePasses?: boolean;
  headPasses?: boolean;
  numstat?: string;
  /** Extra exec answers, checked first. */
  exec?: (
    command: string,
    options: ExecOptions,
  ) => { exitCode?: number; stdout?: string; stderr?: string } | undefined;
  toml?: string;
  /** Sandbox creation fails this many times first. */
  createFailures?: number;
  credentials?: PrepareCredentials;
  noGitHub?: boolean;
  fetch?: (url: string) => Promise<Response>;
  people?: string[];
  noRuntime?: boolean;
  /** The runtime seam refuses with this reason instead of giving an adapter. */
  runtimeRefusal?: { rule: string; message: string };
  /** A per-run gateway key for the agent. */
  gateway?: GatewayAccess;
  settleUsage?: RunnerOptions["settleUsage"];
  modelCost?: RunnerOptions["modelCost"];
}

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 2000; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting");
};

export function harness(scenario: Scenario = {}) {
  const clock = manualClock("2026-11-09T10:00:00Z");
  const store = memoryRunStore();
  const events: LedgerEvent[] = [];
  const pulls: { repo: string; head: string; base: string; title: string; body: string }[] = [];
  const checks: { name: string; conclusion: string; summary: string }[] = [];
  const alerts: RunAlert[] = [];
  const agentStarts: AgentControl[] = [];
  const committed = new Set<string>();

  const files = scenario.files ?? ["src/login.ts", "src/login.test.ts"];
  const answer = async (command: string, sandbox: FakeSandbox, options: ExecOptions) => {
    const extra = scenario.exec?.(command, options);
    if (extra) return extra;
    if (command === 'printf %s "$HOME"') return { stdout: HOME };
    if (command.startsWith("git rev-parse --abbrev-ref")) return { stdout: "main\n" };
    if (command === "git rev-parse HEAD") {
      return { stdout: `${committed.has(sandbox.id) ? HEAD_SHA : BASE_SHA}\n` };
    }
    if (command.startsWith("git add -A")) {
      committed.add(sandbox.id);
      return {};
    }
    if (command.startsWith("git rev-list --count")) {
      return { stdout: committed.has(sandbox.id) && files.length > 0 ? "1\n" : "0\n" };
    }
    if (command.startsWith("git diff --name-only")) return { stdout: `${files.join("\n")}\n` };
    if (command.startsWith("git diff --numstat")) {
      return { stdout: scenario.numstat ?? files.map((f) => `10\t2\t${f}`).join("\n") };
    }
    if (command === "ls -1A") return { stdout: "package.json\npnpm-lock.yaml\nsrc\n" };
    if (command === "cat package.json" || command === "cat 'package.json'") {
      return {
        stdout: JSON.stringify({
          scripts: { test: "vitest run" },
          dependencies: { "made-up-pkg": "1.0.0" },
        }),
      };
    }
    if (command.startsWith("git show 1111"))
      return { stdout: JSON.stringify({ dependencies: {} }) };
    if (command === "pnpm test") {
      const onBase = options.cwd?.startsWith("/tmp/selfhost-base-");
      const passes = onBase ? scenario.basePasses === true : scenario.headPasses !== false;
      return passes
        ? { stdout: "1 passed\n" }
        : { exitCode: 1, stdout: "1 failed: login rejects empty\n" };
    }
    if (command === "selfhost import --hook-events") {
      return {
        stdout: `${JSON.stringify({
          id: "01930c4e-2f1a-7b2c-8d3e-000000000abc",
          schema: "selfhost.event/v1",
          ts: "2026-11-09T10:01:00.000Z",
          source: "hook",
          kind: "policy.evaluated",
          actor: { kind: "system", id: "selfhost-policy" },
          agent: { vendor: "claude_code" },
          tool: { name: "Bash", input_summary: "git push --force" },
          decision: {
            verdict: "block",
            by: "selfhost-policy",
            rule_id: "guard.force_push",
            mode: "enforce",
          },
        })}\n`,
      };
    }
    if (/^(claude|codex|opencode|goose) /.test(command)) {
      let stopped!: () => void;
      const control: AgentControl = {
        print: (text) => options.onOutput?.({ stream: "stdout", text }),
        stopped: new Promise<void>((resolve) => {
          stopped = resolve;
        }),
        options,
        sandbox,
      };
      let settled = false;
      void (async () => {
        while (!settled) {
          if ((await sandbox.status()) === "stopped") return stopped();
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();
      agentStarts.push(control);
      const run = scenario.agent ?? (async () => 0);
      const exitCode = await Promise.race([run(control), control.stopped.then(() => 137)]).finally(
        () => {
          settled = true;
        },
      );
      if ((await sandbox.status()) === "stopped") throw new Error("sandbox stopped");
      return { exitCode };
    }
    return undefined;
  };

  const inner = fakeRuntime({ now: () => clock.now(), exec: answer });
  let failures = scenario.createFailures ?? 0;
  const runtime: RuntimeAdapter & { sandboxes: typeof inner.sandboxes } = {
    ...inner,
    sandboxes: inner.sandboxes,
    async create(spec) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("503 from the provider");
      }
      return inner.create(spec);
    },
  };

  const parsed = parseConfig(scenario.toml ?? 'version = 1\n[runtime]\ndefault = "e2b"\n');
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const config: ResolvedSelfhostConfig = parsed.config;

  const runner: Runner = createRunner({
    store,
    events: {
      async append(list) {
        events.push(...list);
      },
    },
    runtime: () =>
      scenario.runtimeRefusal
        ? { refusal: scenario.runtimeRefusal }
        : scenario.noRuntime
          ? undefined
          : runtime,
    settings: async () => ({
      config,
      policyText: "version = 1\n",
      org: "acme",
      people: scenario.people ?? ["alice@example.com", "bob@example.com"],
    }),
    ...(scenario.credentials ? { credentials: scenario.credentials } : {}),
    ...(scenario.noGitHub
      ? {}
      : {
          github: {
            defaultBranch: async () => "main",
            async openPull(input) {
              pulls.push(input);
              return {
                number: 7,
                url: `https://github.com/${input.repo}/pull/${6 + pulls.length}`,
                headSha: HEAD_SHA,
              };
            },
            async check(input) {
              checks.push(input);
            },
            async comment() {},
          },
        }),
    alert: async (_run, alert) => {
      alerts.push(alert);
    },
    modelCost: scenario.modelCost ?? (async () => 0.25),
    ...(scenario.gateway ? { gateway: async () => scenario.gateway } : {}),
    ...(scenario.settleUsage ? { settleUsage: scenario.settleUsage } : {}),
    clock,
    ...(scenario.fetch
      ? { fetch: (url: string) => scenario.fetch?.(url) as Promise<Response> }
      : {}),
    selfhostVersion: "0.4.0",
  });

  const request = (extra: Partial<StartRequest> = {}): StartRequest => {
    const trigger: RunTrigger = {
      source: "cli",
      sender: "alice@example.com",
      person: "alice@example.com",
    };
    return {
      team: "platform",
      repo: "acme/web",
      task: "Fix the login bug where empty passwords are accepted",
      person: "alice@example.com",
      trigger,
      ...extra,
    };
  };

  return {
    clock,
    store,
    events,
    pulls,
    checks,
    alerts,
    runtime,
    runner,
    request,
    agentStarts,
    /** Resolves once the agent of the nth run started (1-based). */
    async agentStarted(n = 1) {
      if (agentStarts.length >= n) return agentStarts[n - 1] as AgentControl;
      await until(() => agentStarts.length >= n);
      return agentStarts[n - 1] as AgentControl;
    },
    kinds: (runId: string) => events.filter((e) => e.run_id === runId).map((e) => e.kind),
    states: (runId: string) =>
      events
        .filter((e) => e.run_id === runId && e.kind === "run.updated")
        .map((e) => ((e.data?.background_run ?? {}) as { state: string }).state),
  };
}
