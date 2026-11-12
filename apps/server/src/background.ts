import {
  type Clock,
  createRunner,
  dueSchedules,
  githubRunRequest,
  type PrepareCredentials,
  personForLogin,
  type RunGitHub,
  type Runner,
  type RuntimeFor,
  type SettingsFor,
  type StartResult,
  systemClock,
  triggeredEvent,
  verifyWebhook,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookStampProblem,
} from "@selfhost/background";
import {
  type CredentialDeps,
  credentialRevokedEvent,
  egressRefusal,
  PROVIDER_KEY_NAMES,
  prepareCredentials,
} from "@selfhost/credentials";
import { keySettings } from "@selfhost/gateway";
import type { GitHubApp } from "@selfhost/github";
import { databaseOf, type Ledger } from "@selfhost/ledger";
import { type Deliver, notifyStore } from "@selfhost/notify";
import {
  type BackgroundRun,
  BackgroundRunsQuerySchema,
  type BackgroundRunsResponse,
  backgroundSettings,
  type CredentialIssuedData,
  createValidator,
  DEFAULT_ORG_ID,
  FINAL_RUN_STATES,
  isFinalRunState,
  KILL_SCOPES,
  KillRequestSchema,
  type KillResponse,
  type KillScope,
  type LedgerEvent,
  type ResolvedSelfhostConfig,
  type RunCredentialKind,
  StartRunRequestSchema,
  WebhookRunRequestSchema,
} from "@selfhost/schema";
import { backgroundRunsUrl } from "@selfhost/traces";
import type { Context, Hono } from "hono";
import { apiError, authorize, type Caller, type Router } from "./access.js";
import type { Gateway } from "./gateway.js";
import { invalidQuery, limit, readBody, SMALL_BODY_BYTES } from "./http.js";

export const BACKGROUND_RUNS_PATH = "/v1/background-runs";
export const BACKGROUND_WEBHOOK_PATH = "/v1/background-runs/webhook";

const startBody = createValidator(StartRunRequestSchema);
const killBody = createValidator(KillRequestSchema);
const webhookBody = createValidator(WebhookRunRequestSchema);
const listQuery = createValidator(BackgroundRunsQuerySchema);

const ACTIVE = ["queued", "starting", "running", "testing", "pushing"] as const;

/**
 * The credentials seam over `@selfhost/credentials`: a GitHub App token for the run's one
 * repository, a per-run gateway key in place of any provider key, the team's declared secrets,
 * and the team's egress list plus github.com, api.github.com and the gateway host, each in the
 * runtime's own form. Its masker hides the run's values in what the run writes, and the runner
 * revokes everything with how the run ended (succeeded, failed, timed_out, killed).
 */
export function brokeredCredentials(deps: CredentialDeps): PrepareCredentials {
  return async (run, { runtime, config }) => {
    const prepared = await prepareCredentials(
      {
        id: run.id,
        team: run.team,
        repo: run.repo,
        target: runtime.kind,
        capabilities: runtime.capabilities,
      },
      config,
      deps,
    );
    const names = Object.keys(prepared.env);
    const kind: RunCredentialKind = deps.gateway
      ? "gateway_key"
      : names.some((name) => (PROVIDER_KEY_NAMES as readonly string[]).includes(name))
        ? "team_api_key"
        : "none";
    return {
      kind,
      secrets: prepared.secrets,
      ...(prepared.egress ? { egress: prepared.egress } : {}),
      spec: (base) => prepared.spec(base),
      mask: (text) => prepared.masker.text(text),
      gaps: prepared.gaps.map((gap) => gap.message),
      revoke: async (reason) => {
        await prepared.revoke(reason);
      },
    };
  };
}

export interface BackgroundServerOptions {
  /** The runtime seam: runtime selection over the adapters. Without it every start answers 503. */
  runtime?: RuntimeFor;
  /**
   * The credentials seam. Default: `brokeredCredentials` over `@selfhost/credentials`, with the
   * GitHub App, the gateway and `env` below.
   */
  credentials?: PrepareCredentials;
  /** The GitHub App, to open pull requests, post the gate's check and answer triggers. */
  github?: GitHubApp;
  gateway?: Gateway;
  /** Notifications for failed and stuck runs. */
  deliver?: Deliver;
  /** selfhost.toml for teams with no stored policy. */
  config: ResolvedSelfhostConfig;
  /** The selfhost CLI version sandboxes install. */
  version: string;
  /** Registry lookups for the gate's dependency check. Default: the global fetch. */
  fetch?: typeof fetch;
  clock?: Clock;
  /** Where webhook secrets are read: [background] webhook_secret_env names the variable. */
  env?: NodeJS.ProcessEnv;
  publicUrl?: string;
  log?: (line: string) => void;
}

