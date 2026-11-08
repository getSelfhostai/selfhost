import { createPublicKey, type KeyObject, verify } from "node:crypto";

/**
 * An in-memory GitHub REST API for tests, served through a fetch function handed to Octokit, so
 * nothing reaches the network. It keeps the state of each pull request (labels, check runs,
 * review requests, reviews, comments, files, commits) and records every request, so a test can
 * check exactly what was read and written. Only the routes the GitHub delivery uses are served;
 * any other request answers 404 and is recorded under `unknown`.
 */

export interface FakeRequest {
  method: string;
  /** Path without the query, such as /repos/acme/acme-api/issues/101/labels. */
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

export interface FakeUser {
  login: string;
  type: "User" | "Bot";
}

export interface FakeComment {
  id: number;
  body: string;
  user: FakeUser;
  html_url?: string;
}

export interface FakeCheckRun {
  id: number;
  name: string;
  head_sha: string;
  external_id: string | null;
  status: string;
  conclusion: string | null;
  output: { title: string | null; summary: string | null; text: string | null };
}

export interface FakeFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface FakeCommit {
  sha: string;
  commit: { message: string; author: { name?: string; email?: string; date?: string } | null };
}

export interface FakePull {
  author: string;
  /** What GET /repos/{owner}/{repo}/pulls/{number} answers with. */
  title?: string;
  body?: string;
  state?: "open" | "closed";
  draft?: boolean;
  head?: { sha: string; ref: string };
  base?: { sha: string; ref: string };
  labels: string[];
  requestedUsers: string[];
  requestedTeams: string[];
  reviews: { login: string; state: string }[];
  comments: FakeComment[];
  files: FakeFile[];
  commits: FakeCommit[];
}

export interface FakeGitHubOptions {
  /** When set, installation token requests must carry a JWT for this App signed by `publicKey`. */
  appId?: string;
  publicKey?: string | KeyObject;
  /** The login comments are made under. Default `selfhost[bot]`. */
  botLogin?: string;
  /** Logins a review can be requested from. Default: anyone but the author. */
  collaborators?: string[];
  /** The App's installation id on a repository (owner/name), or undefined. Default: 1 on all. */
  installationOf?: (repo: string) => number | undefined;
}

/** The token the fake hands out for installations; not shaped like a real one. */
export const FAKE_INSTALLATION_TOKEN = "fake-installation-token";

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const notFound = (message = "Not Found") => json(404, { message });

const base64url = (text: string) => Buffer.from(text, "base64url");

export class FakeGitHub {
  readonly requests: FakeRequest[] = [];
  readonly checkRuns: FakeCheckRun[] = [];
  /** Requests no route served. */
  readonly unknown: FakeRequest[] = [];
  /** Raw file bodies by `owner/repo@ref:path`. */
  readonly contents = new Map<string, string>();
  private readonly pulls = new Map<string, FakePull>();
  private readonly failures: { method: string; path: RegExp; status: number }[] = [];
  private readonly publicKey?: KeyObject;
  private nextId = 1000;

  constructor(private readonly options: FakeGitHubOptions = {}) {
    if (options.publicKey) {
      this.publicKey =
        typeof options.publicKey === "string"
          ? createPublicKey(options.publicKey)
          : options.publicKey;
    }
  }

  addPull(repo: string, number: number, pull: Partial<FakePull> & { author: string }): FakePull {
    const state: FakePull = {
      labels: [],
      requestedUsers: [],
      requestedTeams: [],
      reviews: [],
      comments: [],
      files: [],
      commits: [],
      ...pull,
    };
    this.pulls.set(`${repo}#${number}`, state);
    return state;
  }

  pull(repo: string, number: number): FakePull {
    const state = this.pulls.get(`${repo}#${number}`);
    if (!state) throw new Error(`No fake pull request ${repo}#${number}`);
    return state;
  }

  /** The next request matching method and path answers `status` instead. */
  failNext(method: string, path: RegExp, status: number): void {
    this.failures.push({ method, path, status });
  }

  /** Requests that change something: every one but GET, leaving out installation tokens. */
  get writes(): FakeRequest[] {
    return this.requests.filter(
      (request) => request.method !== "GET" && !request.path.startsWith("/app/"),
    );
  }

