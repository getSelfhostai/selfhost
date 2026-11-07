import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const app = createApp({ version: "1.2.3" });

describe("GET /v1/health", () => {
  it("returns ok and the version", async () => {
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "1.2.3" });
  });
});

describe("unknown routes", () => {
  it("return a JSON 404", async () => {
    const res = await app.request("/v1/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "No route for GET /v1/nope" },
    });
  });
});