/** What the routes, the GitHub delivery and the scheduler share. */
export interface Background {
  runner: Runner;
  settings: SettingsFor;
  github?: RunGitHub & { installationFor(repo: string): Promise<number | undefined> };
  env: NodeJS.ProcessEnv;
  clock: Clock;
  log: (line: string) => void;
}

/** RunGitHub over the GitHub App: each call acts as the App's installation on the repo. */
export function githubForRuns(app: GitHubApp): NonNullable<Background["github"]> {
  async function octokit(repo: string) {
    const [owner = "", name = ""] = repo.split("/");
    const id = await app.repoInstallation(owner, name);
    if (id === undefined) throw new Error(`The selfhost GitHub App is not installed on ${repo}`);
    return { client: app.installation(id), owner, name };
  }
  return {
    installationFor(repo) {
      const [owner = "", name = ""] = repo.split("/");
      return app.repoInstallation(owner, name);
    },
    async defaultBranch(repo) {
      const { client, owner, name } = await octokit(repo);
      return (await client.rest.repos.get({ owner, repo: name })).data.default_branch;
    },
    async openPull({ repo, head, base, title, body }) {
      const { client, owner, name } = await octokit(repo);
      const { data } = await client.rest.pulls.create({
        owner,
        repo: name,
        head,
        base,
        title,
        body,
      });
      return { number: data.number, url: data.html_url, headSha: data.head.sha };
    },
    async check({ repo, headSha, name: checkName, conclusion, title, summary, text }) {
      const { client, owner, name } = await octokit(repo);
      await client.rest.checks.create({
        owner,
        repo: name,
        name: checkName,
        head_sha: headSha,
        status: "completed",
        conclusion,
        output: { title, summary, ...(text ? { text } : {}) },
      });
    },
    async comment(repo, number, body) {
      const { client, owner, name } = await octokit(repo);
      await client.rest.issues.createComment({ owner, repo: name, issue_number: number, body });
    },
  };
}

/** The team's selfhost.toml in use, its text, org and people, for the runner. */
export function teamSettings(ledger: Ledger, defaults: ResolvedSelfhostConfig): SettingsFor {
  return async (team) => {
    const [policy, info, people] = await Promise.all([
      ledger.orgs.effectivePolicy(team).catch(() => undefined),
      ledger.teams.getTeam(team),
      ledger.teams.listPeople(team).catch(() => []),
    ]);
    return {
      config: policy?.config ?? defaults,
      ...(policy ? { policyText: policy.text } : {}),
      ...(info?.org ? { org: info.org } : {}),
      people: people.map((person) => person.id),
    };
  };
}

/**
 * Which repos a team's runs may work on, for every trigger (the API, signed webhooks, schedules
 * and GitHub comments): its own repos, and while its org has only this one team, a repo no team
 * has claimed. A repo of another team is refused, so a member cannot get a write token for it by
 * naming it; with several teams a repo must be claimed first (selfhost team repo add).
 */
export function repoAccess(
  ledger: Ledger,
): (team: string, repo: string, org: string | undefined) => Promise<string | undefined> {
  return async (team, repo, org) => {
    const inOrg = org ?? DEFAULT_ORG_ID;
    const owner = await ledger.orgs.repoOwner(inOrg, repo);
    if (owner) {
      return owner.team === team
        ? undefined
        : `${repo} belongs to team ${owner.team}, not ${team}: start the run from that team`;
    }
    const teams = await ledger.teams.listTeams(inOrg);
    if (teams.length <= 1) return undefined;
    return `${repo} is not claimed by a team of org ${inOrg}: claim it for team ${team} first (selfhost team repo add)`;
  };
}

