import { hashToken } from "@selfhost/ledger";
import type {
  ContextFile,
  ContextProposal,
  ContextProposalRequest,
  ContextResponse,
  CreateInviteRequest,
  CreateInviteResponse,
  CreateTeamResponse,
  DecisionRequest,
  DecisionResponse,
  GatewayKeysResponse,
  GatewayStatus,
  IngestEventsResponse,
  IntegrationKind,
  IntegrationsResponse,
  Invite,
  IssueGatewayKeyRequest,
  IssueGatewayKeyResponse,
  JoinResponse,
  LedgerEvent,
  MeResponse,
  OrgContextResponse,
  Person,
  PersonRole,
  PolicyResponse,
  ReviewItem,
  ReviewItemQuery,
  ReviewItemsPage,
  RevokeTokensResponse,
  RoiQuery,
  RoiResponse,
  SetIntegrationRequest,
  TeamLaptopsResponse,
  TeamPeopleResponse,
  TeamRepo,
  TeamReposResponse,
} from "@selfhost/schema";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 30_000;

/** An error answer from the team server, or a failed request (status 0). */
export class TeamApiError extends Error {
  override name = "TeamApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds from a Retry-After header. */
    readonly retryAfter?: number,
    /** The answer's JSON body, when it had one. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** The server url as given, checked and without a trailing slash. */
export function serverUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Expected a server url like https://selfhost.example.com, got "${value}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Expected an http or https server url, got "${value}"`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Expected a server url with no credentials, query or fragment, got "${value}"`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Calls the selfhost team server, and only it: every request goes to `server` plus an API path.
 * Model traffic never goes through here: agents talk to their vendors, or to the AI gateway.
 */
export class TeamClient {
  constructor(
    readonly server: string,
    private readonly token: string | undefined,
    private readonly fetch: Fetch,
  ) {}

  createTeam(name: string, inviteTtlSeconds?: number): Promise<CreateTeamResponse> {
    const ttl = inviteTtlSeconds === undefined ? {} : { invite_ttl_seconds: inviteTtlSeconds };
    return this.call("POST", "/v1/teams", { name, ...ttl });
  }

  createInvite(team: string, request: CreateInviteRequest): Promise<CreateInviteResponse> {
    return this.call("POST", `/v1/teams/${encodeURIComponent(team)}/invites`, request);
  }

  /** The invite goes by the sha256 of its code, so the code never appears in a URL. */
  revokeInvite(invite: string): Promise<Invite> {
    return this.call("DELETE", `/v1/invites/${hashToken(invite)}`);
  }

  revokePerson(team: string, person: string): Promise<RevokeTokensResponse> {
    const path = `/v1/teams/${encodeURIComponent(team)}/people/${encodeURIComponent(person)}/tokens`;
    return this.call("DELETE", path);
  }

  /** Revokes the person token this client holds. */
  revokeOwnToken(): Promise<RevokeTokensResponse> {
    return this.call("DELETE", "/v1/me/token");
  }

  me(): Promise<MeResponse> {
    return this.call("GET", "/v1/me");
  }

  people(team: string): Promise<TeamPeopleResponse> {
    return this.call("GET", `/v1/teams/${encodeURIComponent(team)}/people`);
  }

  /** Changes a person's role; only the team's owners can. */
  setRole(team: string, person: string, role: PersonRole): Promise<Person> {
    const path = `/v1/teams/${encodeURIComponent(team)}/people/${encodeURIComponent(person)}/role`;
    return this.call("PUT", path, { role });
  }

  /** Adds someone already in another team of the org. */
  addPerson(team: string, person: string, role?: PersonRole): Promise<Person> {
    return this.call("POST", `/v1/teams/${encodeURIComponent(team)}/people`, {
      person,
      ...(role ? { role } : {}),
    });
  }

  /** Each laptop of the team with its config version and last heartbeat. */
  laptops(team: string, silentDays?: number): Promise<TeamLaptopsResponse> {
    const query = silentDays === undefined ? "" : `?silent_days=${silentDays}`;
    return this.call("GET", `/v1/teams/${encodeURIComponent(team)}/laptops${query}`);
  }

  repos(team: string): Promise<TeamReposResponse> {
    return this.call("GET", `/v1/teams/${encodeURIComponent(team)}/repos`);
  }

  addRepo(team: string, remote: string): Promise<TeamRepo> {
    return this.call("POST", `/v1/teams/${encodeURIComponent(team)}/repos`, { remote });
  }

