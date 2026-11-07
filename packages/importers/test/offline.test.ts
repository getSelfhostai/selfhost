import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importAll, watchLogs } from "../src/index.js";
import { ALL_TIME, CLAUDE_DIR, CODEX_DIR, MemoryWriter, waitFor } from "./helpers.js";

const attempts: string[] = [];

function block(name: string) {
  return (..._args: unknown[]): never => {
    attempts.push(name);
    throw new Error(`network access attempted: ${name}`);
  };
}

function stubNetwork() {
  attempts.length = 0;
  vi.spyOn(net, "connect").mockImplementation(block("net.connect"));
  vi.spyOn(net, "createConnection").mockImplementation(block("net.createConnection"));
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(block("net.Socket.connect"));
  vi.spyOn(tls, "connect").mockImplementation(block("tls.connect"));
  vi.spyOn(http, "request").mockImplementation(block("http.request"));
  vi.spyOn(https, "request").mockImplementation(block("https.request"));
  vi.spyOn(dns, "lookup").mockImplementation(block("dns.lookup"));
  vi.stubGlobal("fetch", vi.fn(block("fetch")));
}

describe("solo mode makes no network requests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("the stubs catch an outbound connection", async () => {
    stubNetwork();
    expect(() => net.connect(443, "example.com")).toThrow(/network access/);
    await expect(async () => fetch("https://example.com")).rejects.toThrow(/network access/);
    expect(attempts).toEqual(["net.connect", "fetch"]);
  });

  it("during a full import and a watch", async () => {
    stubNetwork();
    const writer = new MemoryWriter();
    const opts = { claudeDir: CLAUDE_DIR, codexDir: CODEX_DIR, since: ALL_TIME, logPrompts: true };
    const result = await importAll(writer, opts);
    expect(result.accepted).toBeGreaterThan(0);
    const batches: number[] = [];
    const watcher = watchLogs(writer, { ...opts, pollIntervalMs: 10 }, (n) => batches.push(n));
    await waitFor(() => batches.length > 0);
    await watcher.close();
    expect(attempts).toEqual([]);
  });
});
