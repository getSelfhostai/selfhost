import type { ApiError, HealthResponse } from "@selfhost/schema";
import { Hono } from "hono";

export interface AppOptions {
  version: string;
}

export function createApp({ version }: AppOptions): Hono {
  const app = new Hono();

  app.get("/v1/health", (c) => c.json({ ok: true, version } satisfies HealthResponse));

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
