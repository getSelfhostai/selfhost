import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PACKAGE_ROOT, read } from "./contracts.js";

const doc = parse(read(PACKAGE_ROOT, "openapi.yaml"));

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const child of node) collectRefs(child, out);
  else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

function resolvePointer(root: unknown, pointer: string): unknown {
  return pointer
    .split("/")
    .slice(1)
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], root);
}

describe("openapi.yaml", () => {
  it("is OpenAPI 3.1 with bearer auth", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it("covers the v1 endpoints", () => {
    const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.keys(item as object).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(operations.sort()).toEqual(
      [
        "DELETE /v1/invites/{id}",
        "DELETE /v1/me/token",
        "DELETE /v1/notify/targets/{name}",
        "DELETE /v1/teams/{team}/people/{person}/tokens",
        "DELETE /v1/teams/{team}/repos/{owner}/{name}",
        "GET /v1/budget",
        "GET /v1/context",
        "GET /v1/decisions",
        "GET /v1/events",
        "GET /v1/events/tail",
        "GET /v1/gateway",
        "GET /v1/gateway/keys",
        "GET /v1/health",
        "GET /v1/integrations",
        "GET /v1/me",
        "GET /v1/notify",
        "GET /v1/notify/sends",
        "GET /v1/orgs/{org}/context",
        "GET /v1/orgs/{org}/overview",
        "GET /v1/orgs/{org}/policy",
        "GET /v1/policy",
        "GET /v1/policy/coverage",
        "GET /v1/policy/observed",
        "GET /v1/review-items",
        "GET /v1/review-items/{id}",
        "GET /v1/runs/{run_id}",
        "GET /v1/teams/{team}/overview",
        "GET /v1/teams/{team}/invites",
        "GET /v1/teams/{team}/laptops",
        "GET /v1/teams/{team}/people",
        "GET /v1/teams/{team}/provenance",
        "GET /v1/teams/{team}/provenance/modules",
        "GET /v1/teams/{team}/repos",
        "GET /v1/teams/{team}/roi",
        "GET /v1/usage",
        "GET /v1/usage.csv",
        "PATCH /v1/teams/{team}",
        "POST /v1/context/proposals",
        "POST /v1/decisions",
        "POST /v1/events",
        "POST /v1/gateway/keys",
        "POST /v1/gateway/sync",
        "POST /v1/join",
        "POST /v1/notify/targets",
        "POST /v1/notify/test",
        "POST /v1/orgs",
        "POST /v1/review-items/{id}/decision",
        "POST /v1/review-items/{id}/snooze",
        "POST /v1/teams",
        "POST /v1/teams/{team}/invites",
        "POST /v1/teams/{team}/people",
        "POST /v1/teams/{team}/repos",
        "PUT /v1/context",
        "PUT /v1/integrations/{kind}",
        "PUT /v1/notify/digest",
        "PUT /v1/orgs/{org}/context",
        "PUT /v1/orgs/{org}/policy",
        "PUT /v1/policy",
        "PUT /v1/teams/{team}/people/{person}/role",
      ].sort(),
    );
  });

  it("leaves only the health check and joining unauthenticated", () => {
    const open = ["/v1/health", "/v1/join"];
    expect(doc.paths["/v1/health"].get.security).toEqual([]);
    expect(doc.paths["/v1/join"].post.security).toEqual([]);
    for (const [path, item] of Object.entries<Record<string, { security?: unknown }>>(doc.paths)) {
      if (open.includes(path)) continue;
      for (const operation of Object.values(item)) expect(operation.security).toBeUndefined();
    }
  });

  it("limits ingest to 1000 events per batch", () => {
    expect(doc.components.schemas.IngestEventsRequest.properties.events.maxItems).toBe(1000);
  });

  it("resolves every $ref", () => {
    const refs = collectRefs(doc);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      if (ref.startsWith("#/")) {
        expect(resolvePointer(doc, ref.slice(1)), ref).toBeDefined();
      } else {
        expect(existsSync(join(PACKAGE_ROOT, ref)), ref).toBe(true);
      }
    }
  });
});
