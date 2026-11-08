import type { MeResponse } from "@selfhost/schema";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, vi } from "vitest";
import { Console } from "../src/components/console";
import { parseView, type View } from "../src/lib/view";

/** The clock every screen test runs at. */
export const NOW = new Date("2026-11-08T12:00:00.000Z");

export const OWNER: MeResponse = {
  kind: "person",
  person: {
    id: "ada@example.com",
    name: "Ada",
    team: "web",
    role: "owner",
    created_at: "2026-10-01T00:00:00.000Z",
  },
  team: { id: "web", name: "Web", org: "default", created_at: "2026-10-01T00:00:00.000Z" },
  role: "owner",
  allowed: [
    "read",
    "work",
    "policy.write",
    "settings.write",
    "invites",
    "people",
    "roles",
    "org.overview",
  ],
  memberships: [{ team: "web", role: "owner" }],
};

export const MEMBER: MeResponse = {
  kind: "person",
  person: {
    id: "mia@example.com",
    team: "web",
    role: "member",
    created_at: "2026-10-01T00:00:00.000Z",
  },
  team: { id: "web", name: "Web", org: "default", created_at: "2026-10-01T00:00:00.000Z" },
  role: "member",
  allowed: ["read", "work"],
  memberships: [{ team: "web", role: "member" }],
};

export const ADMIN: MeResponse = {
  kind: "admin",
  allowed: [
    "read",
    "work",
    "policy.write",
    "settings.write",
    "invites",
    "people",
    "roles",
    "org.overview",
  ],
};

type Answer = unknown | ((request: { url: URL; body: unknown }) => unknown);

export interface Call {
  method: string;
  path: string;
  url: URL;
  body: unknown;
}

/**
 * A fake server: "GET /v1/policy" answers every query of that path, a function gets the request,
 * and a { status } object answers with that status and an ApiError body. Unknown routes are 404.
 */
export function mockServer(routes: Record<string, Answer>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://console.test");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, url, body });
    const route = routes[`${method} ${url.pathname}`];
    if (route === undefined) return reply(404, error("not_found", `No route for ${method}`));
    const answer = typeof route === "function" ? route({ url, body }) : route;
    if (answer && typeof answer === "object" && "status" in answer && "message" in answer) {
      const { status, message } = answer as { status: number; message: string };
      return reply(status, error("refused", message));
    }
    return reply(200, answer);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch };
}

const error = (code: string, message: string) => ({ error: { code, message } });

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Renders the console on one view, with navigation kept in memory. */
export function renderConsole(me: MeResponse, search: string) {
  let view: View = parseView(search);
  const go = vi.fn((next: View) => {
    view = next;
    result.rerender(<Console me={me} view={view} onChange={go} now={NOW} />);
  });
  const result = render(<Console me={me} view={view} onChange={go} now={NOW} />);
  return { ...result, go, view: () => view };
}

beforeAll(() => {
  // What Radix menus call that jsdom leaves out.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
