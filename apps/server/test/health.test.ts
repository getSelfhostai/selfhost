import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./helpers.js";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.ledger.close();
});

describe("GET /v1/health", () => {
  it("returns ok and the version without a token", async () => {
    const res = await server.app.request("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "1.2.3" });
  });
});

describe("unknown routes", () => {
  it("return a JSON 404", async () => {
    const res = await server.request("/v1/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "No route for GET /v1/nope" },
    });
  });
});

describe("bearer auth", () => {
  it.each([
    ["no header", {}],
    ["a wrong token", { authorization: "Bearer nope" }],
    ["another scheme", { authorization: "Basic dGVzdC10b2tlbg==" }],
    ["an empty bearer", { authorization: "Bearer " }],
  ])("rejects %s with 401", async (_, headers) => {
    for (const path of ["/v1/events", "/v1/nope"]) {
      const res = await server.app.request(path, { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="selfhost"');
      expect(await res.json()).toEqual({
        error: { code: "unauthorized", message: "Missing or invalid bearer token" },
      });
    }
  });

  it("accepts the token with any casing of the scheme", async () => {
    const res = await server.app.request("/v1/events", {
      headers: { authorization: "bearer test-token" },
    });
    expect(res.status).toBe(200);
  });
});
