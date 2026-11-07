import type { Ledger } from "@selfhost/ledger";
import type { ApiError, HealthResponse } from "@selfhost/schema";
import { Hono } from "hono";
import { requireBearerToken } from "./auth.js";
import { eventRoutes } from "./events.js";
import { otlpRoutes } from "./otlp.js";

export interface AppOptions {
  version: string;
  ledger: Ledger;
  /** Bearer token every route except /v1/health requires. */
  token: string;
}

export function createApp({ version, ledger, token }: AppOptions): Hono {
  const app = new Hono();

  app.use("*", requireBearerToken(token));

  app.get("/v1/health", (c) => c.json({ ok: true, version } satisfies HealthResponse));

  eventRoutes(app, ledger);
  otlpRoutes(app, ledger);

  app.notFound((c) =>
    c.json(
      {
        error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` },
      } satisfies ApiError,
      404,
    ),
  );

  app.onError((error, c) => {
    console.error(error);
    return c.json(
      { error: { code: "internal", message: "Internal server error" } } satisfies ApiError,
      500,
    );
  });

  return app;
}
