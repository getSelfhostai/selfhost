import type { LedgerEvent, SandboxBilling, SandboxStopReason } from "@selfhost/schema";
import { RUNTIMES, type Size } from "./catalog.js";
import { type RunContext, sandboxEvent } from "./events.js";
import type { ExecOptions, Sandbox } from "./types.js";

export type Emit = (event: LedgerEvent) => void | Promise<void>;

export interface TrackOptions {
  emit: Emit;
  context: RunContext;
  size?: Size;
  region?: string;
  /** List price per running hour, from pickRuntime. */
  usdPerHour?: number;
  now?: () => Date;
}

/** Billed time of a sandbox, split by whether a command was running. */
export interface SandboxUsage {
  billed_seconds: number;
  busy_seconds: number;
  idle_seconds: number;
}

/** A sandbox that writes its lifecycle to the ledger and times every command run in it. */
export interface TrackedSandbox extends Sandbox {
  readonly context: RunContext;
  readonly startedAt: Date;
  /** Seconds with at least one command running, up to now or the stop. */
  busySeconds(): number;
  /** Records that the sandbox's run finished, failed or got stuck. */
  markRunEnded(at?: Date): void;
  /** Stops it with a reason, and the [budget] cap when the reason is cap. */
  stopFor(reason: SandboxStopReason, cap?: string): Promise<void>;
}

/** Total length of the union of [start, end) intervals, in milliseconds. */
export function unionMs(intervals: readonly (readonly [number, number])[]): number {
  const sorted = [...intervals].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let current: [number, number] | undefined;
  for (const [start, end] of sorted) {
    if (!current || start > current[1]) {
      if (current) total += current[1] - current[0];
      current = [start, end];
    } else current[1] = Math.max(current[1], end);
  }
  if (current) total += current[1] - current[0];
  return total;
}

/**
 * Billed, busy and idle seconds: busy is the time a command ran (the agent working), idle the
 * rest of the billed time (the agent waiting on the model, or nothing left to do).
 */
export function usageOf(billedSeconds: number, busyMs: number): SandboxUsage {
  const billed = Math.max(0, billedSeconds);
  const busy = Math.min(billed, Math.round(busyMs / 1000));
  return { billed_seconds: billed, busy_seconds: busy, idle_seconds: billed - busy };
}

/**
 * Wraps a new sandbox so its life lands in the ledger: sandbox.started now, sandbox.stopped with
 * its cost, billed, busy and idle seconds when it stops. Busy time comes from the commands run
 * through it: a sandbox the agent only waits in bills idle time.
 */
export async function trackSandbox(
  sandbox: Sandbox,
  options: TrackOptions,
): Promise<TrackedSandbox> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const intervals: [number, number][] = [];
  const running = new Set<[number, number]>();
  let runEnded: Date | undefined;
  let stopped: Date | undefined;
  const billing: SandboxBilling = RUNTIMES[sandbox.runtime].billing;
  const record = {
    runtime: sandbox.runtime,
    sandbox_id: sandbox.id,
    ...(options.size
      ? { size: { cpu: options.size.cpu, memory_gib: options.size.memoryGiB } }
      : {}),
    ...(options.region ? { region: options.region } : {}),
    ...(options.usdPerHour !== undefined ? { usd_per_hour: options.usdPerHour } : {}),
    billing,
  };
  await options.emit(sandboxEvent("sandbox.started", record, options.context, startedAt));

  const busyMs = () => {
    const end = (stopped ?? now()).getTime();
    const open = [...running].map(([start]) => [start, end] as [number, number]);
    return unionMs(
      [...intervals, ...open].map(([a, b]) => [Math.max(a, startedAt.getTime()), Math.min(b, end)]),
    );
  };

  async function stopFor(reason: SandboxStopReason, cap?: string): Promise<void> {
    if (stopped) return;
    await sandbox.stop();
    stopped = now();
    const cost = await sandbox.cost();
    const usage = usageOf(cost.seconds, busyMs());
    await options.emit(
      sandboxEvent(
        "sandbox.stopped",
        {
          ...record,
          reason,
          ...(cap ? { cap } : {}),
          ...usage,
          ...(runEnded
            ? {
                run_ended_at: runEnded.toISOString(),
                after_run_seconds: Math.max(
                  0,
                  Math.round((stopped.getTime() - runEnded.getTime()) / 1000),
                ),
              }
            : {}),
        },
        options.context,
        stopped,
        { usd: cost.usd, estimated: cost.source === "list_price" },
      ),
    );
  }

  return {
    id: sandbox.id,
    runtime: sandbox.runtime,
    context: options.context,
    startedAt,
    async exec(command: string, execOptions?: ExecOptions) {
      const interval: [number, number] = [now().getTime(), 0];
      running.add(interval);
      try {
        return await sandbox.exec(command, execOptions);
      } finally {
        running.delete(interval);
        interval[1] = now().getTime();
        intervals.push(interval);
      }
    },
    writeFile: (path, content) => sandbox.writeFile(path, content),
    readFile: (path) => sandbox.readFile(path),
    logs: (signal) => sandbox.logs(signal),
    snapshot: () => sandbox.snapshot(),
    status: () => sandbox.status(),
    cost: () => sandbox.cost(),
    stop: () => stopFor(runEnded ? "run_ended" : "manual"),
    stopFor,
    busySeconds: () => Math.round(busyMs() / 1000),
    markRunEnded(at = now()) {
      runEnded ??= at;
    },
  };
}
