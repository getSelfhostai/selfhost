import type { Ledger } from "@selfhost/ledger";
import {
  type ApiError,
  acceptedEventSchemas,
  type HealthResponse,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import { Hono } from "hono";
import { requireBearerToken } from "./auth.js";
import { consoleRoutes } from "./console.js";
import { decisionRoutes } from "./decisions.js";
import { eventRoutes } from "./events.js";
import { type GitHubRouteOptions, githubRoutes } from "./github.js";
import { adminMcpRoute, mcpRoutes } from "./mcp.js";
import { otlpRoutes } from "./otlp.js";
import type { GitClones } from "./provenance.js";
import { type ReceiptRouteOptions, receiptReadRoutes, receiptRoutes } from "./receipts.js";
import { reviewRoutes } from "./review.js";
import type { SigninOptions } from "./signin.js";
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
  /**
   * Serve the web console at / from this folder (see console.ts); undefined dir serves a page
   * saying it is not built. Without it, only /v1 answers.
   */
  console?: { dir: string | undefined };
  /** Console sign-in through a proxy that forwards the person's email (see signin.ts). */
  signin?: SigninOptions;
  /**
   * Clones of the teams' repos (SELFHOST_GIT_CLONES), for line-level provenance and module
   * revert rates. Without them, provenance comes from the ledger alone.
   */
  clones?: GitClones;
  /** How POST /v1/receipts checks the CI job's OIDC token. It uses the GitHub App above. */
  receipts?: Pick<ReceiptRouteOptions, "oidc" | "load">;
}

export function createApp({
  version,
  ledger,
  token,
  config,
  now,
  github = {},
  console: web,
  signin,
  clones,
  receipts = {},
}: AppOptions): Hono {
  const app = new Hono();
  const review = {
    ...(config ? { config } : {}),
    ...(now ? { now } : {}),
    ...(github.publicUrl ? { publicUrl: github.publicUrl } : {}),
  };

  // Signed by GitHub instead of a bearer token, so they go before both token checks.
  const pulls = githubRoutes(app, ledger, { ...(clones ? { clones } : {}), ...github });
  receiptRoutes(app, ledger, {
    ...receipts,
    ...(github.app ? { app: github.app } : {}),
    ...(pulls ? { pulls } : {}),
    ...(github.publicUrl ? { publicUrl: github.publicUrl } : {}),
    ...(github.log ? { log: github.log } : {}),
  });
  teamRoutes(app, {
    ledger,
    token,
    ...(now ? { now } : {}),
    ...(signin ? { signin } : {}),
    provenance: { ...(clones ? { clones } : {}), ...(config ? { config } : {}) },
    runs: config ? { config } : {},
    personRoutes: (person) => {
      reviewRoutes(person, ledger, {
        ...review,
        person: (c) => (c.env as PersonEnv["Bindings"]).person,
        teams: async (c) => {
          const { person: own, caller } = c.env as PersonEnv["Bindings"];
          const { memberships } = await caller.scope();
          return [own.team, ...memberships.map((m) => m.team).filter((t) => t !== own.team)];
        },
      });
      mcpRoutes(person, ledger, { version, ...review });
    },
  });
  // The console's files hold no data, so they need no token; what they read from /v1 does.
  if (web) consoleRoutes(app, web.dir);
  app.use("*", requireBearerToken(token));

  app.get("/v1/health", (c) =>
    c.json({ ok: true, version, event_schemas: acceptedEventSchemas() } satisfies HealthResponse),
  );

  eventRoutes(app, ledger);
  decisionRoutes(app, ledger);
  reviewRoutes(app, ledger, review);
  otlpRoutes(app, ledger);
  adminMcpRoute(app);
  receiptReadRoutes(app, ledger);

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
