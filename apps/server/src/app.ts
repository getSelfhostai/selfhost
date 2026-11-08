import type { Ledger } from "@selfhost/ledger";
import {
  type ApiError,
  acceptedEventSchemas,
  type HealthResponse,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import { Hono } from "hono";
import { requireBearerToken } from "./auth.js";
import { decisionRoutes } from "./decisions.js";
import { eventRoutes } from "./events.js";
import { type GitHubRouteOptions, githubRoutes } from "./github.js";
import { otlpRoutes } from "./otlp.js";
import { reviewRoutes } from "./review.js";
import { type PersonEnv, teamRoutes } from "./teams.js";

export interface AppOptions {
  version: string;
  ledger: Ledger;
  /** Bearer token every route except /v1/health requires. */
  token: string;
  /** selfhost.toml for review items built from events with no team policy. */
  config?: ResolvedSelfhostConfig;
  /** Clock for review list reads and answers. */
  now?: () => Date;
  /** The GitHub App delivery. Without an App, POST /v1/github/webhooks answers 404. */
  github?: GitHubRouteOptions;
}

export function createApp({ version, ledger, token, config, now, github = {} }: AppOptions): Hono {
  const app = new Hono();
  const review = { ...(config ? { config } : {}), ...(now ? { now } : {}) };

  // Signed by GitHub instead of a bearer token, so it goes before both token checks.
  githubRoutes(app, ledger, github);
  teamRoutes(app, {
    ledger,
    token,
    ...(now ? { now } : {}),
    personRoutes: (person) =>
      reviewRoutes(person, ledger, {
        ...review,
        person: (c) => (c.env as PersonEnv["Bindings"]).person,
        teams: async (c) => {
          const { person: own, caller } = c.env as PersonEnv["Bindings"];
          const { memberships } = await caller.scope();
          return [own.team, ...memberships.map((m) => m.team).filter((t) => t !== own.team)];
        },
      }),
  });
  app.use("*", requireBearerToken(token));

  app.get("/v1/health", (c) =>
    c.json({ ok: true, version, event_schemas: acceptedEventSchemas() } satisfies HealthResponse),
  );

  eventRoutes(app, ledger);
  decisionRoutes(app, ledger);
  reviewRoutes(app, ledger, review);
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
