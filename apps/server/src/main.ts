import { serve } from "@hono/node-server";
import { openLedger, resolveDataDir } from "@selfhost/ledger";
import { redactionSettings } from "@selfhost/schema";
import pkg from "../package.json" with { type: "json" };
import { createApp } from "./app.js";
import { allTeams, createBackground, startScheduleJob } from "./background.js";
import { startCacheAlertJob } from "./cache-alerts.js";
import { findConsoleDir } from "./console.js";
import { loadExceptionKeys } from "./exception-keys.js";
import { gatewayFromEnv, startGatewayJob } from "./gateway.js";
import { errorLine, githubAppFromEnv, githubConfig, pullSync, resyncPulls } from "./github.js";
import { linkPullSessions } from "./github-prs.js";
import { appCodeowners } from "./github-review.js";
import { notifyFromEnv, startNotifyJob } from "./notify.js";
import { clonesUnder } from "./provenance.js";
import { serverConfig, startRetentionJob } from "./retention.js";
import {
  clonesCodeowners,
  type ReviewRefreshJob,
  refreshOnStored,
  startReviewRefreshJob,
} from "./review.js";
import { startTraceExportJob } from "./runs.js";
import { serverRuntime } from "./runtime.js";
import { signinFromEnv } from "./signin.js";
import { loadApiToken, tokenNotice } from "./token.js";
import { startVendorImportJob, vendorImportersFromEnv } from "./vendor-usage.js";

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
if (created) console.log(tokenNotice(path));