/**
 * Revokes what a run left going by a stopped process still holds, from its credential events:
 * each credential issued to it with no credential.revoked yet. Its gateway key is turned off. A
 * GitHub App token's value lived only in the stopped process, and GitHub revokes one only with
 * the token itself, so its event records that it lives until the expiry GitHub gave it (at most
 * an hour). Read-only secrets have nothing to revoke.
 */
export function orphanedCredentials(
  ledger: Ledger,
  settings: SettingsFor,
  gateway: Gateway | undefined,
): (run: BackgroundRun) => Promise<void> {
  const db = databaseOf(ledger);
  return async (run) => {
    const rows = await db.query<{ body: unknown }>(
      `SELECT body FROM events
       WHERE kind IN ('credential.issued', 'credential.revoked') AND body ->> 'run_id' = $1
       ORDER BY ts, id`,
      [run.id],
    );
    const open = new Map<string, CredentialIssuedData>();
    for (const row of rows) {
      const event = (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as LedgerEvent;
      const data = event.data as CredentialIssuedData | undefined;
      if (!data?.name) continue;
      if (event.kind === "credential.issued") open.set(data.name, data);
      else open.delete(data.name);
    }
    const events: LedgerEvent[] = [];
    const at = new Date().toISOString();
    const where = { id: run.id, team: run.team, repo: run.repo };
    for (const data of open.values()) {
      const revoked = {
        credential: data.credential,
        name: data.name,
        source: data.source,
        reason: "aborted" as const,
        location: data.location,
      };
      if (data.credential === "gateway_key" && gateway) {
        let error: string | undefined;
        try {
          const { config } = await settings(run.team);
          const keys = (await gateway.client.keys()).filter(
            (key) => key.kind === "run" && key.run_id === run.id && key.active,
          );
          for (const key of keys) {
            await gateway.client.updateKey(key, { ...keySettings(key, config), active: false });
          }
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure);
        }
        events.push(
          credentialRevokedEvent(
            where,
            { ...revoked, ok: error === undefined, ...(error ? { error } : {}) },
            at,
          ),
        );
      } else if (data.credential === "github_app_token") {
        events.push(
          credentialRevokedEvent(
            where,
            {
              ...revoked,
              ok: false,
              error: `The server stopped while it held the token, and GitHub revokes a token only with its value; it expires at ${data.expires_at ?? "the hour GitHub gave it"}`,
            },
            at,
          ),
        );
      }
    }
    if (events.length > 0) await ledger.append(events);
  };
}

/** Model spend so far for a run: its cost.recorded events, from the gateway key or the hooks. */
export function runModelCost(ledger: Ledger): (runId: string) => Promise<number> {
  const db = databaseOf(ledger);
  return async (runId) => {
    const [row] = await db.query<{ usd: number | string | null }>(
      `SELECT COALESCE(SUM((body -> 'cost' ->> 'usd')::float8), 0) AS usd FROM events
       WHERE kind = 'cost.recorded' AND body ->> 'run_id' = $1`,
      [runId],
    );
    return Number(row?.usd ?? 0);
  };
}

/** The runner as the server drives it, with the ledger, the GitHub App, the gateway and notifications. */
export function createBackground(ledger: Ledger, options: BackgroundServerOptions): Background {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? ((line: string) => console.log(line));
  const settings = teamSettings(ledger, options.config);
  const github = options.github ? githubForRuns(options.github) : undefined;
  const gateway = options.gateway;
  const credentials =
    options.credentials ??
    brokeredCredentials({
      env: options.env ?? process.env,
      ...(options.github ? { github: options.github } : {}),
      ...(gateway ? { gateway: { client: gateway.client, baseUrl: gateway.baseUrl } } : {}),
      record: async (events) => {
        await ledger.append(events);
      },
      now: () => clock.now(),
    });
  const deliver = options.deliver;
  const runner = createRunner({
    store: ledger.backgroundRuns,
    events: { append: (events) => ledger.append(events) },
    runtime: options.runtime ?? (() => undefined),
    settings,
    credentials,
    ...(github ? { github } : {}),
    ...(deliver
      ? {
          alert: async (run, alert) => {
            if (!run.person) return;
            // The run's person in the run's org: the same id elsewhere is someone else.
            const store = notifyStore(databaseOf(ledger), run.org ?? DEFAULT_ORG_ID);
            const link = options.publicUrl ? `\n${backgroundRunsUrl(options.publicUrl)}` : "";
            for (const target of await store.targets(run.person)) {
              const sent = await deliver.send(target.url, {
                title: alert.title,
                body: `${alert.body}${link}`,
                type: "failure",
              });
              await store.record(run.person, {
                at: clock.now().toISOString(),
                target: target.name,
                kind: "item",
                subject: run.id,
                ok: sent.ok,
                ...(sent.ok ? {} : { error: sent.error }),
              });
            }
          },
        }
      : {}),
    modelCost: runModelCost(ledger),
    repoAccess: repoAccess(ledger),
    orphaned: orphanedCredentials(ledger, settings, gateway),
    admit: (run, runtime, config) =>
      egressRefusal(
        { team: run.team, target: runtime.kind, capabilities: runtime.capabilities },
        config,
      ),
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    clock,
    selfhostVersion: options.version,
    log,
  });
  return {
    runner,
    settings,
    ...(github ? { github } : {}),
    env: options.env ?? process.env,
    clock,
    log,
  };
}

