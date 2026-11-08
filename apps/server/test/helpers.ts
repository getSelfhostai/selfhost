import { randomBytes } from "node:crypto";
import { type Ledger, openLedger } from "@selfhost/ledger";
import type { Hono } from "hono";
import postgres from "postgres";
import { createApp } from "../src/app.js";
import type { GitHubRouteOptions } from "../src/github.js";

export const TOKEN = "test-token";

export interface TestServer {
  app: Hono;
  ledger: Ledger;
  /** Sends a request with the bearer token unless headers override it. */
  request(path: string, init?: RequestInit): Promise<Response>;
}

export async function startTestServer(github?: GitHubRouteOptions): Promise<TestServer> {
  const ledger = await openLedger({ dataDir: "memory://" });
  const app = createApp({ version: "1.2.3", ledger, token: TOKEN, ...(github ? { github } : {}) });
  return {
    app,
    ledger,
    request: (path, init = {}) =>
      Promise.resolve(
        app.request(path, {
          ...init,
          headers: {
            authorization: `Bearer ${TOKEN}`,
            ...(init.headers as Record<string, string>),
          },
        }),
      ),
  };
}

const DATABASE_URL = process.env.DATABASE_URL;

export interface ServerBackend {
  name: string;
  skip: boolean;
  open(): Promise<{ ledger: Ledger; close(): Promise<void> }>;
}

/** PGlite in memory always; real Postgres when DATABASE_URL is set, in a schema of its own. */
export const BACKENDS: ServerBackend[] = [
  {
    name: "pglite",
    skip: false,
    async open() {
      const ledger = await openLedger({ dataDir: "memory://" });
      return { ledger, close: () => ledger.close() };
    },
  },
  {
    name: "postgres",
    skip: !DATABASE_URL,
    async open() {
      const schema = `selfhost_test_${randomBytes(6).toString("hex")}`;
      const admin = postgres(DATABASE_URL ?? "", { onnotice: () => {} });
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      const scoped = new URL(DATABASE_URL ?? "");
      scoped.searchParams.set("search_path", schema);
      const ledger = await openLedger({ url: scoped.toString() });
      return {
        ledger,
        async close() {
          await ledger.close();
          await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
          await admin.end();
        },
      };
    },
  },
];

/** Calls an app with a bearer token, sending a JSON body when there is one. */
export function caller(app: Hono, token: string) {
  return (path: string, method = "GET", body?: unknown) =>
    Promise.resolve(
      app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
}
