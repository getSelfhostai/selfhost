import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

/**
 * A local stand-in for a tracer's OTLP/HTTP endpoint. It reads the protobuf export requests the
 * OpenTelemetry exporter sends (opentelemetry-proto, trace/v1) far enough to check what went
 * out: resource attributes, and each span's ids, name, kind, times, attributes and status.
 */

export interface ReceivedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  startNanos: bigint;
  endNanos: bigint;
  attributes: Record<string, unknown>;
  status: { code: number; message: string };
}

export interface ReceivedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  contentType: string | undefined;
  /** The raw body, decompressed, to search for text that must not be there. */
  raw: Buffer;
  resource: Record<string, unknown>;
  spans: ReceivedSpan[];
}

type Field = { field: number; wire: number; value: bigint | Buffer };

function fields(buf: Buffer): Field[] {
  const out: Field[] = [];
  let pos = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = buf[pos++] ?? 0;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  while (pos < buf.length) {
    const key = Number(varint());
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ field, wire, value: varint() });
    else if (wire === 1) {
      out.push({ field, wire, value: buf.readBigUInt64LE(pos) });
      pos += 8;
    } else if (wire === 2) {
      const length = Number(varint());
      out.push({ field, wire, value: buf.subarray(pos, pos + length) });
      pos += length;
    } else if (wire === 5) {
      out.push({ field, wire, value: BigInt(buf.readUInt32LE(pos)) });
      pos += 4;
    } else throw new Error(`Unexpected wire type ${wire}`);
  }
  return out;
}

const bytes = (f: Field) => f.value as Buffer;
const text = (f: Field) => bytes(f).toString("utf8");

function anyValue(buf: Buffer): unknown {
  const [f] = fields(buf);
  if (!f) return undefined;
  switch (f.field) {
    case 1:
      return text(f);
    case 2:
      return f.value === 1n;
    case 3:
      return Number(BigInt.asIntN(64, f.value as bigint));
    case 4: {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(f.value as bigint);
      return b.readDoubleLE(0);
    }
    case 5:
      return fields(bytes(f)).map((item) => anyValue(bytes(item)));
    default:
      return bytes(f);
  }
}

function attributes(list: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list) {
    const parts = fields(bytes(kv));
    const key = parts.find((p) => p.field === 1);
    const value = parts.find((p) => p.field === 2);
    if (key) out[text(key)] = value ? anyValue(bytes(value)) : undefined;
  }
  return out;
}

function span(buf: Buffer): ReceivedSpan {
  const parts = fields(buf);
  const one = (n: number) => parts.find((p) => p.field === n);
  const hex = (n: number) => (one(n) ? bytes(one(n) as Field).toString("hex") : "");
  const status = one(15) ? fields(bytes(one(15) as Field)) : [];
  return {
    traceId: hex(1),
    spanId: hex(2),
    parentSpanId: hex(4),
    name: one(5) ? text(one(5) as Field) : "",
    kind: Number(one(6)?.value ?? 0n),
    startNanos: (one(7)?.value as bigint) ?? 0n,
    endNanos: (one(8)?.value as bigint) ?? 0n,
    attributes: attributes(parts.filter((p) => p.field === 9)),
    status: {
      code: Number(status.find((p) => p.field === 3)?.value ?? 0n),
      message: (() => {
        const m = status.find((p) => p.field === 2);
        return m ? text(m) : "";
      })(),
    },
  };
}

export function decodeTraceRequest(body: Buffer): Pick<ReceivedRequest, "resource" | "spans"> {
  const resource: Record<string, unknown> = {};
  const spans: ReceivedSpan[] = [];
  for (const resourceSpans of fields(body).filter((f) => f.field === 1)) {
    const parts = fields(bytes(resourceSpans));
    for (const r of parts.filter((p) => p.field === 1)) {
      Object.assign(resource, attributes(fields(bytes(r)).filter((p) => p.field === 1)));
    }
    for (const scope of parts.filter((p) => p.field === 2)) {
      for (const s of fields(bytes(scope)).filter((p) => p.field === 2)) spans.push(span(bytes(s)));
    }
  }
  return { resource, spans };
}

export interface FakeReceiver {
  url: string;
  requests: ReceivedRequest[];
  /** Status codes to answer the next requests with, before going back to 200. */
  failNext(...statuses: number[]): void;
  close(): Promise<void>;
}

export async function startReceiver(): Promise<FakeReceiver> {
  const requests: ReceivedRequest[] = [];
  const failures: number[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const status = failures.shift();
      if (status !== undefined) {
        res.writeHead(status).end();
        return;
      }
      let raw = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
      requests.push({
        path: req.url ?? "",
        headers: req.headers,
        contentType: req.headers["content-type"],
        raw,
        ...decodeTraceRequest(raw),
      });
      res.writeHead(200, { "content-type": "application/x-protobuf" }).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    failNext: (...statuses) => failures.push(...statuses),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