function answer(c: Context, result: StartResult) {
  if ("refused" in result) return c.json(apiError(result.code, result.refused), result.status);
  return c.json(result.run, 202);
}

/** Who may use a kill switch: the team's owners and admins, and for an org the admin token or an owner in it. */
async function mayKill(c: Context, caller: Caller, scope: KillScope, target: string) {
  if (scope === "team") return authorize(c, caller, target, "settings.write");
  if (caller.kind === "admin") return undefined;
  const { org, memberships } = await caller.scope();
  if (org === target && memberships.some((m) => m.role === "owner")) return undefined;
  return c.json(
    apiError(
      "forbidden",
      `The org kill switch needs the admin token or an owner in org ${target}.`,
    ),
    403,
  );
}

/**
 * The background run routes both kinds of token reach:
 *
 * - POST /v1/background-runs starts a run as the calling person (role work in the team);
 * - GET /v1/background-runs lists runs of the caller's teams, newest first, with the kill
 *   switches in force; GET /v1/background-runs/{id} reads one, with its health and live cost;
 * - POST /v1/background-runs/{id}/cancel stops one (role work);
 * - POST /v1/background-runs/kill turns a team or org kill switch on, DELETE turns it off.
 */
export function backgroundRoutes(
  router: Router,
  ledger: Ledger,
  background: Background | undefined,
): void {
  const off = (c: Context) =>
    c.json(apiError("no_runtime", "Background runs are not set up on this server"), 503);

  router.on(
    "POST",
    BACKGROUND_RUNS_PATH,
    async (c, caller) => {
      if (!background) return off(c);
      const body = await readBody(c, startBody);
      if (body instanceof Response) return body;
      if (caller.kind === "admin") {
        return c.json(
          apiError(
            "forbidden",
            "Start runs with a person token, so the run works under that person's login. Schedules and signed webhooks run with the team's key.",
          ),
          403,
        );
      }
      const team = body.team ?? caller.person.team;
      const refused = await authorize(c, caller, team, "work");
      if (refused) return refused;
      const person = caller.person.id;
      return answer(
        c,
        await background.runner.start({
          team,
          repo: body.repo.toLowerCase(),
          task: body.task,
          ...(body.agent ? { agent: body.agent } : {}),
          ...(body.runtime ? { runtime: body.runtime } : {}),
          ...(body.base ? { base: body.base } : {}),
          ...(body.timeout_minutes ? { timeoutMinutes: body.timeout_minutes } : {}),
          person,
          trigger: { source: body.source ?? "api", sender: person, person },
        }),
      );
    },
    limit(SMALL_BODY_BYTES),
  );

  router.on("GET", BACKGROUND_RUNS_PATH, async (c, caller) => {
    const raw = c.req.query();
    const parsed = listQuery.validate({
      ...raw,
      ...(raw.limit !== undefined ? { limit: Number(raw.limit) } : {}),
    });
    if (!parsed.ok) return invalidQuery(c, parsed.errors);
    const query = parsed.value;
    let teams: string[] | undefined;
    if (query.team) {
      const refused = await authorize(c, caller, query.team, "read");
      if (refused) return refused;
      teams = [query.team];
    } else if (caller.kind === "person") {
      const { memberships } = await caller.scope();
      teams = [...new Set([caller.person.team, ...memberships.map((m) => m.team)])];
    }
    const states =
      query.state === "active"
        ? [...ACTIVE]
        : query.state === "final"
          ? [...FINAL_RUN_STATES]
          : query.state
            ? [query.state]
            : undefined;
    const runs = await ledger.backgroundRuns.list({
      ...(teams ? { teams } : {}),
      ...(states ? { states } : {}),
      limit: query.limit ?? 50,
    });
    const orgs =
      caller.kind === "person"
        ? [(await caller.scope()).org]
        : [...new Set(runs.map((r) => r.org).filter((o): o is string => !!o))];
    const kills = await ledger.backgroundRuns.activeKills({
      teams: teams ?? [...new Set(runs.map((r) => r.team))],
      orgs,
    });
    return c.json({
      runs,
      kills: kills.map(({ scope, target, by, at }) => ({ scope, target, by, at })),
    } satisfies BackgroundRunsResponse);
  });

  router.on("GET", `${BACKGROUND_RUNS_PATH}/:id`, async (c, caller) => {
    const run = await ledger.backgroundRuns.get(c.req.param("id") ?? "");
    if (!run) {
      return caller.kind === "admin"
        ? c.json(apiError("not_found", "No such run"), 404)
        : c.json(apiError("forbidden", "No run you can read has this id"), 403);
    }
    const refused = await authorize(c, caller, run.team, "read");
    if (refused) return c.json(apiError("forbidden", "No run you can read has this id"), 403);
    return c.json(run satisfies BackgroundRun);
  });

  router.on(
    "POST",
    `${BACKGROUND_RUNS_PATH}/:id/cancel`,
    async (c, caller) => {
      const id = c.req.param("id") ?? "";
      const run = await ledger.backgroundRuns.get(id);
      if (!run) return c.json(apiError("not_found", "No such run"), 404);
      const refused = await authorize(c, caller, run.team, "work");
      if (refused) return refused;
      const by = caller.kind === "admin" ? "admin" : caller.person.id;
      if (isFinalRunState(run.state)) return c.json(run);
      if (background) return c.json((await background.runner.cancel(id, by)) ?? run);
      await ledger.backgroundRuns.requestCancel(id, {
        by,
        at: new Date().toISOString(),
        scope: "run",
      });
      return c.json((await ledger.backgroundRuns.get(id)) ?? run);
    },
    limit(SMALL_BODY_BYTES),
  );

  router.on(
    "POST",
    `${BACKGROUND_RUNS_PATH}/kill`,
    async (c, caller) => {
      if (!background) return off(c);
      const body = await readBody(c, killBody);
      if (body instanceof Response) return body;
      const refused = await mayKill(c, caller, body.scope, body.target);
      if (refused) return refused;
      const by = caller.kind === "admin" ? "admin" : caller.person.id;
      const result = await background.runner.kill(body.scope, body.target, by, body.reason);
      return c.json({ scope: body.scope, target: body.target, ...result } satisfies KillResponse);
    },
    limit(SMALL_BODY_BYTES),
  );

  router.on("DELETE", `${BACKGROUND_RUNS_PATH}/kill`, async (c, caller) => {
    if (!background) return off(c);
    const scope = c.req.query("scope") as KillScope | undefined;
    const target = c.req.query("target");
    if (!scope || !(KILL_SCOPES as readonly string[]).includes(scope) || !target) {
      return c.json(apiError("invalid_query", "Expected scope (team or org) and target"), 400);
    }
    const refused = await mayKill(c, caller, scope, target);
    if (refused) return refused;
    const by = caller.kind === "admin" ? "admin" : caller.person.id;
    await background.runner.clearKill(scope, target, by);
    return c.json({ scope, target, active: false, stopped: [] } satisfies KillResponse);
  });
}

