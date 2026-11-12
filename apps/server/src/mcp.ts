import type { Ledger } from "@selfhost/ledger";
import {
  clientOf,
  createMcpServer,
  handleMcpHttp,
  ledgerData,
  type McpData,
  McpToolError,
} from "@selfhost/mcp";
import type { ApiError, ResolvedSelfhostConfig } from "@selfhost/schema";
import type { Context, Hono } from "hono";
import { limit, SMALL_BODY_BYTES } from "./http.js";
import type { PersonEnv } from "./teams.js";

export interface McpRouteOptions {
  version: string;
  /** selfhost.toml for review items built from events with no team policy. */
  config?: ResolvedSelfhostConfig;
  now?: () => Date;
}

const INTERNAL_ORIGIN = "http://selfhost.internal";

const withClient = (client: { name: string; version: string } | undefined) =>
  client ? { client } : {};

/** Every team of the org the person is in, their own first. */
async function teamsOf(c: Context<PersonEnv>): Promise<string[]> {
  const { person, caller } = c.env;
  const { memberships } = await caller.scope();
  return [person.team, ...memberships.map((m) => m.team).filter((team) => team !== person.team)];
}

const outOfReach = (repo: string) =>
  new McpToolError("forbidden", `Repo ${repo} is not in any team you are in.`);

/**
 * The agent MCP server over Streamable HTTP at POST /v1/mcp, for person tokens only: every tool
 * acts as the token's person, in the teams of their org they are in. The policy and the budget
 * come from the person routes themselves, so they answer exactly as GET /v1/policy and
 * /v1/budget do for this token; the rest reads and writes the ledger limited to those teams.
 */
export function mcpRoutes(person: Hono<PersonEnv>, ledger: Ledger, options: McpRouteOptions) {
  const now = options.now ?? (() => new Date());

  function dataFor(c: Context<PersonEnv>): McpData {
    const own = c.env.person;
    const teams = () => teamsOf(c);
    const authorization = c.req.header("authorization") ?? "";

    /** A GET on the person's own routes, with their token, as JSON or an McpToolError. */
    async function read<T>(path: string, query: Record<string, unknown>, repo?: string) {
      const url = new URL(path, INTERNAL_ORIGIN);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      const response = await person.request(url, { headers: { authorization } }, c.env);
      const body = (await response.json()) as T | ApiError;
      if (response.ok) return body as T;
      const { code, message } = (body as ApiError).error;
      if (response.status === 403) throw new McpToolError("forbidden", message);
      if (response.status === 404) {
        throw repo !== undefined ? outOfReach(repo) : new McpToolError("not_found", message);
      }
      if (response.status === 400) throw new McpToolError("invalid_request", message);
      throw new McpToolError("internal", `${code}: ${message}`);
    }

    return {
      ...ledgerData({
        use: (fn) => fn(ledger),
        person: own.id,
        teams,
        ...(options.config ? { config: options.config } : {}),
        now,
        source: "server",
        refreshOnRead: false,
      }),
      async policy(query) {
        let team = query.team;
        // "The policy for this repo": the team of the person's that owns it.
        if (query.repo !== undefined && team === undefined) {
          const { org } = await c.env.caller.scope();
          const owner = await ledger.orgs.repoOwner(org, query.repo.toLowerCase());
          if (!owner || !(await teams()).includes(owner.team)) throw outOfReach(query.repo);
          team = owner.team;
        }
        return read("/v1/policy", { ...query, team }, query.repo);
      },
      budget: (query) => read("/v1/budget", query),
      presence: (query) => read("/v1/presence", query),
    };
  }

  // POST carries every call; GET and DELETE get the transport's 405, as a stateless server.
  person.on(["POST", "GET", "DELETE"], "/v1/mcp", limit(SMALL_BODY_BYTES), (c) =>
    handleMcpHttp(c.req.raw, () =>
      createMcpServer(dataFor(c), {
        version: options.version,
        now,
        exposeErrors: false,
        ...withClient(clientOf(c.req.raw)),
      }),
    ),
  );
}

/** /v1/mcp with the admin token: the tools act as a person, so it needs a person token. */
export function adminMcpRoute(app: Hono): void {
  app.all("/v1/mcp", (c) =>
    c.json(
      {
        error: {
          code: "forbidden",
          message:
            "The MCP endpoint acts as one person: connect with a person token from selfhost join, not the admin token.",
        },
      } satisfies ApiError,
      403,
    ),
  );
}
