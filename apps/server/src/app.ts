import type { Ledger } from "@selfhost/ledger";
import type { ApiError, HealthResponse } from "@selfhost/schema";
import { Hono } from "hono";
import { requireBearerToken } from "./auth.js";
import { decisionRoutes } from "./decisions.js";
import { eventRoutes } from "./events.js";
import { type GitHubRouteOptions, githubRoutes } from "./github.js";
import { otlpRoutes } from "./otlp.js";
import { teamRoutes } from "./teams.js";

export interface AppOptions {
  version: string;
  ledger: Ledger;
  /** Bearer token every route except /v1/health requires. */
  token: string;
  /** The GitHub App delivery. Without an App, POST /v1/github/webhooks answers 404. */
  github?: GitHubRouteOptions;
}

export function createApp({ version, ledger, token, github = {} }: AppOptions): Hono {
  const app = new Hono();

  // Signed by GitHub instead of a bearer token, so it goes before both token checks.
  githubRoutes(app, ledger, github);
  teamRoutes(app, { ledger, token });
  app.use("*", requireBearerToken(token));

  app.get("/v1/health", (c) => c.json({ ok: true, version } satisfies HealthResponse));

  eventRoutes(app, ledger);
  decisionRoutes(app, ledger);
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