/**
 * POST /v1/background-runs/webhook: a run from a signed webhook (the Slack and Telegram bridges
 * in examples/ use it). No bearer token: X-Selfhost-Signature-256, the HMAC-SHA256 of the body
 * under the secret in the variable [background] webhook_secret_env names, is the credential.
 * A bad signature starts nothing and is recorded as a refused trigger.
 */
export function backgroundWebhookRoute(
  app: Hono,
  ledger: Ledger,
  background: Background | undefined,
  defaultTeam: string | undefined,
): void {
  app.post(BACKGROUND_WEBHOOK_PATH, limit(SMALL_BODY_BYTES), async (c) => {
    if (!background) return c.json(apiError("not_found", `No route for POST ${c.req.path}`), 404);
    const text = await c.req.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return c.json(apiError("invalid_request", "Expected a JSON body"), 400);
    }
    const valid = webhookBody.validate(parsed);
    if (!valid.ok) {
      const [first] = valid.errors;
      return c.json(apiError("invalid_request", `${first?.field}: ${first?.message}`), 400);
    }
    const body = valid.value;
    const team = body.team ?? defaultTeam;
    if (!team)
      return c.json(apiError("invalid_request", "team: Expected the team the run is for"), 400);
    const { config } = await background.settings(team);
    const settings = backgroundSettings(config);
    const secretEnv = settings.webhook_secret_env;
    const secret = secretEnv ? background.env[secretEnv] : undefined;
    const trigger = {
      source: "webhook" as const,
      sender: body.sender,
      person: null,
      ...(body.ref ? { ref: body.ref } : {}),
    };
    const refused = async (reason: string, status: 401 | 403 | 409, code: string) => {
      await ledger.append([
        triggeredEvent(
          { ...trigger, accepted: false, reason },
          { team, repo: body.repo },
          background.clock.now(),
        ),
      ]);
      return c.json(apiError(code, reason), status);
    };
    const stamp = {
      timestamp: c.req.header(WEBHOOK_TIMESTAMP_HEADER),
      delivery: c.req.header(WEBHOOK_DELIVERY_HEADER),
    };
    const stale = webhookStampProblem(stamp, background.clock.now());
    if (secret && stale) return refused(stale, 401, "invalid_signature");
    if (!secret || !verifyWebhook(secret, text, stamp, c.req.header(WEBHOOK_SIGNATURE_HEADER))) {
      await ledger.append([
        triggeredEvent(
          {
            ...trigger,
            accepted: false,
            reason: secret
              ? "The webhook signature does not match"
              : "Signed webhooks are off for this team ([background] webhook_secret_env)",
          },
          { team, repo: body.repo },
          background.clock.now(),
        ),
      ]);
      return c.json(
        apiError(
          "invalid_signature",
          `${WEBHOOK_SIGNATURE_HEADER} does not sign the timestamp, delivery and body under the team's webhook secret`,
        ),
        401,
      );
    }
    // The secret is the bridge's; it speaks only for the people the team listed for it.
    const sender = body.sender.toLowerCase();
    if (!settings.webhook_senders.some((person) => person.toLowerCase() === sender)) {
      return refused(
        `${body.sender} is not on [background] webhook_senders for team ${team}, so the webhook cannot start runs as them`,
        403,
        "not_allowed",
      );
    }
    const claimed = await ledger.deliveries.claim(`background:${team}:${stamp.delivery}`, {
      event: "selfhost.background_webhook",
      now: background.clock.now(),
    });
    if (!claimed) {
      return refused(
        `Delivery ${stamp.delivery} was already taken: each request needs a new ${WEBHOOK_DELIVERY_HEADER}`,
        409,
        "duplicate_delivery",
      );
    }
    return answer(
      c,
      await background.runner.start({
        team,
        repo: body.repo.toLowerCase(),
        task: body.task,
        ...(body.agent ? { agent: body.agent } : {}),
        person: body.sender,
        trigger: { ...trigger, person: body.sender },
      }),
    );
  });
}

