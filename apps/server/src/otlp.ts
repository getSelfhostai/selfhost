import { gunzipSync } from "node:zlib";
import {
  type Ledger,
  LedgerValidationError,
  mapOtelLogs,
  SourcePayloadError,
} from "@selfhost/ledger";
import type { ApiError, LedgerEvent } from "@selfhost/schema";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MAX_BODY_BYTES } from "./events.js";

/**
 * OTLP/HTTP JSON receiver for the OpenTelemetry collector's otlp_http exporter, with
 * `endpoint: http://<server>/v1/otlp` and `encoding: json`. The exporter appends /v1/logs and
 * /v1/metrics. Log records become ledger events through mapOtelLogs. Metrics are accepted and
 * dropped: they are totals of the same requests the log records already carry, so storing both
 * would count spend twice.
 */
export const OTLP_BASE_PATH = "/v1/otlp";

type OtlpBody = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}

const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) =>
    c.json(apiError("payload_too_large", `Request body over ${MAX_BODY_BYTES} bytes`), 413),
});

/** Reads a JSON export request, gzipped or not, as the OTLP/HTTP spec allows. */
async function readOtlpJson(c: Context): Promise<OtlpBody> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    const message = "Expected Content-Type application/json; set encoding: json on the exporter";
    return { ok: false, response: c.json(apiError("unsupported_media_type", message), 415) };
  }
  const encoding = (c.req.header("content-encoding") ?? "identity").trim().toLowerCase();
  if (encoding !== "identity" && encoding !== "gzip") {
    const message = `Unsupported Content-Encoding ${encoding}; use gzip or none`;
    return { ok: false, response: c.json(apiError("unsupported_media_type", message), 415) };
  }
  let raw = Buffer.from(await c.req.arrayBuffer());
  if (encoding === "gzip") {
    try {
      raw = gunzipSync(raw, { maxOutputLength: MAX_BODY_BYTES });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        const message = `Request body over ${MAX_BODY_BYTES} bytes once decompressed`;
        return { ok: false, response: c.json(apiError("payload_too_large", message), 413) };
      }
      return { ok: false, response: badRequest(c, "Body is not valid gzip") };
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, response: badRequest(c, "Expected a JSON body") };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: badRequest(c, "Expected an OTLP export request object") };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

function badRequest(c: Context, message: string): Response {
  return c.json(apiError("invalid_otlp", message), 400);
}

/** One event per id: a record sent twice in one request maps to the same id. */
function uniqueById(events: LedgerEvent[]): LedgerEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = event.id.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Appends the events the ledger accepts and returns what it refused. A record the ledger
 * refuses would be refused again on retry, so it is reported as rejected, not failed.
 */
async function appendAccepted(
  ledger: Ledger,
  events: LedgerEvent[],
): Promise<{ rejected: number; errorMessage?: string }> {
  if (events.length === 0) return { rejected: 0 };
  try {
    await ledger.append(events);
    return { rejected: 0 };
  } catch (error) {
    if (!(error instanceof LedgerValidationError)) throw error;
    const bad = new Set(error.errors.map((e) => e.index));
    const rest = events.filter((_, index) => !bad.has(index));
    if (rest.length > 0) await ledger.append(rest);
    const [first] = error.errors;
    const detail = first ? `: ${first.path}: ${first.message}` : "";
    return { rejected: bad.size, errorMessage: `${bad.size} log record(s) rejected${detail}` };
  }
}

export function otlpRoutes(app: Hono, ledger: Ledger): void {
  app.post(`${OTLP_BASE_PATH}/v1/logs`, limitBody, async (c) => {
    const body = await readOtlpJson(c);
    if (!body.ok) return body.response;
    // Protobuf JSON leaves out empty repeated fields, so {} is an empty request.
    if (body.value.resourceLogs === undefined) return c.json({});
    let events: LedgerEvent[];
    try {
      events = mapOtelLogs(body.value);
    } catch (error) {
      if (error instanceof SourcePayloadError) return badRequest(c, error.message);
      throw error;
    }
    const { rejected, errorMessage } = await appendAccepted(ledger, uniqueById(events));
    if (rejected === 0) return c.json({});
    return c.json({ partialSuccess: { rejectedLogRecords: rejected, errorMessage } });
  });

  app.post(`${OTLP_BASE_PATH}/v1/metrics`, limitBody, async (c) => {
    const body = await readOtlpJson(c);
    if (!body.ok) return body.response;
    const { resourceMetrics } = body.value;
    if (resourceMetrics !== undefined && !Array.isArray(resourceMetrics)) {
      return badRequest(c, "resourceMetrics: Expected an array");
    }
    return c.json({});
  });
}
