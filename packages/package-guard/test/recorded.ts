import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fetch } from "../src/index.js";

/** Registry responses recorded by scripts/capture-fixtures.ts. */
export const RECORDED = join(import.meta.dirname, "..", "..", "..", "fixtures", "registries");

/** The time the responses were recorded; tests measure package ages from it. */
export const RECORDED_AT = new Date("2026-11-08T06:23:00Z");

/**
 * Every command the capture script runs, so every lookup the tests make has a recorded
 * response. Not found names are plausible inventions that no registry had when recorded.
 */
export const CAPTURED_COMMANDS = [
  "npm install left-pad bcrypt shell-quote @types/shell-quote@1.7.5",
  "npm i react-hooks-form-validator-pro",
  "npm i flatmap-stream@0.1.1",
  "npm i left-pad@^1.1.0 left-pad@latest lp@npm:left-pad@1.3.0 left-pad@9.9.9",
  "npx -y cowsay hello",
  "pip install requests==2.32.3 docopt flask-sqlalchemy-async-session-pro",
  "uv add requests",
  "cargo add cfg-if itoa@1.0 tokio-retry-backoff-utils",
  "cargo install ripgrep --version 14.1.0",
  "go get github.com/google/uuid@v1.6.0 golang.org/x/sync@latest",
  "go install github.com/pkg/errors/subpkg@v0.9.1",
  "go get github.com/gin-gonic/gin-jwt-middleware",
];

/** Where a request's recorded response lives: by host and path, like the GitHub fixtures. */
export function fixturePath(method: string, url: string, body?: string): string {
  const { host, pathname } = new URL(url);
  let path = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (method === "POST" && host === "api.osv.dev") {
    const query = (
      JSON.parse(body ?? "{}") as {
        queries: { package: { name: string; ecosystem: string }; version?: string }[];
      }
    ).queries[0];
    path = `${path}/${query?.package.ecosystem}/${query?.package.name}/${query?.version ?? "all"}`;
  }
  const safe = path
    .split("/")
    .map((part) => part.replace(/[^A-Za-z0-9@._+!~-]/g, "_"))
    .join("/");
  return `${host}/${safe}${method === "HEAD" ? ".head" : ""}.json`;
}

export interface RecordedResponse {
  status: number;
  /** JSON as parsed; any other body as text. Absent for HEAD. */
  body?: unknown;
}

export interface Replay {
  fetch: Fetch;
  /** Requests made, as "METHOD url". */
  calls: string[];
  /** Requests with no recorded response. A test that sees one fails: nothing goes live. */
  missing: string[];
}

/**
 * A fetch that answers from the recorded responses and never touches the network. `overrides`
 * replace single responses ("GET https://..." to a response) to stage what the registries
 * would rarely show on cue, like a package deps.dev does not list yet or a server error.
 */
export function replay(overrides: Record<string, RecordedResponse> = {}): Replay {
  const calls: string[] = [];
  const missing: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const call = `${init.method} ${url}`;
    calls.push(call);
    if (init.signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    let recorded = overrides[call];
    if (!recorded) {
      try {
        recorded = JSON.parse(
          readFileSync(join(RECORDED, fixturePath(init.method, url, init.body)), "utf8"),
        ) as RecordedResponse;
      } catch {
        missing.push(call);
        throw new Error(`No recorded response for ${call}`);
      }
    }
    const { status, body } = recorded;
    return {
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")),
    };
  };
  return { fetch, calls, missing };
}