/**
 * A refusal as a reply on GitHub: one closing period, and no command line flag the comment
 * cannot pass (a comment names an agent with --agent, never a runtime).
 */
export function commentReason(reason: string): string {
  const text = reason
    .replace(
      /name one with --runtime, or set \[runtime\] default/,
      "set [runtime] default in the team's selfhost.toml (a comment cannot name a runtime)",
    )
    .trim()
    .replace(/\.+$/, "");
  return `${text}.`;
}

/**
 * A GitHub delivery that asks for a run (`/selfhost run` comment, or the run label on an issue):
 * maps the sender to a person through [review] github_logins, starts the run and answers on the
 * issue either way. undefined when the delivery asks for no run, so the caller handles it.
 */
export async function githubRunTrigger(
  ledger: Ledger,
  background: Background,
  event: string,
  payload: unknown,
  team: string | undefined,
  /** Records the delivery as handled; false when it was, so a redelivery starts nothing. */
  claim: () => Promise<boolean>,
): Promise<{ started?: string; refused?: string; duplicate?: boolean } | undefined> {
  if (event !== "issue_comment" && event !== "issues") return undefined;
  const repo = (
    payload as { repository?: { full_name?: string } }
  )?.repository?.full_name?.toLowerCase();
  if (!repo) return undefined;
  // SELFHOST_GITHUB_TEAM names the team, but only for its own repos: the App can be installed
  // on repositories the team never claimed, and a comment there must not start the team's run.
  const org = team ? ((await ledger.teams.getTeam(team))?.org ?? DEFAULT_ORG_ID) : DEFAULT_ORG_ID;
  const claimed = (await ledger.orgs.repoOwner(org, repo))?.team;
  if (team && claimed !== team) {
    return {
      refused: claimed
        ? `${repo} belongs to team ${claimed}, not ${team} (SELFHOST_GITHUB_TEAM)`
        : `${repo} is not claimed by team ${team}: add it with selfhost team repo add`,
    };
  }
  const owner = team ?? claimed;
  if (!owner) return undefined;
  const { config } = await background.settings(owner);
  const found = githubRunRequest(event, payload, backgroundSettings(config));
  if ("skip" in found) return undefined;
  if (!(await claim())) return { duplicate: true };
  const person = personForLogin(found.sender, config.review.github_logins) ?? null;
  const result = await background.runner.start({
    team: owner,
    repo: found.repo.toLowerCase(),
    task: found.task,
    ...(found.agent ? { agent: found.agent } : {}),
    person,
    trigger: { source: found.source, sender: found.sender, person, ref: found.url },
  });
  const reply =
    "refused" in result
      ? `selfhost did not start a run: ${commentReason(result.refused)}`
      : `selfhost started background run \`${result.run.id}\` (${result.run.agent}) on branch \`${result.run.branch}\`. Follow it with \`selfhost tail --run ${result.run.id}\`.`;
  await background.github?.comment(found.repo, found.number, reply).catch((error) => {
    background.log(
      `background: could not answer on ${found.repo}#${found.number}: ${error instanceof Error ? error.message : error}`,
    );
  });
  return "refused" in result ? { refused: result.refused } : { started: result.run.id };
}