  /** `repo` is owner/name. */
  removeRepo(team: string, repo: string): Promise<TeamReposResponse> {
    const [owner = "", name = ""] = repo.split("/");
    const path = `/v1/teams/${encodeURIComponent(team)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    return this.call("DELETE", path);
  }

  join(invite: string, person: string, name?: string): Promise<JoinResponse> {
    return this.call("POST", "/v1/join", { invite, person, ...(name ? { name } : {}) });
  }

  /** The team's policy, or undefined when the team has none yet. Default: the token's team. */
  async policy(team?: string): Promise<PolicyResponse | undefined> {
    const query = team === undefined ? "" : `?team=${encodeURIComponent(team)}`;
    try {
      return await this.call<PolicyResponse>("GET", `/v1/policy${query}`);
    } catch (error) {
      if (error instanceof TeamApiError && error.code === "no_policy") return undefined;
      throw error;
    }
  }

  /** Replaces the team's selfhost.toml; only the team's owners and admins can. */
  setPolicy(text: string, team: string): Promise<PolicyResponse> {
    return this.call("PUT", `/v1/policy?team=${encodeURIComponent(team)}`, { text });
  }

  /** The org and team context layers of a team: the token's own team by default. */
  context(team?: string): Promise<ContextResponse> {
    return this.call("GET", `/v1/context${team ? `?team=${encodeURIComponent(team)}` : ""}`);
  }

  /** Replaces a team's context layer; only its owners and admins can. */
  setContext(team: string, files: ContextFile[]): Promise<ContextResponse> {
    return this.call("PUT", `/v1/context?team=${encodeURIComponent(team)}`, { files });
  }

  /** Replaces an org's context layer; only the admin token can. */
  setOrgContext(org: string, files: ContextFile[]): Promise<OrgContextResponse> {
    return this.call("PUT", `/v1/orgs/${encodeURIComponent(org)}/context`, { files });
  }

  /** Proposes one of the person's own items to the team; an owner or admin approves it. */
  proposeContext(request: ContextProposalRequest): Promise<ContextProposal> {
    return this.call("POST", "/v1/context/proposals", request);
  }

  /** The team's router, tracer, runtime and reviewer, each checked by the server. */
  integrations(): Promise<IntegrationsResponse> {
    return this.call("GET", "/v1/integrations");
  }

  /** Picks the tool for one job; only the team's owners and admins can. */
  setIntegration(
    kind: IntegrationKind,
    request: SetIntegrationRequest,
  ): Promise<IntegrationsResponse> {
    return this.call("PUT", `/v1/integrations/${kind}`, request);
  }

  /** One POST /v1/events, at most 1000 events. RemoteWriter adds batching and retries. */
  pushEvents(events: LedgerEvent[]): Promise<IngestEventsResponse> {
    return this.call("POST", "/v1/events", { events });
  }

  /** One page of review items. */
  reviewItems(query: ReviewItemQuery): Promise<ReviewItemsPage> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const search = params.toString();
    return this.call("GET", `/v1/review-items${search ? `?${search}` : ""}`);
  }

  /** One review item, or undefined when the server has none with this id (or not for this team). */
  async reviewItem(id: string): Promise<ReviewItem | undefined> {
    try {
      return await this.call<ReviewItem>("GET", `/v1/review-items/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof TeamApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Answers a review item; 409 when it is no longer open. */
  decideReviewItem(id: string, request: DecisionRequest): Promise<DecisionResponse> {
    return this.call("POST", `/v1/review-items/${encodeURIComponent(id)}/decision`, request);
  }

  /** Hides an open review item until `until`; 409 when it is no longer open. */
  async snoozeReviewItem(id: string, until: string): Promise<ReviewItem> {
    const path = `/v1/review-items/${encodeURIComponent(id)}/snooze`;
    return (await this.call<{ item: ReviewItem }>("POST", path, { until })).item;
  }

  /** Cost per merged pull request of a team in a range, with its baseline. */
  roi(team: string, query: RoiQuery): Promise<RoiResponse> {
    const search = new URLSearchParams(query as Record<string, string>).toString();
    return this.call(
      "GET",
      `/v1/teams/${encodeURIComponent(team)}/roi${search ? `?${search}` : ""}`,
    );
  }

  /** The AI gateway: health, the team's limits and the caller's own key, never its value. */
  gateway(team?: string): Promise<GatewayStatus> {
    return this.call("GET", `/v1/gateway${team ? `?team=${encodeURIComponent(team)}` : ""}`);
  }

  gatewayKeys(team?: string): Promise<GatewayKeysResponse> {
    return this.call("GET", `/v1/gateway/keys${team ? `?team=${encodeURIComponent(team)}` : ""}`);
  }

  /** Issues a gateway key; the answer is the only place its value ever appears. */
  issueGatewayKey(request: IssueGatewayKeyRequest): Promise<IssueGatewayKeyResponse> {
    return this.call("POST", "/v1/gateway/keys", request);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetch(`${this.server}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new TeamApiError(0, "unreachable", `Could not reach ${this.server}: ${reason}`);
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const error = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
      const retryAfter = Number(response.headers.get("retry-after"));
      const message = error?.message ?? (text.slice(0, 200) || "no message");
      throw new TeamApiError(
        response.status,
        error?.code ?? "http_error",
        // The server's permission errors name the role needed and the caller's own.
        response.status === 403
          ? `Permission denied: ${message} (${this.server} answered 403)`
          : `${this.server} answered ${response.status}: ${message}`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        json,
      );
    }
    if (json === undefined) {
      throw new TeamApiError(response.status, "bad_response", `${this.server} did not answer JSON`);
    }
    return json as T;
  }
}
