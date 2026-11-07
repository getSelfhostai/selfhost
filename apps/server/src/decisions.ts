import {
  DecisionInputError,
  type Ledger,
  LedgerQueryError,
  recordDecision,
  renderDecisions,
} from "@selfhost/ledger";
import {
  type ApiError,
  type CreateDecisionRequest,
  type CreateDecisionResponse,
  type DecisionQuery,
  DecisionQuerySchema,
  type DecisionsPage,
} from "@selfhost/schema";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

/** A decision is a few fields and a reason; anything this big is not one. */
const MAX_DECISION_BYTES = 256 * 1024;

const QUERY_KEYS = new Set(Object.keys(DecisionQuerySchema.properties));
const FORMATS = ["json", "text"];

function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}

function invalidQuery(c: Context, field: string, message: string) {
  return c.json(apiError("invalid_query", `${field}: ${message}`), 400);
}

function invalidDecision(c: Context, message: string) {
  return c.json(apiError("invalid_decision", message), 400);
}

/**
 * The decision log: POST /v1/decisions records one human decision through recordDecision, the
 * call every surface uses, and GET /v1/decisions searches decisions and rule verdicts as JSON
 * or, with format=text, as the plain text the CLI and the MCP tool print.
 */
export function decisionRoutes(app: Hono, ledger: Ledger): void {
  app.post(
    "/v1/decisions",
    bodyLimit({
      maxSize: MAX_DECISION_BYTES,
      onError: (c) =>
        c.json(apiError("payload_too_large", `Request body over ${MAX_DECISION_BYTES} bytes`), 413),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return invalidDecision(c, "Expected a JSON body");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return invalidDecision(c, "Expected a JSON object");
      }
      try {
        const { event, duplicate } = await recordDecision(ledger, body as CreateDecisionRequest);
        const response: CreateDecisionResponse = { decision_event: event, duplicate };
        return c.json(response, duplicate ? 200 : 201);
      } catch (error) {
        if (error instanceof DecisionInputError) {
          const message = error.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
          return invalidDecision(c, message);
        }
        throw error;
      }
    },
  );

  app.get("/v1/decisions", async (c) => {
    const query: Record<string, string | number> = {};
    let format = "json";
    for (const [key, values] of Object.entries(c.req.queries())) {
      if (key !== "format" && !QUERY_KEYS.has(key)) {
        return invalidQuery(c, key, "Unknown query parameter");
      }
      if (values.length !== 1) return invalidQuery(c, key, "Expected one value");
      const [value = ""] = values;
      if (key === "format") {
        if (!FORMATS.includes(value)) return invalidQuery(c, key, "Expected json or text");
        format = value;
      } else if (key === "limit") {
        if (!/^\d+$/.test(value)) return invalidQuery(c, key, "Expected an integer");
        query.limit = Number(value);
      } else {
        query[key] = value;
      }
    }
    try {
      const page = await ledger.decisions.search(query as DecisionQuery);
      if (format === "text") return c.text(`${renderDecisions(page)}\n`);
      return c.json({
        decisions: page.events,
        next_cursor: page.nextCursor ?? null,
      } satisfies DecisionsPage);
    } catch (error) {
      if (error instanceof LedgerQueryError) {
        return c.json(apiError("invalid_query", error.message), 400);
      }
      throw error;
    }
  });
}