  /** How many installation tokens were handed out. */
  get tokensIssued(): number {
    return this.requests.filter((request) => request.path.startsWith("/app/installations/")).length;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : undefined;
    const request: FakeRequest = {
      method,
      path: decodeURIComponent(url.pathname),
      query: Object.fromEntries(url.searchParams),
      ...(text ? { body: JSON.parse(text) as unknown } : {}),
    };
    this.requests.push(request);
    const failure = this.failures.findIndex(
      (f) => f.method === method && f.path.test(request.path),
    );
    let response: Response | undefined;
    if (failure >= 0) {
      const status = this.failures.splice(failure, 1)[0]?.status ?? 500;
      response = json(status, { message: `Fake failure ${status}` });
    } else {
      response = this.route(request, headers);
    }
    if (!response) {
      this.unknown.push(request);
      response = notFound();
    }
    // A real fetch response knows its URL; Octokit's pagination reads it.
    Object.defineProperty(response, "url", { value: url.toString() });
    return response;
  };

  private route(request: FakeRequest, headers: Headers): Response | undefined {
    const { method, path } = request;
    let match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (match && method === "POST") return this.accessToken(headers);
    match = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path);
    if (match && method === "GET") {
      const refused = this.checkAppJwt(headers);
      if (refused) return refused;
      const id = (this.options.installationOf ?? (() => 1))(`${match[1]}/${match[2]}`);
      return id === undefined ? notFound() : json(200, { id, app_id: Number(this.options.appId) });
    }

    if (headers.get("authorization") !== `token ${FAKE_INSTALLATION_TOKEN}`) {
      return json(401, { message: "Bad credentials" });
    }

