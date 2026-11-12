import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HOSTED_CLI_PARAMS, type JoinResponse } from "@selfhost/schema";
import { type Fetch, TeamApiError } from "./client.js";

/** How long `selfhost init --hosted` waits for the browser sign-in. */
export const SIGNIN_TIMEOUT_MS = 5 * 60_000;

export interface HostedSigninIo {
  fetch: Fetch;
  write: (line: string) => void;
  /** Opens the sign-in page. Default: the system browser. */
  openBrowser: (url: string) => void;
  timeoutMs?: number;
}

const DONE_PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>selfhost</title><body style="font:16px system-ui;max-width:28rem;margin:4rem auto">${message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")}</body>`;

/**
 * Signs in to a hosted server in the browser, with GitHub or Google, for `selfhost init
 * --hosted`. The browser comes back to a one-off address on this machine's loopback with a
 * code, which only this process can exchange for the person token: the server checks it against
 * a verifier that never left here. A new email gets an org and a team of its own.
 */
export async function hostedSignin(server: string, io: HostedSigninIo): Promise<JoinResponse> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(18).toString("base64url");
  let settle: (result: { code: string } | { error: string }) => void = () => {};
  const answered = new Promise<{ code: string } | { error: string }>((resolve) => {
    settle = resolve;
  });
  const listener = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      DONE_PAGE(
        error
          ? `Not signed in: ${error}`
          : "Signed in. You can close this tab and go back to the terminal.",
      ),
    );
    settle(error ? { error } : code ? { code } : { error: "The server sent no code" });
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as AddressInfo;
  const timer = setTimeout(
    () => settle({ error: "No sign-in within 5 minutes" }),
    io.timeoutMs ?? SIGNIN_TIMEOUT_MS,
  );
  try {
    const page = `${server}/v1/hosted/signin?${new URLSearchParams({
      [HOSTED_CLI_PARAMS.port]: String(port),
      [HOSTED_CLI_PARAMS.state]: state,
      [HOSTED_CLI_PARAMS.challenge]: challenge,
    })}`;
    io.write(`Sign in to ${server} in your browser. If it does not open, go to:`);
    io.write(`  ${page}`);
    io.openBrowser(page);
    const result = await answered;
    if ("error" in result) throw new Error(`Not signed in: ${result.error}`);
    const res = await io.fetch(`${server}/v1/hosted/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: result.code, verifier }),
    });
    const body = (await res.json().catch(() => ({}))) as JoinResponse & {
      error?: { code: string; message: string };
    };
    if (!res.ok) {
      throw new TeamApiError(
        res.status,
        body.error?.code ?? "error",
        body.error?.message ?? `${server} answered ${res.status}`,
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
    listener.close();
  }
}
