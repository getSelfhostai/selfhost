import { randomBytes } from "node:crypto";
import {
  BACKGROUND_RUN_SCHEMA,
  type BackgroundRun,
  EVENT_SCHEMA,
  type LedgerEvent,
  RUN_GATE_SCHEMA,
  RUN_HEALTH_SCHEMA,
  RUN_OUTPUT_SCHEMA,
  type RunGate,
  type RunHealth,
  type RunTriggeredData,
} from "@selfhost/schema";
import { AGENT_CLIS } from "./agents.js";
import type { RunAlert } from "./types.js";

/** A UUIDv7: the time in the first 48 bits, so ids sort by time. */
export function uuidv7(now: Date): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Math.max(0, now.getTime()), 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The actor id of selfhost itself on what a run writes when no person is behind it. */
export const RUNNER_ACTOR_ID = "selfhost-runner";

/** Most lines in one run.output event, and most characters kept of one line. */
export const OUTPUT_LINES_PER_EVENT = 200;
export const OUTPUT_LINE_CHARS = 2000;

function base(run: BackgroundRun, kind: LedgerEvent["kind"], at: Date): LedgerEvent {
  return {
    id: uuidv7(at),
    schema: EVENT_SCHEMA,
    ts: at.toISOString(),
    source: "server",
    kind,
    actor: run.person
      ? { kind: "person", id: run.person }
      : { kind: "system", id: RUNNER_ACTOR_ID },
    team: run.team,
    ...(run.org ? { org: run.org } : {}),
    repo: run.repo,
    agent: { vendor: AGENT_CLIS[run.agent].vendor },
    run_id: run.id,
    ...(run.pr_url ? { links: { pr_url: run.pr_url } } : {}),
  };
}

/** run.triggered: every trigger, accepted or refused, with who sent it and the run it started. */
export function triggeredEvent(
  data: Omit<RunTriggeredData, "schema">,
  where: { team?: string; org?: string; repo?: string; runId?: string },
  at: Date,
): LedgerEvent {
  return {
    id: uuidv7(at),
    schema: EVENT_SCHEMA,
    ts: at.toISOString(),
    source: "server",
    kind: "run.triggered",
    actor: data.person
      ? { kind: "person", id: data.person }
      : { kind: "system", id: RUNNER_ACTOR_ID },
    ...(where.team ? { team: where.team } : {}),
    ...(where.org ? { org: where.org } : {}),
    ...(where.repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(where.repo)
      ? { repo: where.repo }
      : {}),
    ...(where.runId ? { run_id: where.runId } : {}),
    data: { trigger: { schema: "selfhost.run_trigger/v1", ...data } },
  };
}

/** run.updated: the run moved to a new state, or tried again. */
export function updatedEvent(run: BackgroundRun, at: Date): LedgerEvent {
  return {
    ...base(run, "run.updated", at),
    data: {
      background_run: {
        schema: BACKGROUND_RUN_SCHEMA,
        state: run.state,
        attempt: run.attempt,
        ...(run.reason ? { reason: run.reason } : {}),
        runtime: run.runtime,
        ...(run.sandbox_id ? { sandbox_id: run.sandbox_id } : {}),
        branch: run.branch,
        ...(run.credential ? { credential: run.credential } : {}),
        trigger: run.trigger.source,
        cost: run.cost,
        ...(run.cancel ? { cancel: run.cancel } : {}),
      },
    },
  };
}

/** run.output: lines the agent printed, in order. The ledger masks secrets in them on write. */
export function outputEvent(run: BackgroundRun, lines: string[], at: Date): LedgerEvent {
  return {
    ...base(run, "run.output", at),
    data: {
      output: {
        schema: RUN_OUTPUT_SCHEMA,
        attempt: run.attempt,
        lines: lines.map((line) =>
          line.length > OUTPUT_LINE_CHARS ? `${line.slice(0, OUTPUT_LINE_CHARS)}...` : line,
        ),
      },
    },
  };
}

export function healthEvent(run: BackgroundRun, health: RunHealth, at: Date): LedgerEvent {
  return {
    ...base(run, "run.health", at),
    data: { health: { schema: RUN_HEALTH_SCHEMA, ...health } },
  };
}

export function gateEvent(run: BackgroundRun, gate: RunGate, at: Date): LedgerEvent {
  const { output: _output, ...kept } = gate;
  return { ...base(run, "run.gate", at), data: { gate: { schema: RUN_GATE_SCHEMA, ...kept } } };
}

/**
 * alert.raised for a run that failed, was stopped as stuck or timed out. The review list turns
 * it into a stuck_run item for the run's owner (the actor), keyed on the run.
 */
export function alertEvent(run: BackgroundRun, alert: RunAlert, at: Date): LedgerEvent {
  return {
    ...base(run, "alert.raised", at),
    data: {
      alert: alert.kind === "run_timed_out" ? "run_failed" : alert.kind,
      message: alert.title,
      error: alert.body,
      background_run: run.id,
    },
  };
}

/** pr.opened for the run's pull request, so the review list opens its item at once. */
export function pullOpenedEvent(
  run: BackgroundRun,
  pull: { number: number; url: string; title: string; headSha?: string },
  at: Date,
): LedgerEvent {
  const event = base({ ...run, pr_url: pull.url }, "pr.opened", at);
  return {
    ...event,
    target: { type: "pr", value: pull.url },
    links: {
      pr_url: pull.url,
      ...(pull.headSha && /^[0-9a-f]{7,64}$/.test(pull.headSha)
        ? { commit_sha: pull.headSha }
        : {}),
    },
    data: {
      number: pull.number,
      title: pull.title,
      signal: "selfhost background run",
      ...(run.gate && run.gate.result !== "skipped"
        ? { tests: run.gate.result === "passed" ? "passed" : "failed" }
        : {}),
    },
  };
}
