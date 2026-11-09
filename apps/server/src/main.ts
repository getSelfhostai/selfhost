import { serve } from "@hono/node-server";
import { openLedger, resolveDataDir } from "@selfhost/ledger";
import { redactionSettings } from "@selfhost/schema";
import pkg from "../package.json" with { type: "json" };
import { createApp } from "./app.js";
import { startCacheAlertJob } from "./cache-alerts.js";
import { findConsoleDir } from "./console.js";
import { gatewayFromEnv, startGatewayJob } from "./gateway.js";
import { githubAppFromEnv, githubConfig } from "./github.js";
import { notifyFromEnv, startNotifyJob } from "./notify.js";
import { clonesUnder } from "./provenance.js";
import { serverConfig, startRetentionJob } from "./retention.js";
import { startReviewRefreshJob } from "./review.js";
import { startTraceExportJob } from "./runs.js";
import { signinFromEnv } from "./signin.js";
import { loadApiToken } from "./token.js";

const port = Number(process.env.PORT ?? 4400);
const hostname = process.env.HOST ?? "127.0.0.1";
const dataDir = resolveDataDir();
const config = serverConfig();

// Applies pending migrations first. A failed one changes nothing, and a schema newer than this
// release (SchemaTooNewError) stops the server before it serves a request.
const ledger = await openLedger({
  url: process.env.DATABASE_URL,
  dataDir,
  redaction: redactionSettings(config),
}).catch((error: unknown) => {
  console.error(
    `selfhost server ${pkg.version} did not start: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
});
const { token, path, created } = loadApiToken(dataDir);
if (created) {
  const where = path ? `saved to ${path}` : "not saved, the data dir is in memory";
  console.log(`API token (${where}): ${token}`);
}

const githubTeam = process.env.SELFHOST_GITHUB_TEAM?.trim() || undefined;
const publicUrl = process.env.SELFHOST_PUBLIC_URL?.trim() || undefined;
const github = {
  app: githubAppFromEnv(),
  config: githubConfig(ledger, config, githubTeam),
  ...(githubTeam ? { team: githubTeam } : {}),
  ...(publicUrl ? { publicUrl } : {}),
};

// SELFHOST_CONSOLE=off answers only /v1, for installs that serve the console some other way.
const web = process.env.SELFHOST_CONSOLE === "off" ? undefined : { dir: findConsoleDir() };
const signin = signinFromEnv();
// Clones of the teams' repos at <dir>/<owner>/<name>, for line-level provenance and module
// revert rates. The server only reads them; keep them current with git fetch.
const clonesDir = process.env.SELFHOST_GIT_CLONES?.trim() || undefined;
const clones = clonesDir ? clonesUnder(clonesDir) : undefined;

// The AI gateway from [integrations.router], or the bundled Bifrost (compose.gateway.yml).
const gateway = gatewayFromEnv(config);
// The Apprise API notifications go through (compose.notify.yml, or one the team runs).
const deliver = notifyFromEnv();

const server = serve(
  {
    fetch: createApp({
      version: pkg.version,
      ledger,
      token,
      config,
      github,
      ...(web ? { console: web } : {}),
      ...(signin ? { signin } : {}),
      ...(clones ? { clones } : {}),
      ...(gateway ? { gateway } : {}),
      ...(deliver ? { notify: { deliver } } : {}),
    }).fetch,
    port,
    hostname,
  },
  (info) => {
    console.log(`selfhost server ${pkg.version} listening on http://${hostname}:${info.port}`);
    if (web) {
      console.log(web.dir ? `console at http://${hostname}:${info.port}/` : "console not built");
    }
    if (signin) console.log("console sign-in through the proxy is on");
    if (gateway)
      console.log(`AI gateway: ${gateway.client.tool}, agents reach it at ${gateway.baseUrl}`);
    console.log(
      deliver
        ? "notifications: on, through Apprise"
        : "notifications: off (set SELFHOST_APPRISE_URL, or add compose.notify.yml)",
    );
  },
);

// SELFHOST_RETENTION_SWEEP=off keeps every event, for installs that prune some other way.
const retention =
  process.env.SELFHOST_RETENTION_SWEEP === "off"
    ? undefined
    : startRetentionJob(ledger, { days: config.ledger.retention_days });

// SELFHOST_REVIEW_REFRESH=off stops building review items from new events and timing out
// approvals, for installs where another server does it against the same database.
const reviews =
  process.env.SELFHOST_REVIEW_REFRESH === "off"
    ? undefined
    : startReviewRefreshJob(ledger, { config });

// SELFHOST_TRACE_EXPORT=off stops sending finished runs to each team's [integrations.tracer],
// for installs where another server sends them from the same database.
const traces =
  process.env.SELFHOST_TRACE_EXPORT === "off" ? undefined : startTraceExportJob(ledger, { config });

// SELFHOST_GATEWAY_SYNC=off stops writing the gateway's settings and reading its usage, for
// installs where another server does it.
const gatewayJob =
  gateway && process.env.SELFHOST_GATEWAY_SYNC !== "off"
    ? startGatewayJob(ledger, gateway)
    : undefined;

// SELFHOST_NOTIFY=off stops sending notifications, for installs where another server sends
// them from the same database.
const notifications =
  deliver && process.env.SELFHOST_NOTIFY !== "off"
    ? startNotifyJob(ledger, { deliver, config, ...(publicUrl ? { publicUrl } : {}) })
    : undefined;

// SELFHOST_CACHE_ALERTS=off stops raising prompt cache alerts for sessions whose hit rate
// collapsed, for installs where another server raises them from the same database.
const cacheAlerts =
  process.env.SELFHOST_CACHE_ALERTS === "off" ? undefined : startCacheAlertJob(ledger, { config });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    retention?.stop();
    cacheAlerts?.stop();
    notifications?.stop();
    gatewayJob?.stop();
    reviews?.stop();
    traces?.stop();
    server.close(() => {
      ledger.close().finally(() => process.exit(0));
    });
  });
}
