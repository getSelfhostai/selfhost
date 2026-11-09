import { type LedgerEvent, RUNTIME_LEFTOVER_MINUTES } from "@selfhost/schema";
import { type SandboxSpan, sandboxSpans, spanCost } from "@selfhost/spend";
import { RUNTIMES } from "./catalog.js";
import { type RunContext, runtimeAlert, sandboxEvent } from "./events.js";
import type { Emit } from "./track.js";
import type { RuntimeAdapter, RuntimeKind, SandboxState } from "./types.js";

/** Why a running sandbox counts as left behind. */
export type LeftoverReason = "run_ended" | "stopped_in_ledger" | "unknown";

export interface Leftover {
  runtime: RuntimeKind;
  sandboxId: string;
  state: SandboxState;
  reason: LeftoverReason;
  runId: string | null;
  owner: string | null;
  team: string | null;
  /** When its run ended, if the ledger says. */
  runEndedAt: string | null;
  /** Minutes since its run ended, or since the ledger says it stopped; null when unknown. */
  minutesOver: number | null;
  /** Cost so far, from the sandbox itself. */
  costUsd: number;
  /** In words, for the CLI. */
  why: string;
}

export interface FindOptions {
  adapters: readonly RuntimeAdapter[];
  /** sandbox.* events and the events that end runs, of the last 30 days or so. */
  events: Iterable<LedgerEvent>;
  now: Date;
  /** Default: RUNTIME_LEFTOVER_MINUTES (15). */
  leftoverMinutes?: number;
  /** Only sandboxes with these labels (for example the team's). */
  labels?: Readonly<Record<string, string>>;
}

export interface FindResult {
  leftovers: Leftover[];
  /** Runtimes that could not be listed, with why. */
  errors: { runtime: RuntimeKind; message: string }[];
}

/**
 * Running sandboxes selfhost made (they carry its label) that should not be running: their run
 * ended at least leftoverMinutes ago, or the ledger says they stopped. Sandboxes the ledger has
 * no record of are listed as unknown, since another team's selfhost may own them.
 */
export async function findLeftovers(options: FindOptions): Promise<FindResult> {
  const now = options.now.getTime();
  const minutes = options.leftoverMinutes ?? RUNTIME_LEFTOVER_MINUTES;
  const spans = sandboxSpans(options.events);
  const leftovers: Leftover[] = [];
  const errors: FindResult["errors"] = [];
  for (const adapter of options.adapters) {
    let listed: readonly { id: string; state: SandboxState }[];
    try {
      listed = await adapter.list(options.labels);
    } catch (error) {
      errors.push({
        runtime: adapter.kind,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const { id, state } of listed) {
      const span: SandboxSpan | undefined = spans.get(id);
      const sandbox = await adapter.get(id).catch(() => undefined);
      const cost = sandbox ? await sandbox.cost().catch(() => undefined) : undefined;
      const costUsd = cost?.usd ?? (span ? spanCost(span, now) : 0);
      const common = {
        runtime: adapter.kind,
        sandboxId: id,
        state,
        runId: span?.run_id ?? null,
        owner: span?.owner ?? null,
        team: span?.team ?? null,
        runEndedAt: span?.run_ended === undefined ? null : new Date(span.run_ended).toISOString(),
        costUsd: Math.round(costUsd * 1e6) / 1e6,
      };
      const name = RUNTIMES[adapter.kind].name;
      if (!span) {
        leftovers.push({
          ...common,
          reason: "unknown",
          minutesOver: null,
          why: `${name} sandbox ${id} carries selfhost's label but the ledger has no run for it.`,
        });
        continue;
      }
      if (span.stopped !== undefined) {
        leftovers.push({
          ...common,
          reason: "stopped_in_ledger",
          minutesOver: Math.round((now - span.stopped) / 60_000),
          why: `The ledger says ${name} sandbox ${id} stopped, but it still runs.`,
        });
        continue;
      }
      if (span.run_ended === undefined) continue;
      const over = (now - span.run_ended) / 60_000;
      if (over < minutes) continue;
      leftovers.push({
        ...common,
        reason: "run_ended",
        minutesOver: Math.round(over),
        why: `Run ${span.run_id} ended ${Math.round(over)} minutes ago; its ${name} sandbox ${id} still runs.`,
      });
    }
  }
  return { leftovers, errors };
}

export interface ReapOptions {
  adapters: readonly RuntimeAdapter[];
  leftovers: readonly Leftover[];
  emit: Emit;
  now: () => Date;
  /** Also stop sandboxes the ledger has no record of. Default false. */
  includeUnknown?: boolean;
  context?: Omit<RunContext, "run_id" | "owner" | "team">;
}

export interface Reaped {
  leftover: Leftover;
  stopped: boolean;
  error?: string;
}

/**
 * Stops leftover sandboxes. Each one gets a sandbox.stopped event (reason reaped, with its cost)
 * and an alert.raised sandbox_left_running, which puts a review item in front of the run's owner.
 */
export async function reapLeftovers(options: ReapOptions): Promise<Reaped[]> {
  const out: Reaped[] = [];
  for (const leftover of options.leftovers) {
    if (leftover.reason === "unknown" && !options.includeUnknown) {
      out.push({ leftover, stopped: false, error: "not in the ledger; pass --include-unknown" });
      continue;
    }
    const adapter = options.adapters.find((candidate) => candidate.kind === leftover.runtime);
    try {
      const sandbox = await adapter?.get(leftover.sandboxId);
      if (!sandbox) {
        out.push({ leftover, stopped: false, error: "already gone" });
        continue;
      }
      await sandbox.stop();
      const at = options.now();
      const cost = await sandbox.cost();
      const context: RunContext = {
        ...options.context,
        ...(leftover.runId ? { run_id: leftover.runId } : {}),
        ...(leftover.owner ? { owner: leftover.owner } : {}),
        ...(leftover.team ? { team: leftover.team } : {}),
      };
      await options.emit(
        sandboxEvent(
          "sandbox.stopped",
          {
            runtime: leftover.runtime,
            sandbox_id: leftover.sandboxId,
            billing: RUNTIMES[leftover.runtime].billing,
            reason: "reaped",
            billed_seconds: cost.seconds,
            ...(leftover.runEndedAt
              ? {
                  run_ended_at: leftover.runEndedAt,
                  after_run_seconds: Math.max(
                    0,
                    Math.round((at.getTime() - Date.parse(leftover.runEndedAt)) / 1000),
                  ),
                }
              : {}),
          },
          context,
          at,
          { usd: cost.usd, estimated: cost.source === "list_price" },
        ),
      );
      await options.emit(
        runtimeAlert(
          "sandbox_left_running",
          `${leftover.why} selfhost runtime reap stopped it; it had cost $${cost.usd.toFixed(2)}.`,
          context,
          at,
          {
            sandbox_id: leftover.sandboxId,
            runtime: leftover.runtime,
            cost_usd: cost.usd,
            window: leftover.sandboxId,
          },
        ),
      );
      out.push({ leftover, stopped: true });
    } catch (error) {
      out.push({
        leftover,
        stopped: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}
