import type { Budget } from "@selfhost/schema";
import { periodRange } from "@selfhost/spend";
import { runtimeAlert } from "./events.js";
import type { Emit, TrackedSandbox } from "./track.js";

/** The [budget] keys that cap sandbox spend. */
export const RUNTIME_CAP_KEYS = ["runtime_daily_usd", "runtime_run_usd"] as const;
export type RuntimeCapKey = (typeof RUNTIME_CAP_KEYS)[number];

/** A run refused before it starts because a runtime cap is reached. */
export class RuntimeCapError extends Error {
  constructor(
    readonly cap: RuntimeCapKey,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeCapError";
  }
}

export interface RuntimeCaps {
  daily?: number;
  run?: number;
}

/** The runtime caps in [budget]: always hard, whatever budget mode says. */
export function runtimeCaps(budget: Budget | undefined): RuntimeCaps {
  return {
    ...(budget?.runtime_daily_usd !== undefined ? { daily: budget.runtime_daily_usd } : {}),
    ...(budget?.runtime_run_usd !== undefined ? { run: budget.runtime_run_usd } : {}),
  };
}

export interface GuardOptions {
  caps: RuntimeCaps;
  /**
   * The team's sandbox spend today from the ledger, leaving out the sandboxes this guard watches
   * (their cost is read live). sandboxSpendIn over sandboxSpans of today's events does this.
   */
  spentToday: (exclude: ReadonlySet<string>, day: { from: Date; to: Date }) => Promise<number>;
  emit: Emit;
  now?: () => Date;
}

export interface CapStop {
  sandboxId: string;
  runId?: string;
  cap: RuntimeCapKey;
}

const usd = (value: number) => `$${value.toFixed(2)}`;

/**
 * Enforces [budget] runtime_daily_usd and runtime_run_usd for the sandboxes of one team. admit()
 * refuses a new run once the day's sandbox spend reaches the daily cap; check() stops a run's
 * sandbox at its run cap and every watched sandbox at the daily cap, writes sandbox.stopped with
 * reason cap, and an alert.raised that the review list turns into an item naming the cap.
 */
export class RuntimeGuard {
  private readonly watched = new Map<string, TrackedSandbox>();
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private caps: RuntimeCaps;

  constructor(private readonly options: GuardOptions) {
    this.now = options.now ?? (() => new Date());
    this.caps = options.caps;
  }

  /** The caps from the team's current policy: a lowered cap applies to the next run and check. */
  setCaps(caps: RuntimeCaps): void {
    this.caps = caps;
  }

  private day() {
    return periodRange("day", this.now());
  }

  /** Sandbox spend today: the ledger's, plus the live cost of each watched sandbox. */
  async spentToday(): Promise<number> {
    const day = this.day();
    let total = await this.options.spentToday(new Set(this.watched.keys()), day);
    for (const sandbox of this.watched.values()) {
      const cost = await sandbox.cost();
      const begun = Math.max(sandbox.startedAt.getTime(), day.from.getTime());
      const seconds = (this.now().getTime() - sandbox.startedAt.getTime()) / 1000;
      const share = seconds > 0 ? Math.min(1, (this.now().getTime() - begun) / 1000 / seconds) : 1;
      total += cost.usd * share;
    }
    return total;
  }

  /** Throws RuntimeCapError when today's sandbox spend has reached the daily cap. */
  async admit(): Promise<void> {
    const cap = this.caps.daily;
    if (cap === undefined) return;
    const spent = await this.spentToday();
    if (spent >= cap) {
      throw new RuntimeCapError(
        "runtime_daily_usd",
        `Sandbox spend today is ${usd(spent)}, which reached [budget] runtime_daily_usd (${usd(cap)}). New runs start again tomorrow (UTC), or when the cap is raised.`,
      );
    }
  }

  watch(sandbox: TrackedSandbox): void {
    this.watched.set(sandbox.id, sandbox);
  }

  forget(id: string): void {
    this.watched.delete(id);
  }

  /** Stops what is over a cap. Call it every minute or so while runs are active. */
  async check(): Promise<CapStop[]> {
    const stops: CapStop[] = [];
    const { run, daily } = this.caps;
    if (run !== undefined) {
      for (const sandbox of [...this.watched.values()]) {
        const cost = await sandbox.cost();
        if (cost.usd < run) continue;
        await this.stop(sandbox, "runtime_run_usd");
        stops.push(this.stopOf(sandbox, "runtime_run_usd"));
        await this.options.emit(
          runtimeAlert(
            "budget_exceeded",
            `Run ${sandbox.context.run_id ?? sandbox.id} reached [budget] runtime_run_usd (${usd(run)}): its ${sandbox.runtime} sandbox cost ${usd(cost.usd)} and was stopped.`,
            sandbox.context,
            this.now(),
            {
              cap: "runtime_run_usd",
              window: `run:${sandbox.context.run_id ?? sandbox.id}`,
              limit_usd: run,
              spent_usd: cost.usd,
            },
          ),
        );
      }
    }
    if (daily !== undefined && this.watched.size > 0) {
      const spent = await this.spentToday();
      if (spent >= daily) {
        const all = [...this.watched.values()];
        for (const sandbox of all) {
          await this.stop(sandbox, "runtime_daily_usd");
          stops.push(this.stopOf(sandbox, "runtime_daily_usd"));
        }
        const { run_id: _run, owner: _owner, ...team } = all[0]?.context ?? {};
        await this.options.emit(
          runtimeAlert(
            "budget_exceeded",
            `Sandbox spend today reached [budget] runtime_daily_usd (${usd(daily)}) at ${usd(spent)}: ${all.length} running sandbox${all.length === 1 ? " was" : "es were"} stopped and new runs are refused until tomorrow (UTC).`,
            team,
            this.now(),
            {
              cap: "runtime_daily_usd",
              window: this.day().from.toISOString().slice(0, 10),
              limit_usd: daily,
              spent_usd: spent,
            },
          ),
        );
      }
    }
    return stops;
  }

  private async stop(sandbox: TrackedSandbox, cap: RuntimeCapKey) {
    this.watched.delete(sandbox.id);
    await sandbox.stopFor("cap", cap);
  }

  private stopOf(sandbox: TrackedSandbox, cap: RuntimeCapKey): CapStop {
    return {
      sandboxId: sandbox.id,
      ...(sandbox.context.run_id ? { runId: sandbox.context.run_id } : {}),
      cap,
    };
  }

  /** Runs check() every intervalMs until dispose(). */
  start(intervalMs = 60_000): void {
    this.timer ??= setInterval(() => {
      void this.check().catch(() => undefined);
    }, intervalMs);
    this.timer.unref?.();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
