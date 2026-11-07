import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { vi } from "vitest";

/**
 * Makes every outbound connection throw and returns the list of attempts. Undo with
 * vi.restoreAllMocks() and vi.unstubAllGlobals().
 */
export function blockNetwork(): string[] {
  const attempts: string[] = [];
  const block =
    (name: string) =>
    (..._args: unknown[]): never => {
      attempts.push(name);
      throw new Error(`network access attempted: ${name}`);
    };
  vi.spyOn(net, "connect").mockImplementation(block("net.connect"));
  vi.spyOn(net, "createConnection").mockImplementation(block("net.createConnection"));
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(block("net.Socket.connect"));
  vi.spyOn(tls, "connect").mockImplementation(block("tls.connect"));
  vi.spyOn(http, "request").mockImplementation(block("http.request"));
  vi.spyOn(https, "request").mockImplementation(block("https.request"));
  vi.spyOn(dns, "lookup").mockImplementation(block("dns.lookup"));
  vi.stubGlobal("fetch", vi.fn(block("fetch")));
  return attempts;
}
