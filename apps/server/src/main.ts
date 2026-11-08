import { serve } from "@hono/node-server";
import { openLedger, resolveDataDir } from "@selfhost/ledger";
import { redactionSettings } from "@selfhost/schema";
import pkg from "../package.json" with { type: "json" };
import { createApp } from "./app.js";
import { findConsoleDir } from "./console.js";
import { githubAppFromEnv, githubConfig } from "./github.js";
import { serverConfig, startRetentionJob } from "./retention.js";
import { startReviewRefreshJob } from "./review.js";
import { signinFromEnv } from "./signin.js";
import { loadApiToken } from "./token.js";

const port = Number(process.env.PORT ?? 4400);
const hostname = process.env.HOST ?? "127.0.0.1";
const dataDir = resolveDataDir();
const config = serverConfig();

const ledger = await openLedger({
  url: process.env.DATABASE_URL,
  dataDir,
  redaction: redactionSettings(config),
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    retention?.stop();
    reviews?.stop();
    server.close(() => {
      ledger.close().finally(() => process.exit(0));
    });
  });
}
