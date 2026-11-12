import type { AdminImporter } from "@selfhost/importers";
import type { Ledger } from "@selfhost/ledger";
import {
  type ApiError,
  acceptedEventSchemas,
  type HealthResponse,
  type ResolvedSelfhostConfig,
} from "@selfhost/schema";
import { Hono } from "hono";
import { roleIn } from "./access.js";
import { requireBearerToken } from "./auth.js";
import { type Background, backgroundWebhookRoute } from "./background.js";
import { consoleRoutes } from "./console.js";
import { refuseContextDecision } from "./context.js";
import { decisionRoutes } from "./decisions.js";
import { type EventRouteOptions, eventRoutes } from "./events.js";
import { type ExceptionKeyring, loadExceptionKeys } from "./exception-keys.js";
import { type Gateway, gatewayAdminRoutes, gatewayProxyRoutes } from "./gateway.js";
import { type GitHubRouteOptions, githubRoutes } from "./github.js";
import { githubRepos, type IntegrationRouteOptions } from "./integrations.js";
import { adminMcpRoute, mcpRoutes } from "./mcp.js";
import { type NotifyRouteOptions, notifyRoutes } from "./notify.js";
import { otlpRoutes } from "./otlp.js";
import type { GitClones } from "./provenance.js";
import { type ReceiptRouteOptions, receiptReadRoutes, receiptRoutes } from "./receipts.js";
import { reviewRoutes } from "./review.js";
import type { SigninOptions } from "./signin.js";
import { type SoloOptions, soloRoutes } from "./solo.js";
import { type PersonEnv, teamRoutes } from "./teams.js";
import { vendorImportAdminRoutes } from "./vendor-usage.js";

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
  /**
   * How GET /v1/integrations checks each tool. Reviewer checks read the team's repositories
   * through the GitHub App above unless repos is given.
   */
  integrations?: IntegrationRouteOptions;
  /** The AI gateway selfhost configures (see gateway.ts). */
  gateway?: Gateway;
  /** How notifications are delivered: the Apprise API in SELFHOST_APPRISE_URL (see notify.ts). */
  notify?: Pick<NotifyRouteOptions, "deliver">;
  /**
   * Background runs (see background.ts): the runner, built with createBackground. Without it the
   * routes answer 503 and GitHub run triggers are not acted on.
   */
  background?: Background;
  /** On the server `selfhost console` runs on a solo laptop: GET /v1/solo (see solo.ts). */
  solo?: SoloOptions;
  /**
   * Called with the kinds and events of each batch of new events POST /v1/events stores, with
   * either kind of token; the response waits for what it returns (see EventRouteOptions.stored).
   * The server refreshes its review list here (refreshOnStored in review.ts).
   */
  eventsStored?: EventRouteOptions["stored"];
  /**
   * The Ed25519 keys one-time exception grants are signed with (exception-keys.ts). Default: a
   * key for this process only, as for an in-memory data dir.
   */
  exceptionKeys?: ExceptionKeyring;
  /**
   * Vendor usage importers for the admin keys set (vendor-usage.ts): GET /v1/vendor-imports
   * shows their status and POST /v1/vendor-imports/run runs them now.
   */
  vendorImporters?: readonly AdminImporter[];
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
  integrations = {},
  gateway,
  notify = {},
  background,
  solo,
  eventsStored,
  exceptionKeys = loadExceptionKeys("memory://"),
  vendorImporters = [],
}: AppOptions): Hono {
  const app = new Hono();
  const review = {
    exceptionKeys,
    ...(config ? { config } : {}),
    ...(now ? { now } : {}),
    ...(github.publicUrl ? { publicUrl: github.publicUrl } : {}),
  };

  // Agents' model traffic with a gateway key, not a selfhost token: before both token checks.
  gatewayProxyRoutes(app, gateway);

  // Signed by GitHub instead of a bearer token, so they go before both token checks.
  const pulls = githubRoutes(app, ledger, {
    ...(clones ? { clones } : {}),
    ...(background ? { background } : {}),
    ...github,
  });
  backgroundWebhookRoute(app, ledger, background, github.team);
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
    integrations: {
      ...(github.app ? { repos: githubRepos(github.app, ledger) } : {}),
      ...(now ? { now } : {}),
      ...integrations,
    },
    ...(gateway ? { gateway } : {}),
    ...(background ? { background } : {}),
    ...(eventsStored ? { eventsStored } : {}),
    vendorImporters,
    handoffs: {
      ...(config ? { config } : {}),
      ...(github.publicUrl ? { publicUrl: github.publicUrl } : {}),
      ...(github.app ? { githubApp: github.app } : {}),
    },
    personRoutes: (person) => {
      reviewRoutes(person, ledger, {
        ...review,
        person: (c) => (c.env as PersonEnv["Bindings"]).person,
        teams: async (c) => {
          const { person: own, caller } = c.env as PersonEnv["Bindings"];
          const { memberships } = await caller.scope();
          return [own.team, ...memberships.map((m) => m.team).filter((t) => t !== own.team)];
        },
        role: (c, team) => roleIn((c.env as PersonEnv["Bindings"]).caller, team),
        beforeDecision: (c, id) =>
          refuseContextDecision(c, ledger, (c.env as PersonEnv["Bindings"]).caller, id),
      });
      mcpRoutes(person, ledger, { version, ...review });
      notifyRoutes(person, ledger, {
        ...notify,
        ...(config ? { config } : {}),
        ...(now ? { now } : {}),
      });
    },
  });
  // The console's files hold no data, so they need no token; what they read from /v1 does.
  if (web) consoleRoutes(app, web.dir);
  app.use("*", requireBearerToken(token));

  app.get("/v1/health", (c) =>
    c.json({ ok: true, version, event_schemas: acceptedEventSchemas() } satisfies HealthResponse),
  );

  eventRoutes(app, ledger, {
    ...(eventsStored ? { stored: eventsStored } : {}),
    ...(now ? { now } : {}),
  });
  decisionRoutes(app, ledger);
  reviewRoutes(app, ledger, review);
  otlpRoutes(app, ledger);
  adminMcpRoute(app);
  receiptReadRoutes(app, ledger);
  gatewayAdminRoutes(app, ledger, gateway);
  vendorImportAdminRoutes(app, ledger, vendorImporters, now);
  if (solo) soloRoutes(app, solo);

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
