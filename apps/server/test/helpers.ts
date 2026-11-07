import { type Ledger, openLedger } from "@selfhost/ledger";
import type { Hono } from "hono";
import { createApp } from "../src/app.js";

export const TOKEN = "test-token";

export interface TestServer {
  app: Hono;
  ledger: Ledger;
  /** Sends a request with the bearer token unless headers override it. */
  request(path: string, init?: RequestInit): Promise<Response>;
}

export async function startTestServer(): Promise<TestServer> {
  const ledger = await openLedger({ dataDir: "memory://" });
  const app = createApp({ version: "1.2.3", ledger, token: TOKEN });
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
