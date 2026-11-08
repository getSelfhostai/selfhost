import type { ValidationResult } from "@selfhost/schema";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { apiError } from "./access.js";

export const SMALL_BODY_BYTES = 64 * 1024;

export const limit = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) =>
      c.json(apiError("payload_too_large", `Request body over ${maxSize} bytes`), 413),
  });

export async function readBody<T>(
  c: Context,
  validator: { validate(value: unknown): ValidationResult<T> },
): Promise<T | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(apiError("invalid_request", "Expected a JSON body"), 400);
  }
  const result = validator.validate(body);
  if (result.ok) return result.value;
  const [first] = result.errors;
  return c.json(apiError("invalid_request", `${first?.field}: ${first?.message}`), 400);
}

export function invalidQuery(c: Context, errors: { field: string; message: string }[]) {
  const [first] = errors;
  return c.json(apiError("invalid_query", `${first?.field}: ${first?.message}`), 400);
}

/** Lets errors in a nested app reach the outer app's error handler, so every 500 looks the same. */
export function rethrow(error: Error): never {
  throw error;
}
