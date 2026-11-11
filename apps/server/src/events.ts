import {
  type EventFilter,
  type Ledger,
  type LedgerFieldError,
  LedgerQueryError,
  LedgerValidationError,
} from "@selfhost/ledger";
import {
  type ApiError,
  type EventsPage,
  type IngestEventsError,
  type IngestEventsResponse,
  MAX_EVENT_BATCH,
} from "@selfhost/schema";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

/** 1000 events of a few KB each fit comfortably; anything bigger is refused before parsing. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

type BatchError = IngestEventsError["errors"][number];

const ROOT_FIELD = "(root)";

const QUERY_KEYS = [
  "person",
  "agent",
  "model",
  "session",
  "kind",
  "team",
  "from",
  "to",
  "limit",
  "cursor",
];

export interface EventRouteOptions {
  /**
   * The team a request is limited to, for requests made with a person token: its writes are
   * stored with this team and its reads see only this team's events.
   */
  team?: (c: Context) => string | undefined;
  /** The person of that token, so a write naming another team's repo stays in their team. */
  person?: (c: Context) => string | undefined;
}

function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}

function invalidEvents(c: Context, errors: BatchError[]) {
  const body: IngestEventsError = {
    error: {
      code: "invalid_events",
      message: `${errors.length} problem(s) found, nothing was written`,
    },
    errors,
  };
  return c.json(body, 400);
}

const toBatchError = (e: LedgerFieldError): BatchError => ({
  index: e.index,
  field: e.path,
  message: e.message,
});

export function eventRoutes(app: Hono, ledger: Ledger, options: EventRouteOptions = {}): void {
  app.post(
    "/v1/events",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(apiError("payload_too_large", `Request body over ${MAX_BODY_BYTES} bytes`), 413),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return invalidEvents(c, [
          { index: -1, field: ROOT_FIELD, message: "Expected a JSON body" },
        ]);
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return invalidEvents(c, [
          { index: -1, field: ROOT_FIELD, message: "Expected an object with an events array" },
        ]);
      }
      const unexpected = Object.keys(body).filter((key) => key !== "events");
      if (unexpected.length > 0) {
        return invalidEvents(
          c,
          unexpected.map((field) => ({ index: -1, field, message: "Unexpected property" })),
        );
      }
      const { events } = body as { events?: unknown };
      if (!Array.isArray(events)) {
        return invalidEvents(c, [{ index: -1, field: "events", message: "Expected an array" }]);
      }
      if (events.length > MAX_EVENT_BATCH) {
        const message = `At most ${MAX_EVENT_BATCH} events per request, got ${events.length}`;
        return c.json(apiError("too_many_events", message), 413);
      }
      if (events.length === 0) {
        const message = `Expected between 1 and ${MAX_EVENT_BATCH} events, got 0`;
        return invalidEvents(c, [{ index: -1, field: "events", message }]);
      }
      try {
        const person = options.person?.(c);
        const result = await ledger.append(events, {
          team: options.team?.(c),
          ...(person !== undefined ? { person } : {}),
        });
        return c.json({
          accepted: result.accepted.length,
          duplicates: result.duplicates.length,
        } satisfies IngestEventsResponse);
      } catch (error) {
        if (error instanceof LedgerValidationError) {
          return invalidEvents(c, error.errors.map(toBatchError));
        }
        throw error;
      }
    },
  );

  app.get("/v1/events", async (c) => {
    const params = c.req.queries();
    const filter: Record<string, string | number> = {};
    for (const [key, values] of Object.entries(params)) {
      if (!QUERY_KEYS.includes(key)) return invalidQuery(c, key, "Unknown query parameter");
      if (values.length !== 1) return invalidQuery(c, key, "Expected one value");
      const [value = ""] = values;
      if (key === "limit") {
        if (!/^\d+$/.test(value)) return invalidQuery(c, key, "Expected an integer");
        filter.limit = Number(value);
      } else {
        filter[key] = value;
      }
    }
    const team = options.team?.(c);
    if (team !== undefined) {
      if (filter.team !== undefined && filter.team !== team) {
        return c.json(
          apiError("forbidden", "A person token reads only its own team's events"),
          403,
        );
      }
      filter.team = team;
    }
    try {
      const page = await ledger.query(filter as EventFilter);
      return c.json({
        events: page.events,
        next_cursor: page.nextCursor ?? null,
      } satisfies EventsPage);
    } catch (error) {
      if (error instanceof LedgerQueryError) {
        return c.json(apiError("invalid_query", error.message), 400);
      }
      throw error;
    }
  });
}

function invalidQuery(c: Context, field: string, message: string) {
  return c.json(apiError("invalid_query", `${field}: ${message}`), 400);
}
