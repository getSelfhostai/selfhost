import { serve } from "@hono/node-server";
import pkg from "../package.json" with { type: "json" };
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 4400);
const hostname = process.env.HOST ?? "127.0.0.1";

const server = serve(
  { fetch: createApp({ version: pkg.version }).fetch, port, hostname },
  (info) => {
    console.log(`selfhost server ${pkg.version} listening on http://${hostname}:${info.port}`);
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
