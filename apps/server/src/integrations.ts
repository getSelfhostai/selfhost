import type { GitHubApp, Octokit } from "@selfhost/github";
import {
  type CheckContext,
  checkIntegrations,
  type Env,
  type Fetch,
  IntegrationEditError,
  type IntegrationStates,
  type RepoView,
  setIntegrationTable,
  type WorkflowFile,
} from "@selfhost/integrations";
import type { Ledger } from "@selfhost/ledger";
import {
  checkLayer,
  createValidator,
  INTEGRATION_KINDS,
  INTEGRATION_TOOLS,
  INTEGRATIONS_SCHEMA,
  type IntegrationKind,
  IntegrationsQuerySchema,
  type IntegrationsResponse,
  SetIntegrationRequestSchema,
} from "@selfhost/schema";
import type { Context } from "hono";
import { apiError, authorize, type Caller, type Router } from "./access.js";
import { invalidQuery, limit, readBody, SMALL_BODY_BYTES } from "./http.js";
import { invalidPolicy } from "./policy.js";

export interface IntegrationRouteOptions {
  /** Where the checks read the variables [integrations] names. Default: process.env. */
  env?: Env;
  /** HTTP for the checks. Default: the global fetch. */
  fetch?: Fetch;
  /** The team's repositories for reviewer checks; undefined when they cannot be read. */
  repos?: (team: string) => Promise<RepoView | undefined>;
  /** Clock for checked_at and the cache. Default: the system clock. */
  now?: () => Date;
}

/** How long a team's check results are served again while its [integrations] stay the same. */
export const CHECK_CACHE_MS = 60_000;

const integrationsQuery = createValidator(IntegrationsQuerySchema);
const setIntegrationBody = createValidator(SetIntegrationRequestSchema);

/** A team policy written by this route when the team has none yet starts from this. */
const EMPTY_POLICY = "version = 1\n";

const isKind = (value: string): value is IntegrationKind =>
  (INTEGRATION_KINDS as readonly string[]).includes(value);

/**
 * GET /v1/integrations and PUT /v1/integrations/{kind}, for both kinds of token. Everyone in the
 * team reads; owners and admins (policy.write) pick a tool, which writes [integrations.<kind>]
 * into the team's own selfhost.toml. The checks only test that each tool answers and takes its
 * key; wiring the tools in is up to the gateway sync and trace export.
 */
export function integrationRoutes(
  router: Router,
  ledger: Ledger,
  options: IntegrationRouteOptions = {},
): void {
  const { teams, orgs } = ledger;
  const fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  const teamOf = (c: Context, caller: Caller, team: string | undefined) => {
    if (team !== undefined) return team;
    if (caller.kind === "person") return caller.person.team;
    return c.json(apiError("invalid_query", "team: Required with the admin token"), 400);
  };

  const clock = () => options.now?.() ?? new Date();
  /**
   * One entry per team, keyed by the team and its composed [integrations], so a change to the
   * team's or the org's choice is checked at once. Concurrent reads share one round of checks.
   */
  const cache = new Map<string, { team: string; at: number; states: Promise<IntegrationStates> }>();

  async function respond(team: string, fresh = false): Promise<IntegrationsResponse> {
    const integrations = (await orgs.effectivePolicy(team))?.config.integrations;
    const key = `${team}\n${JSON.stringify(integrations ?? {})}`;
    const now = clock().getTime();
    for (const [at, entry] of cache) {
      if (now - entry.at >= CHECK_CACHE_MS || (fresh && entry.team === team)) cache.delete(at);
    }
    let entry = cache.get(key);
    if (!entry) {
      for (const [at, other] of cache) if (other.team === team) cache.delete(at);
      const context: CheckContext = {
        env: options.env ?? process.env,
        fetch,
        now: clock,
        ...(options.repos
          ? { repos: () => options.repos?.(team) ?? Promise.resolve(undefined) }
          : {}),
      };
      const states = checkIntegrations(integrations, context);
      entry = { team, at: now, states };
      cache.set(key, entry);
      states.catch(() => cache.delete(key));
    }
    return { schema: INTEGRATIONS_SCHEMA, team, integrations: await entry.states };
  }

  router.on("GET", "/v1/integrations", async (c, caller) => {
    const query = integrationsQuery.validate(c.req.query());
    if (!query.ok) return invalidQuery(c, query.errors);
    const team = teamOf(c, caller, query.value.team);
    if (team instanceof Response) return team;
    const refused = await authorize(c, caller, team, "read");
    if (refused) return refused;
    if (!(await teams.getTeam(team))) return c.json(apiError("not_found", `No team ${team}`), 404);
    return c.json(await respond(team));
  });

  router.on(
    "PUT",
    "/v1/integrations/:kind",
    async (c, caller) => {
      const kind = c.req.param("kind") ?? "";
      if (!isKind(kind)) {
        return c.json(
          apiError("invalid_request", `kind: Expected one of ${INTEGRATION_KINDS.join(", ")}`),
          400,
        );
      }
      const unexpected = Object.keys(c.req.query()).find((key) => key !== "team");
      if (unexpected) {
        return c.json(apiError("invalid_query", `${unexpected}: Unknown query parameter`), 400);
      }
      const team = teamOf(c, caller, c.req.query("team"));
      if (team instanceof Response) return team;
      const refused = await authorize(c, caller, team, "policy.write");
      if (refused) return refused;
      const body = await readBody(c, setIntegrationBody);
      if (body instanceof Response) return body;
      const info = await teams.getTeam(team);
      if (!info) return c.json(apiError("not_found", `No team ${team}`), 404);

      const field = `integrations.${kind}`;
      const tools = INTEGRATION_TOOLS[kind];
      if (body.tool !== null && !tools.includes(body.tool)) {
        const message = `Expected one of ${tools.join(", ")}, got "${body.tool}"`;
        return invalidPolicy(c, [{ field: `${field}.tool`, message }], false);
      }
      if (body.settings && "tool" in body.settings) {
        const message = "Set the tool in tool, not in settings";
        return invalidPolicy(c, [{ field: `${field}.tool`, message }], false);
      }
      const stored = await teams.getPolicy(team);
      const current = stored?.text ?? EMPTY_POLICY;
      let text: string;
      try {
        text = setIntegrationTable(
          current,
          kind,
          body.tool === null ? null : { tool: body.tool, ...body.settings },
        );
      } catch (error) {
        if (!(error instanceof IntegrationEditError)) throw error;
        return c.json(apiError("cannot_edit", error.message), 409);
      }
      if (text !== current) {
        const floor = await orgs.getOrgPolicy(info.org ?? "");
        const checked = checkLayer(floor?.text, text);
        if (!checked.ok) {
          return invalidPolicy(
            c,
            checked.errors,
            checked.errors.some((e) => e.org_rule),
          );
        }
        await teams.setPolicy(team, text);
      }
      // A PUT always checks again, also when it changed nothing, so a fix shows at once.
      return c.json(await respond(team, true));
    },
    limit(SMALL_BODY_BYTES),
  );
}

