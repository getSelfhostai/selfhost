import { createHash } from "node:crypto";

const hex = (text: string, bytes: number) =>
  createHash("sha256").update(text).digest().subarray(0, bytes).toString("hex");

/**
 * The OpenTelemetry trace id a run is sent under: 32 hex characters derived from the run id, so
 * every export of the same run lands in the same trace and a link can be built without asking
 * the tracer.
 */
export function traceIdOf(runId: string): string {
  return hex(`selfhost:trace:${runId}`, 16);
}

/** A span id that stays the same for the same run and key: the root span or one ledger event. */
export function spanIdOf(runId: string, key: string): string {
  return hex(`selfhost:span:${runId}:${key}`, 8);
}

/**
 * The run in the tracer's own UI: `[integrations.tracer] run_url` with `{run_id}` and
 * `{trace_id}` filled in. Undefined without a template.
 */
export function tracerRunUrl(template: string | undefined, runId: string): string | undefined {
  if (!template) return undefined;
  return template
    .replaceAll("{run_id}", encodeURIComponent(runId))
    .replaceAll("{trace_id}", traceIdOf(runId));
}

/** The console's view of one run: `<public url>/runs/<run id>`. */
export function runViewUrl(server: string, runId: string): string {
  return `${server.replace(/\/+$/, "")}/runs/${encodeURIComponent(runId)}`;
}