export interface ScheduleJob {
  tick(): Promise<string[]>;
  stop(): void;
}

/**
 * Starts the [background] schedules of every team with a stored policy, once a minute. Each due
 * minute starts once per server; a minute missed while the server was down is started once.
 * Schedules run with the team's key (no person).
 */
export function startScheduleJob(
  ledger: Ledger,
  background: Background,
  teams: () => Promise<string[]>,
  options: { intervalMs?: number } = {},
): ScheduleJob {
  let last = background.clock.now();
  const tick = async () => {
    const now = background.clock.now();
    const started: string[] = [];
    for (const team of await teams()) {
      const { config } = await background.settings(team);
      for (const due of dueSchedules(backgroundSettings(config), last, now)) {
        const recent = await ledger.backgroundRuns.list({ teams: [team], limit: 50 });
        if (recent.some((run) => run.trigger.ref === due.ref)) continue;
        const result = await background.runner.start({
          team,
          repo: due.schedule.repo.toLowerCase(),
          task: due.schedule.task,
          ...(due.schedule.agent ? { agent: due.schedule.agent } : {}),
          person: null,
          trigger: { source: "schedule", sender: due.schedule.name, person: null, ref: due.ref },
        });
        if ("run" in result) started.push(result.run.id);
        else
          background.log(`background: schedule ${due.schedule.name} of ${team}: ${result.refused}`);
      }
    }
    last = now;
    return started;
  };
  const stop = background.clock.every(options.intervalMs ?? 60_000, async () => {
    await tick().catch((error) =>
      background.log(`background: schedules: ${error instanceof Error ? error.message : error}`),
    );
  });
  return { tick, stop };
}

/** Every team on the server, for the schedule job. */
export function allTeams(ledger: Ledger): () => Promise<string[]> {
  const db = databaseOf(ledger);
  return async () =>
    (await db.query<{ id: string }>("SELECT id FROM teams ORDER BY id")).map((row) => row.id);
}
