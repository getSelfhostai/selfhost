import { serve } from "@hono/node-server";
import { openLedger, resolveDataDir } from "@selfhost/ledger";
import pkg from "../package.json" with { type: "json" };
import { createApp } from "./app.js";
import { loadApiToken } from "./token.js";

const port = Number(process.env.PORT ?? 4400);
const hostname = process.env.HOST ?? "127.0.0.1";
const dataDir = resolveDataDir();

const ledger = await openLedger({ url: process.env.DATABASE_URL, dataDir });
const { token, path, created } = loadApiToken(dataDir);
if (created) {
  const where = path ? `saved to ${path}` : "not saved, the data dir is in memory";
  console.log(`API token (${where}): ${token}`);
}

const server = serve(
  { fetch: createApp({ version: pkg.version, ledger, token }).fetch, port, hostname },
  (info) => {
    console.log(`selfhost server ${pkg.version} listening on http://${hostname}:${info.port}`);
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      ledger.close().finally(() => process.exit(0));
    });
  });
}
