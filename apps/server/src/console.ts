import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";

/**
 * The web console (apps/console) is static files the server serves at /, so a laptop and a
 * team server need no other web server. It reads the same /v1 API as every other client, with
 * the caller's own token or the identity a sign-in proxy forwards (see signin.ts); the files
 * themselves hold no data and need no token.
 */

/**
 * Where the built console is: SELFHOST_CONSOLE_DIR, else console/ beside the bundle (the server
 * image and the CLI copy it there when they build), else apps/console/dist in a checkout.
 */
export function findConsoleDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [
    env.SELFHOST_CONSOLE_DIR?.trim() || undefined,
    fileURLToPath(new URL("./console/", import.meta.url)),
    fileURLToPath(new URL("../../console/dist/", import.meta.url)),
  ];
  return candidates.find((dir) => dir !== undefined && existsSync(join(dir, "index.html")));
}

// Recharts and the chart theme set inline styles; scripts come only from the console's files.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const NOT_BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>selfhost</title></head>
<body style="font: 16px/1.5 system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem">
<h1>selfhost</h1>
<p>This server runs, but the web console is not built into it. Build it with
<code>pnpm --filter @selfhost/console build</code>, or set SELFHOST_CONSOLE_DIR to its dist folder.
The API answers at <code>/v1</code>.</p>
</body></html>
`;

function secure(c: Context) {
  c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
}

/**
 * GET / and every path outside /v1 serve the console: files under assets/ for a year (their
 * names change with their content), anything else the page itself, never cached. The console
 * is one page at / whose views are in the query string, so /runs/<id> (a run link of older
 * versions) redirects to its run view there; served as is, the page's relative asset paths would
 * resolve under /runs/ and come back as the page itself.
 */
export function consoleRoutes(app: Hono, dir: string | undefined): void {
  const isConsolePath = (path: string) => path !== "/v1" && !path.startsWith("/v1/");
  if (!dir) {
    app.get("*", async (c, next) => {
      if (!isConsolePath(c.req.path)) return next();
      secure(c);
      return c.html(NOT_BUILT, 200);
    });
    return;
  }
  // Run links before the console moved its views into the query string: /runs/<id>.
  app.get("/runs/:run_id{[^/]+}", (c) =>
    c.redirect(`../?screen=run&run=${encodeURIComponent(c.req.param("run_id"))}`, 302),
  );
  const assets = serveStatic({ root: dir });
  const page = serveStatic({ root: dir, path: "index.html" });
  app.get("*", async (c, next) => {
    if (!isConsolePath(c.req.path)) return next();
    secure(c);
    if (c.req.path.startsWith("/assets/")) {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      const found = await assets(c, async () => {});
      if (found) return found;
      c.header("Cache-Control", "no-store");
      return c.text("Not found", 404);
    }
    c.header("Cache-Control", "no-cache");
    const found = await page(c, async () => {});
    return found ?? c.html(NOT_BUILT, 200);
  });
}
