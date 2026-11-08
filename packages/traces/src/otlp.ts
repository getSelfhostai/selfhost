import type { TracerTool } from "@selfhost/schema";
import type { TraceSpan } from "./map.js";

/** `[integrations.tracer]` from selfhost.toml. */
export interface TracerSettings {
  tool: TracerTool;
  endpoint: string;
  headers_env?: Record<string, string>;
  run_url?: string;
}

/** Sends spans to one tracer. Resolves once the tracer accepted them, else rejects. */
export type SpanSender = (spans: TraceSpan[]) => Promise<void>;

export class TracerConfigError extends Error {}

/** Where spans go: the endpoint itself when it already names /v1/traces, else <endpoint>/v1/traces. */
export function tracesUrl(endpoint: string): string {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1/traces") ? path : `${path}/v1/traces`;
  return url.toString();
}

/** Fixed headers some tracers need to route OTLP spans to their LLM view. */
const TOOL_HEADERS: Partial<Record<TracerTool, Record<string, string>>> = {
  datadog: { "dd-otlp-source": "llmobs", "DD-LLMObs-Enabled": "true" },
};

/** Resource attributes on every span, by tracer. */
const TOOL_RESOURCE: Partial<Record<TracerTool, Record<string, string | boolean>>> = {
  datadog: { dd_llmobs_enabled: true },
  phoenix: { "openinference.project.name": "selfhost" },
};

/**
 * The headers to send: each `headers_env` entry read from the environment, on top of the fixed
 * ones the tool needs. A variable that is not set is an error naming the variable, never a value.
 */
export function tracerHeaders(
  tracer: TracerSettings,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const headers: Record<string, string> = { ...TOOL_HEADERS[tracer.tool] };
  const missing: string[] = [];
  for (const [name, variable] of Object.entries(tracer.headers_env ?? {})) {
    const value = env[variable];
    if (value === undefined || value === "") missing.push(`${variable} (header ${name})`);
    else headers[name] = value;
  }
  if (missing.length > 0) {
    throw new TracerConfigError(
      `[integrations.tracer] headers_env names environment variables that are not set: ${missing.join(", ")}`,
    );
  }
  return headers;
}

const nanos = (ts: string): [number, number] => {
  const ms = Date.parse(ts);
  return [Math.floor(ms / 1000), (ms % 1000) * 1e6];
};

/**
 * A sender that exports over OTLP/HTTP protobuf with the official OpenTelemetry JS exporter.
 * Spans are built with the SDK's tracer, with their ids fixed in advance so sending a run again
 * lands on the same spans. The SDK is loaded on first use, so commands that never send do not
 * pay for it.
 */
export function otlpSender(
  tracer: TracerSettings,
  options: { env?: NodeJS.ProcessEnv; timeoutMillis?: number; version?: string } = {},
): SpanSender {
  const headers = tracerHeaders(tracer, options.env);
  const url = tracesUrl(tracer.endpoint);
  let loaded: Promise<SpanSender> | undefined;
  const load = async (): Promise<SpanSender> => {
    const [api, sdk, resources, core, exporters] = await Promise.all([
      import("@opentelemetry/api"),
      import("@opentelemetry/sdk-trace"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/core"),
      import("@opentelemetry/exporter-trace-otlp-proto"),
    ]);
    const exporter = new exporters.OTLPTraceExporter({
      url,
      headers,
      timeoutMillis: options.timeoutMillis ?? 10_000,
    });
    const next = { traceId: "", spanId: "" };
    const memory = new sdk.InMemorySpanExporter();
    const provider = new sdk.TracerProvider({
      resource: resources.resourceFromAttributes({
        "service.name": "selfhost",
        ...(options.version ? { "service.version": options.version } : {}),
        ...TOOL_RESOURCE[tracer.tool],
      }),
      idGenerator: {
        generateTraceId: () => next.traceId,
        generateSpanId: () => next.spanId,
      },
      spanProcessors: [new sdk.SimpleSpanProcessor({ exporter: memory })],
    });
    const otel = provider.getTracer("selfhost", options.version);
    return async (spans) => {
      memory.reset();
      for (const span of spans) {
        next.traceId = span.traceId;
        next.spanId = span.spanId;
        const parent = span.parentSpanId
          ? api.trace.setSpanContext(api.ROOT_CONTEXT, {
              traceId: span.traceId,
              spanId: span.parentSpanId,
              traceFlags: api.TraceFlags.SAMPLED,
              isRemote: true,
            })
          : api.ROOT_CONTEXT;
        const started = otel.startSpan(
          span.name,
          {
            kind: span.kind === "client" ? api.SpanKind.CLIENT : api.SpanKind.INTERNAL,
            startTime: nanos(span.start),
            attributes: span.attributes,
            root: !span.parentSpanId,
          },
          parent,
        );
        if (span.error) {
          started.setStatus({
            code: api.SpanStatusCode.ERROR,
            ...(span.error.message ? { message: span.error.message } : {}),
          });
        }
        started.end(nanos(span.end));
      }
      const finished = memory.getFinishedSpans();
      memory.reset();
      if (finished.length === 0) return;
      await new Promise<void>((resolve, reject) => {
        exporter.export(finished, (result) => {
          if (result.code === core.ExportResultCode.SUCCESS) resolve();
          else reject(result.error ?? new Error("The tracer refused the spans"));
        });
      });
    };
  };
  return async (spans) => {
    loaded ??= load();
    loaded.catch(() => {
      loaded = undefined;
    });
    return (await loaded)(spans);
  };
}
