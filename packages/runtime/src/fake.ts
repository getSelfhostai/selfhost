import type {
  ExecOptions,
  ExecResult,
  RuntimeAdapter,
  RuntimeKind,
  Sandbox,
  SandboxSpec,
  SandboxState,
} from "./types.js";

/** Answers a command run in a fake sandbox. Unhandled commands exit 0 with no output. */
export type FakeExec = (
  command: string,
  sandbox: FakeSandbox,
  options: ExecOptions,
) => Partial<ExecResult> | undefined | Promise<Partial<ExecResult> | undefined>;

export interface FakeRuntimeOptions {
  kind?: RuntimeKind;
  exec?: FakeExec;
  /** Dollars per second the fake bills. Default 0.0001. */
  usdPerSecond?: number;
  now?: () => Date;
}

export interface FakeSandbox extends Sandbox {
  readonly spec: SandboxSpec;
  readonly files: Map<string, Uint8Array>;
  readonly commands: string[];
  readonly logLines: string[];
}

/**
 * An in-memory runtime for tests: files live in a map, commands are answered by `exec`, cost
 * grows with the injected clock. It honours the same contract as the real adapters, so code built
 * on the interface can be tested without a provider account.
 */
export function fakeRuntime(options: FakeRuntimeOptions = {}): RuntimeAdapter & {
  readonly sandboxes: Map<string, FakeSandbox>;
} {
  const kind = options.kind ?? "e2b";
  const now = options.now ?? (() => new Date());
  const rate = options.usdPerSecond ?? 0.0001;
  const sandboxes = new Map<string, FakeSandbox>();
  let next = 1;

  function make(spec: SandboxSpec): FakeSandbox {
    const id = `fake-${kind}-${next++}`;
    const started = now().getTime();
    let state: SandboxState = "running";
    let stoppedAt: number | undefined;
    const files = new Map<string, Uint8Array>();
    const commands: string[] = [];
    const logLines: string[] = [`sandbox ${id} started`];
    const sandbox: FakeSandbox = {
      id,
      runtime: kind,
      spec,
      files,
      commands,
      logLines,
      async exec(command, execOptions = {}) {
        if (state !== "running") throw new Error(`Sandbox ${id} is ${state}`);
        commands.push(command);
        const answer = (await options.exec?.(command, sandbox, execOptions)) ?? {};
        const result: ExecResult = {
          exitCode: answer.exitCode ?? 0,
          stdout: answer.stdout ?? "",
          stderr: answer.stderr ?? "",
          timedOut: answer.timedOut ?? false,
        };
        if (result.stdout) execOptions.onOutput?.({ stream: "stdout", text: result.stdout });
        if (result.stderr) execOptions.onOutput?.({ stream: "stderr", text: result.stderr });
        return result;
      },
      async writeFile(path, content) {
        files.set(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
      },
      async readFile(path) {
        const found = files.get(path);
        if (!found) throw new Error(`No such file in sandbox ${id}: ${path}`);
        return found;
      },
      async *logs() {
        for (const line of logLines) yield line;
      },
      async snapshot() {
        return { id: `${id}-snapshot` };
      },
      async status() {
        return state;
      },
      async cost() {
        const end = stoppedAt ?? now().getTime();
        const seconds = Math.max(0, Math.round((end - started) / 1000));
        return { seconds, usd: seconds * rate, source: "list_price" as const };
      },
      async stop() {
        if (state === "stopped") return;
        state = "stopped";
        stoppedAt = now().getTime();
        logLines.push(`sandbox ${id} stopped`);
      },
    };
    return sandbox;
  }

  return {
    kind,
    capabilities: { egress: true, secrets: true, snapshot: true, regions: [] },
    sandboxes,
    async create(spec) {
      const sandbox = make(spec);
      sandboxes.set(sandbox.id, sandbox);
      return sandbox;
    },
    async get(id) {
      return sandboxes.get(id);
    },
    async list(labels) {
      const out: { id: string; state: SandboxState }[] = [];
      for (const sandbox of sandboxes.values()) {
        const state = await sandbox.status();
        if (state === "stopped") continue;
        const matches = Object.entries(labels ?? {}).every(
          ([key, value]) => sandbox.spec.labels?.[key] === value,
        );
        if (matches) out.push({ id: sandbox.id, state });
      }
      return out;
    },
  };
}
