import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiError } from "@selfhost/schema";
import type { MiddlewareHandler } from "hono";

const PUBLIC_PATHS = new Set(["/v1/health"]);

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Requires `Authorization: Bearer <token>` on every route except the public ones. */
export function requireBearerToken(token: string): MiddlewareHandler {
  const expected = digest(token);
  return async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(c.req.header("authorization") ?? "");
    if (!match?.[1] || !timingSafeEqual(digest(match[1]), expected)) {
      c.header("WWW-Authenticate", 'Bearer realm="selfhost"');
      return c.json(
        {
          error: { code: "unauthorized", message: "Missing or invalid bearer token" },
        } satisfies ApiError,
        401,
      );
    }
    await next();
  };
}
