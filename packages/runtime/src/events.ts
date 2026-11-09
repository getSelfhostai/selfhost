import { createHash } from "node:crypto";
import {
  EVENT_SCHEMA,
  type EventSource,
  type LedgerEvent,
  SANDBOX_RECORD_SCHEMA,
  type SandboxEventKind,
  type SandboxRecord,
} from "@selfhost/schema";

/** Who writes sandbox events: selfhost itself. */
export const RUNTIME_ACTOR = { kind: "system", id: "selfhost-runtime" } as const;

/** Where the run a sandbox belongs to sits in the ledger. */
export interface RunContext {
  run_id?: string;
  team?: string;
  org?: string;
  repo?: string;
  /** The person who started the run: gets the review items about it. */
  owner?: string;
  /** Ingest path. Default: server. */
  source?: EventSource;
}

/**
 * A UUIDv7 from the event time and a key, so writing the same sandbox event twice (a retried
 * stop, two reapers) stores one event.
 */
export function stableId(ts: string, key: string): string {
  const ms = Date.parse(ts);
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 2 ** 48 - 1) : 0, 0, 6);
  createHash("sha256").update(key).digest().copy(bytes, 6, 0, 10);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function base(context: RunContext, ts: string) {
  return {
    schema: EVENT_SCHEMA,
    ts,
    source: context.source ?? "server",
    actor: { ...RUNTIME_ACTOR },
    ...(context.org ? { org: context.org } : {}),
    ...(context.team ? { team: context.team } : {}),
    ...(context.repo ? { repo: context.repo } : {}),
    ...(context.run_id ? { run_id: context.run_id } : {}),
  } as const;
}

/**
 * A sandbox.started or sandbox.stopped event. sandbox.stopped carries the sandbox's cost in
 * `cost` (no tokens), estimated when it came from a list price, so spend views can show it next
 * to the run's model cost.
 */
export function sandboxEvent(
  kind: SandboxEventKind,
  record: Omit<SandboxRecord, "schema">,
  context: RunContext,
  at: Date,
  cost?: { usd: number; estimated: boolean },
): LedgerEvent {
  const ts = at.toISOString();
  return {
    id: stableId(ts, `${kind}:${record.runtime}:${record.sandbox_id}`),
    ...base(context, ts),
    kind,
    target: { type: "resource", value: `${record.runtime}:${record.sandbox_id}` },
    data: {
      sandbox: { schema: SANDBOX_RECORD_SCHEMA, ...record },
      ...(context.owner ? { owner: context.owner } : {}),
    },
    ...(kind === "sandbox.stopped"
      ? {
          cost: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            usd: Math.max(0, cost?.usd ?? 0),
            estimated: cost?.estimated ?? true,
          },
        }
      : {}),
  };
}

/**
 * An alert.raised event the review list turns into an item for the run's owner: a runtime cap
 * that was reached (alert budget_exceeded) or a sandbox left running (alert sandbox_left_running).
 */
export function runtimeAlert(
  alert: "budget_exceeded" | "sandbox_left_running",
  message: string,
  context: RunContext,
  at: Date,
  extra: Record<string, unknown> = {},
): LedgerEvent {
  const ts = at.toISOString();
  return {
    id: stableId(ts, `alert:${alert}:${message}`),
    ...base(context, ts),
    kind: "alert.raised",
    data: {
      alert,
      message,
      ...(context.owner ? { owner: context.owner } : {}),
      ...extra,
    },
  };
}
