import { execFile } from "node:child_process";
import type { NotifyDelivery } from "@selfhost/schema";
import { scrub } from "./mask.js";

/** One message: a title line and a plain-text body. */
export interface Message {
  title: string;
  body: string;
  /** Apprise's message type; it picks the icon or color some services show. */
  type: "info" | "warning" | "failure";
}

export type DeliveryResult = { ok: true } | { ok: false; error: string };

/**
 * Sends one message to one Apprise URL. Each target gets its own call, so one bad target does
 * not hide whether the others went. Errors never carry the URL.
 */
export interface Deliver {
  kind: Exclude<NotifyDelivery, "none">;
  send(url: string, message: Message): Promise<DeliveryResult>;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 30_000;

/** The Apprise API server's base URL, checked: http or https, no query or credentials. */
export function appriseApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `SELFHOST_APPRISE_URL: expected a URL like http://apprise:8000, got "${value}"`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SELFHOST_APPRISE_URL: expected an http or https URL");
  }
  if (url.search || url.hash) {
    throw new Error("SELFHOST_APPRISE_URL: expected a URL with no query or fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Delivery through an Apprise API server (caronc/apprise, compose.notify.yml, or one the team
 * already runs): one stateless POST /notify per target, with the URL in the JSON body so it
 * never shows in a request line or an access log.
 */
export function appriseApi(baseUrl: string, fetch: Fetch = globalThis.fetch): Deliver {
  const endpoint = `${appriseApiUrl(baseUrl)}/notify`;
  return {
    kind: "apprise_api",
    async send(url, message) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            urls: url,
            title: message.title,
            body: message.body,
            type: message.type,
            format: "text",
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, error: scrub(`Apprise did not answer: ${reason}`, [url]) };
      }
      if (response.ok) return { ok: true };
      const text = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim();
      const detail = text ? `: ${text.slice(0, 200)}` : "";
      return { ok: false, error: scrub(`Apprise answered ${response.status}${detail}`, [url]) };
    },
  };
}

/** Runs a program; tests pass their own. */
export type RunFile = (
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ code: number; output: string }>;

const runFile: RunFile = (file, args, env) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { env, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, output: `${stdout}${stderr}`.trim() });
      },
    );
  });

/**
 * Delivery through the apprise command on this machine, for a laptop with no server. The URL
 * goes in APPRISE_URLS, which the command reads when no URL is on its command line, so it never
 * shows in the process list.
 */
export function appriseCli(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  run: RunFile = runFile,
): Deliver {
  return {
    kind: "apprise_cli",
    async send(url, message) {
      const result = await run(path, ["-t", message.title, "-b", message.body], {
        ...env,
        APPRISE_URLS: url,
      });
      if (result.code === 0) return { ok: true };
      const last = result.output.split("\n").at(-1)?.trim();
      const detail = last ? `: ${last.slice(0, 200)}` : "";
      return { ok: false, error: scrub(`apprise exited with ${result.code}${detail}`, [url]) };
    },
  };
}

/** The one line a laptop prints when it has targets but no apprise command to send with. */
export const NO_APPRISE_NOTE =
  "Notifications skipped: the apprise command is not on PATH (install it with pipx install apprise).";
