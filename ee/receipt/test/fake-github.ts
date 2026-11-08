import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A small GitHub REST API (and GitHub Actions OIDC endpoint, and selfhost receipts endpoint)
 * over HTTP, for running the action as a separate process. It serves one pull request's files,
 * deployments, commit statuses and comments, and records every request.
 */
export interface FakeComment {
  id: number;
  body: string;
  html_url: string;
  user: { login: string; type: string };
}

export interface FakeState {
  files: { filename: string; status: string; previous_filename?: string }[];
  deployments: {
    id: number;
    environment: string;
    created_at: string;
    creator: { login: string };
    statuses: { state: string; environment_url?: string }[];
  }[];
  statuses: { context: string; state: string; target_url?: string }[];
  comments: FakeComment[];
  /** What POST /v1/receipts answers; undefined answers 404. */
  receipts?: { status: number; body: unknown };
  /** Receipts posted to /v1/receipts, with the bearer they carried. */
  posted: { authorization?: string; body: unknown }[];
}

export interface FakeGitHubServer {
  url: string;
  state: FakeState;
  requests: { method: string; path: string }[];
  close(): Promise<void>;
}

export const OIDC_TOKEN = "fake-oidc-token";
export const OIDC_REQUEST_TOKEN = "fake-request-token";

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

export async function startFakeGitHub(
  repo: string,
  pull: number,
  sha: string,
  state: Partial<FakeState> = {},
): Promise<FakeGitHubServer> {
  const full: FakeState = {
    files: [],
    deployments: [],
    statuses: [],
    comments: [],
    posted: [],
    ...state,
  };
  const requests: { method: string; path: string }[] = [];
  let nextId = 100;
  let base = "";
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    requests.push({ method, path: url.pathname });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const path = url.pathname;
    if (path === "/oidc") {
      if (req.headers.authorization !== `bearer ${OIDC_REQUEST_TOKEN}`) {
        return send(401, { message: "bad request token" });
      }
      return send(200, { value: `${OIDC_TOKEN}:${url.searchParams.get("audience")}` });
    }
    if (path === "/v1/receipts" && method === "POST") {
      full.posted.push({
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        body: await readBody(req),
      });
      if (!full.receipts) return send(404, { error: { code: "not_found", message: "No route" } });
      return send(full.receipts.status, full.receipts.body);
    }
    const prefix = `/repos/${repo}`;
    if (!path.startsWith(prefix)) return send(404, { message: "Not Found" });
    const rest = path.slice(prefix.length);
    if (rest === `/pulls/${pull}/files`) {
      const page = Number(url.searchParams.get("page") ?? "1");
      return send(200, page === 1 ? full.files : []);
    }
    if (rest === "/deployments" && url.searchParams.get("sha") === sha) {
      return send(
        200,
        full.deployments.map(({ statuses: _statuses, ...deployment }) => deployment),
      );
    }
    const statuses = /^\/deployments\/(\d+)\/statuses$/.exec(rest);
    if (statuses) {
      const found = full.deployments.find((d) => d.id === Number(statuses[1]));
      return send(200, found?.statuses ?? []);
    }
    if (rest === `/commits/${sha}/status`) return send(200, { statuses: full.statuses });
    if (rest === `/issues/${pull}/comments` && method === "GET") return send(200, full.comments);
    if (rest === `/issues/${pull}/comments` && method === "POST") {
      const body = (await readBody(req)) as { body: string };
      const id = nextId++;
      const comment: FakeComment = {
        id,
        body: body.body,
        html_url: `https://github.com/${repo}/pull/${pull}#issuecomment-${id}`,
        user: { login: "github-actions[bot]", type: "Bot" },
      };
      full.comments.push(comment);
      return send(201, comment);
    }
    const edit = /^\/issues\/comments\/(\d+)$/.exec(rest);
    if (edit && method === "PATCH") {
      const comment = full.comments.find((c) => c.id === Number(edit[1]));
      if (!comment) return send(404, { message: "Not Found" });
      comment.body = ((await readBody(req)) as { body: string }).body;
      return send(200, comment);
    }
    return send(404, { message: "Not Found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    state: full,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