    match = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(path);
    if (match && method === "GET") {
      const [, owner, repo, number] = match as unknown as string[];
      const pull = this.pulls.get(`${owner}/${repo}#${number}`);
      return pull
        ? json(200, this.pullObject(owner as string, repo as string, Number(number), pull))
        : notFound();
    }
    match = /^\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)\/(.+)$/.exec(path);
    if (match) {
      const [, owner, repo, , number, rest] = match as unknown as string[];
      const pull = this.pulls.get(`${owner}/${repo}#${number}`);
      if (!pull) return notFound();
      return this.pullRoute(pull, method, rest as string, request.body);
    }
    match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)$/.exec(path);
    if (match && method === "PATCH") return this.updateComment(Number(match[3]), request.body);

    match = /^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/check-runs$/.exec(path);
    if (match && method === "GET") {
      const name = request.query.check_name;
      const runs = this.checkRuns.filter(
        (run) => run.head_sha === match?.[1] && (name === undefined || run.name === name),
      );
      return json(200, { total_count: runs.length, check_runs: runs });
    }
    if (/^\/repos\/[^/]+\/[^/]+\/check-runs$/.test(path) && method === "POST") {
      return this.createCheck(request.body as Record<string, unknown>);
    }
    match = /^\/repos\/[^/]+\/[^/]+\/check-runs\/(\d+)$/.exec(path);
    if (match && method === "PATCH") {
      return this.updateCheck(Number(match[1]), request.body as Record<string, unknown>);
    }
    match = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(path);
    if (match && method === "GET") {
      const body = this.contents.get(`${match[1]}/${match[2]}@${request.query.ref}:${match[3]}`);
      if (body === undefined) return notFound();
      return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
    }
    return undefined;
  }

  /** 401 unless the request carries a JWT for the App signed with its key, when one is set. */
  private checkAppJwt(headers: Headers): Response | undefined {
    if (this.publicKey) {
      const jwt = /^bearer (.+)$/i.exec(headers.get("authorization") ?? "")?.[1] ?? "";
      const [header = "", payload = "", signature = ""] = jwt.split(".");
      const signed = verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        this.publicKey,
        base64url(signature),
      );
      const claims = signed
        ? (JSON.parse(base64url(payload).toString("utf8")) as { iss?: unknown })
        : {};
      if (!signed || String(claims.iss) !== String(this.options.appId)) {
        return json(401, { message: "A JSON web token could not be decoded" });
      }
    }
    return undefined;
  }

  private accessToken(headers: Headers): Response {
    const refused = this.checkAppJwt(headers);
    if (refused) return refused;
    return json(201, {
      token: FAKE_INSTALLATION_TOKEN,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { checks: "write", issues: "write", pull_requests: "write" },
      repository_selection: "all",
    });
  }

  private pullRoute(pull: FakePull, method: string, rest: string, body: unknown): Response {
    const bot: FakeUser = { login: this.options.botLogin ?? "selfhost[bot]", type: "Bot" };
    const labels = () => pull.labels.map((name) => ({ name }));
    if (rest === "labels" && method === "GET") return json(200, labels());
    if (rest === "labels" && method === "POST") {
      for (const name of (body as { labels: string[] }).labels) {
        if (!pull.labels.some((l) => l.toLowerCase() === name.toLowerCase()))
          pull.labels.push(name);
      }
      return json(200, labels());
    }
    if (rest.startsWith("labels/") && method === "DELETE") {
      const name = rest.slice("labels/".length).toLowerCase();
      const index = pull.labels.findIndex((l) => l.toLowerCase() === name);
      if (index < 0) return notFound("Label does not exist");
      pull.labels.splice(index, 1);
      return json(200, labels());
    }
    if (rest === "requested_reviewers" && method === "GET") {
      return json(200, {
        users: pull.requestedUsers.map((login) => ({ login, type: "User" })),
        teams: pull.requestedTeams.map((slug) => ({ slug, name: slug })),
      });
    }
    if (rest === "requested_reviewers" && method === "POST") {
      const { reviewers = [], team_reviewers = [] } = body as {
        reviewers?: string[];
        team_reviewers?: string[];
      };
      if (reviewers.some((login) => login.toLowerCase() === pull.author.toLowerCase())) {
        return json(422, { message: "Review cannot be requested from pull request author." });
      }
      const allowed = this.options.collaborators?.map((login) => login.toLowerCase());
      if (allowed && reviewers.some((login) => !allowed.includes(login.toLowerCase()))) {
        return json(422, {
          message:
            "Reviews may only be requested from collaborators. One or more of the users or teams you specified is not a collaborator.",
        });
      }
      pull.requestedUsers.push(...reviewers);
      pull.requestedTeams.push(...team_reviewers);
      return json(201, { number: 0 });
    }
    if (rest === "reviews" && method === "GET") {
      return json(
        200,
        pull.reviews.map((review, index) => ({
          id: index + 1,
          user: { login: review.login, type: "User" },
          state: review.state,
        })),
      );
    }
    if (rest === "comments" && method === "GET") return json(200, pull.comments);
    if (rest === "comments" && method === "POST") {
      const id = this.nextId++;
      const comment = {
        id,
        body: (body as { body: string }).body,
        user: bot,
        html_url: `https://github.com/${this.where(pull)}#issuecomment-${id}`,
      };
      pull.comments.push(comment);
      return json(201, comment);
    }
    if (rest === "files" && method === "GET") return json(200, pull.files);
    if (rest === "commits" && method === "GET") return json(200, pull.commits);
    return notFound();
  }

  private where(pull: FakePull): string {
    for (const [key, value] of this.pulls) {
      if (value === pull) return key.replace("#", "/pull/");
    }
    return "unknown";
  }

  private pullObject(owner: string, repo: string, number: number, pull: FakePull) {
    return {
      number,
      html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
      title: pull.title ?? `Pull request ${number}`,
      body: pull.body ?? null,
      state: pull.state ?? "open",
      draft: pull.draft ?? false,
      user: { login: pull.author, type: pull.author.endsWith("[bot]") ? "Bot" : "User" },
      head: pull.head ?? { sha: "0".repeat(40), ref: "main" },
      base: pull.base ?? { sha: "1".repeat(40), ref: "main" },
    };
  }

  private updateComment(id: number, body: unknown): Response {
    for (const pull of this.pulls.values()) {
      const comment = pull.comments.find((c) => c.id === id);
      if (!comment) continue;
      comment.body = (body as { body: string }).body;
      return json(200, comment);
    }
    return notFound();
  }

  private createCheck(body: Record<string, unknown>): Response {
    const output = (body.output ?? {}) as Partial<FakeCheckRun["output"]>;
    const run: FakeCheckRun = {
      id: this.nextId++,
      name: String(body.name),
      head_sha: String(body.head_sha),
      external_id: typeof body.external_id === "string" ? body.external_id : null,
      status: typeof body.status === "string" ? body.status : "queued",
      conclusion: typeof body.conclusion === "string" ? body.conclusion : null,
      output: {
        title: output.title ?? null,
        summary: output.summary ?? null,
        text: output.text ?? null,
      },
    };
    this.checkRuns.push(run);
    return json(201, run);
  }

  private updateCheck(id: number, body: Record<string, unknown>): Response {
    const run = this.checkRuns.find((r) => r.id === id);
    if (!run) return notFound();
    if (typeof body.status === "string") run.status = body.status;
    if (typeof body.conclusion === "string") run.conclusion = body.conclusion;
    if (body.output) {
      const output = body.output as Partial<FakeCheckRun["output"]>;
      run.output = {
        title: output.title ?? run.output.title,
        summary: output.summary ?? run.output.summary,
        text: output.text ?? null,
      };
    }
    return json(200, run);
  }
}