/** Workflow files read per repository at most. */
const MAX_WORKFLOWS = 30;

const statusOf = (error: unknown) => (error as { status?: number }).status;

/**
 * The team's repositories as the selfhost GitHub App sees them: workflow files through Contents
 * read, bots' comments through Issues read, and the org's GitHub Apps only when the App also has
 * Administration read (else that answer is undefined).
 */
export function githubRepos(app: GitHubApp, ledger: Pick<Ledger, "orgs">) {
  return async (team: string): Promise<RepoView> => {
    const repos = (await ledger.orgs.listRepos(team)).map((r) => r.repo);
    const clients = new Map<string, Promise<Octokit | undefined>>();
    const split = (repo: string) => {
      const [owner = "", name = ""] = repo.split("/");
      return { owner, repo: name };
    };
    const client = (repo: string) => {
      let found = clients.get(repo);
      if (!found) {
        const { owner, repo: name } = split(repo);
        found = app
          .repoInstallation(owner, name)
          .then((id) => (id === undefined ? undefined : app.installation(id)))
          .catch(() => undefined);
        clients.set(repo, found);
      }
      return found;
    };
    return {
      via: "the selfhost GitHub App",
      repos,
      setup:
        "Install the selfhost GitHub App on the team's repositories with Contents read, and add them with selfhost team repo add.",
      async workflows(repo) {
        const octokit = await client(repo);
        if (!octokit) return undefined;
        const where = split(repo);
        let listing: unknown;
        try {
          ({ data: listing } = await octokit.rest.repos.getContent({
            ...where,
            path: ".github/workflows",
          }));
        } catch (error) {
          return statusOf(error) === 404 ? [] : undefined;
        }
        if (!Array.isArray(listing)) return [];
        const files: WorkflowFile[] = [];
        for (const entry of listing.slice(0, MAX_WORKFLOWS)) {
          if (entry.type !== "file" || !/\.ya?ml$/.test(entry.name)) continue;
          try {
            const { data } = await octokit.rest.repos.getContent({
              ...where,
              path: entry.path,
              mediaType: { format: "raw" },
            });
            if (typeof data === "string") files.push({ path: entry.path, text: data });
          } catch {
            // An unreadable file is left out; the others still count.
          }
        }
        return files;
      },
      async appInstalled(repo, slug) {
        const octokit = await client(repo);
        if (!octokit) return undefined;
        try {
          const { data } = await octokit.rest.orgs.listAppInstallations({
            org: split(repo).owner,
            per_page: 100,
          });
          return data.installations.some((installation) => installation.app_slug === slug);
        } catch {
          return undefined;
        }
      },
      async recentBots(repo) {
        const octokit = await client(repo);
        if (!octokit) return undefined;
        try {
          const { data } = await octokit.rest.issues.listCommentsForRepo({
            ...split(repo),
            sort: "created",
            direction: "desc",
            per_page: 100,
          });
          return [
            ...new Set(
              data.flatMap((comment) => (comment.user?.type === "Bot" ? [comment.user.login] : [])),
            ),
          ];
        } catch {
          return undefined;
        }
      },
    };
  };
}