// The Ed25519 keys one-time exception grants are signed with: made on the first start, kept
// next to the token (or in SELFHOST_EXCEPTION_KEYS_FILE), never sent anywhere.
const exceptionKeys = loadExceptionKeys(dataDir);
if (exceptionKeys.created) {
  const where = exceptionKeys.path
    ? `saved to ${exceptionKeys.path}`
    : "not saved, the data dir is in memory";
  console.log(`exception signing key made (${where})`);
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
// Vendor usage importers, one per admin key set (SELFHOST_ANTHROPIC_ADMIN_KEY and the rest).
const vendorImporters = vendorImportersFromEnv();

// Background runs, on the runtime [runtime] picks with the team's own key from this server's
// environment; a team with no runtime or key gets a 503. SELFHOST_BACKGROUND=off turns them off.
const background =
  process.env.SELFHOST_BACKGROUND === "off"
    ? undefined
    : createBackground(ledger, {
        config,
        runtime: serverRuntime(ledger, {
          env: process.env,
          config,
          log: (line) => console.log(line),
        }),
        version: pkg.version,
        ...(github.app ? { github: github.app } : {}),
        ...(gateway ? { gateway } : {}),
        ...(deliver ? { deliver } : {}),
        ...(publicUrl ? { publicUrl } : {}),
      });
// Runs a previous process left going are marked failed and their sandboxes stopped. Installs
// where several servers share one database set SELFHOST_BACKGROUND_RECOVER=off on all but one.
if (background && process.env.SELFHOST_BACKGROUND_RECOVER !== "off") {
  const recovered = await background.runner.recover();
  if (recovered.length > 0)
    console.log(`background runs: ${recovered.length} left from the last start marked failed`);
}

// One pull request sync for webhook deliveries and for escalations the review list makes, so
// the two take turns on a pull request instead of racing.
const pulls = github.app
  ? pullSync(github.app, ledger, {
      ...github,
      ...(clones ? { clones } : {}),
      ...(background ? { background } : {}),
    })
  : undefined;

// Set once the jobs below start: an agent that starts to wait wakes the review refresh, and a
// refresh that raises a budget alert wakes the notify pass. Any refresh that files an item, on
// any path (the job, an agent's ask_human through MCP), wakes the notify pass itself (see
// startNotifyJob), so its push goes out in seconds instead of at the next periodic pass.
const wakeups: {
  reviews?: ReviewRefreshJob;
  notify?: () => void;
  resync?: (urls: string[]) => Promise<void>;
} = {};
// A sync with a block, an ask or an exception request returns once its items are on the list.
const refreshStored = refreshOnStored(() => wakeups.reviews);
// A session that reaches the server after the GitHub App recorded its pull request links to it
// now: its review item gets the run, and the pull request's brief is written again with it.
const eventsStored = async (kinds: readonly string[], events: readonly unknown[]) => {
  await refreshStored(kinds, events);
  void linkPullSessions(ledger, events)
    .then(async (urls) => {
      if (urls.length === 0) return;
      console.log(`github: linked ${urls.length} pull requests to their sessions`);
      wakeups.reviews?.wake();
      await wakeups.resync?.(urls);
    })
    .catch((error) =>
      console.log(`github: linking pull requests to sessions: ${errorLine(error)}`),
    );
};

const server = serve(
  {
    fetch: createApp({
      version: pkg.version,
      ledger,
      token,
      config,
      exceptionKeys,
      github: { ...github, ...(pulls ? { pulls } : {}) },
      ...(web ? { console: web } : {}),
      ...(signin ? { signin } : {}),
      ...(clones ? { clones } : {}),
      ...(gateway ? { gateway } : {}),
      ...(deliver ? { notify: { deliver } } : {}),
      ...(background ? { background } : {}),
      eventsStored,
      vendorImporters,
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
    if (vendorImporters.length > 0) {
      console.log(`vendor usage: importing from ${vendorImporters.map((i) => i.id).join(", ")}`);
    }
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

const resync =
  github.app && pulls
    ? resyncPulls(github.app, ledger, pulls, {
        ...(githubTeam ? { team: githubTeam } : {}),
        server: publicUrl ?? `http://${hostname}:${port}`,
      })
    : undefined;

// SELFHOST_REVIEW_REFRESH=off stops building review items from new events and timing out
// approvals, for installs where another server does it against the same database.
const reviews =
  process.env.SELFHOST_REVIEW_REFRESH === "off"
    ? undefined
    : startReviewRefreshJob(ledger, {
        config,
        gateway: gateway !== undefined,
        changed: () => wakeups.notify?.(),
        // CODEOWNERS from the clones, else through the GitHub App, as its pull request sync reads it.
        ...(clones
          ? { codeowners: clonesCodeowners(clones) }
          : github.app
            ? { codeowners: appCodeowners(github.app) }
            : {}),
        // An escalated pull request's new review request goes to GitHub now.
        ...(resync ? { escalated: (urls: string[]) => void resync(urls) } : {}),
      });

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

// SELFHOST_VENDOR_IMPORT=off stops reading usage from the vendor admin APIs, for installs where
// another server reads it into the same database.
const vendorImports =
  vendorImporters.length > 0 && process.env.SELFHOST_VENDOR_IMPORT !== "off"
    ? startVendorImportJob(ledger, vendorImporters)
    : undefined;

// SELFHOST_NOTIFY=off stops sending notifications, for installs where another server sends
// them from the same database.
const notifications =
  deliver && process.env.SELFHOST_NOTIFY !== "off"
    ? startNotifyJob(ledger, { deliver, config, ...(publicUrl ? { publicUrl } : {}) })
    : undefined;
if (reviews) wakeups.reviews = reviews;
if (resync) wakeups.resync = resync;
if (notifications) wakeups.notify = notifications.wake;

// SELFHOST_CACHE_ALERTS=off stops raising prompt cache alerts for sessions whose hit rate
// collapsed, for installs where another server raises them from the same database.
// SELFHOST_SCHEDULES=off stops starting [background] schedules, for installs where another
// server starts them from the same database.
const schedules =
  background && process.env.SELFHOST_SCHEDULES !== "off"
    ? startScheduleJob(ledger, background, allTeams(ledger))
    : undefined;

const cacheAlerts =
  process.env.SELFHOST_CACHE_ALERTS === "off" ? undefined : startCacheAlertJob(ledger, { config });

// On shutdown, GitHub calls in flight get this long to finish; then they are aborted, so a call
// GitHub never answers cannot hold the delivery that made it, and with it the shutdown.
const GITHUB_SHUTDOWN_GRACE_MS = 5_000;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (github.app) {
      const app = github.app;
      setTimeout(() => app.close(), GITHUB_SHUTDOWN_GRACE_MS).unref();
    }
    retention?.stop();
    schedules?.stop();
    cacheAlerts?.stop();
    notifications?.stop();
    gatewayJob?.stop();
    vendorImports?.stop();
    reviews?.stop();
    traces?.stop();
    server.close(() => {
      ledger.close().finally(() => process.exit(0));
    });
  });
}
