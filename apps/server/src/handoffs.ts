import type { GitHubApp } from "@selfhost/github";
import { syncComment } from "@selfhost/github";
import { databaseOf, type Ledger } from "@selfhost/ledger";
import { uuidv7 } from "@selfhost/mcp";
import { handoffRefusal, takeoverRefusal } from "@selfhost/review";
import {
  type AgentVendor,
  CreateHandoffRequestSchema,
  createValidator,
  EVENT_SCHEMA,
  HANDOFF_EVENT_DATA_VERSION,
  HANDOFF_EVENT_KIND,
  HANDOFF_SCHEMA,
  HANDOFF_TRANSCRIPT_MAX_BYTES,
  HANDOFF_TURNS_DEFAULT,
  HANDOFFS_SCHEMA,
  type Handoff,
  type HandoffItem,
  HandoffQuerySchema,
  type HandoffsResponse,
  type LedgerEvent,
  maskSecrets,
  type RedactionPattern,
  type ResolvedSelfhostConfig,
  type ReviewItem,
  RUN_SHARE_SCHEMA,
  type RunShareRequest,
  RunShareRequestSchema,
  type RunShareResponse,
  redactEvent,
  redactionSettings,
  redactTranscript,
  roleAllows,
  TAKEOVER_SCHEMA,
  type TakeoverResponse,
} from "@selfhost/schema";
import {
  lastTurns,
  runEvents,
  runViewUrl,
  summarizeRun,
  teamOfRun,
  touchedFiles,
} from "@selfhost/traces";
import type { Context } from "hono";
import { apiError, type Caller, forbidden, type Router, roleIn } from "./access.js";
import { invalidQuery, limit, readBody, SMALL_BODY_BYTES } from "./http.js";
import { teamConfig } from "./runs.js";

export interface HandoffRouteOptions {
  /** selfhost.toml for runs whose team has no stored policy. */
  config?: ResolvedSelfhostConfig;
  now?: () => Date;
  /** SELFHOST_PUBLIC_URL, the console's address for run links. Default: the request's origin. */
  publicUrl?: string;
  /** The GitHub App, for the run link on the run's pull requests. */
  githubApp?: GitHubApp;
}

const createBody = createValidator(CreateHandoffRequestSchema);
const shareBody = createValidator(RunShareRequestSchema);
const handoffQuery = createValidator(HandoffQuerySchema);

/** A transcript plus the rest of the request, with room for JSON escaping. */
const MAX_HANDOFF_BYTES = HANDOFF_TRANSCRIPT_MAX_BYTES * 2;

const noRun = (c: Context, caller: Caller, id: string) =>
  caller.kind === "person"
    ? c.json(apiError("forbidden", `No run ${id} in a team you can read.`), 403)
    : c.json(apiError("not_found", `No run ${id}`), 404);

const noHandoff = (c: Context, caller: Caller, id: string) =>
  caller.kind === "person"
    ? c.json(apiError("forbidden", `No handoff ${id} in a team you can read.`), 403)
    : c.json(apiError("not_found", `No handoff ${id}`), 404);

/** Who acts, as the refusal rules in @selfhost/review take them. */
async function deciderIn(caller: Caller, team: string | null) {
  if (caller.kind === "admin") return { by: "admin", trusted: true };
  const role = team === null ? undefined : await roleIn(caller, team);
  return { by: caller.person.id, ...(role ? { role } : {}) };
}

async function canRead(caller: Caller, team: string | null): Promise<boolean> {
  if (caller.kind === "admin") return true;
  if (team === null) return false;
  const role = await roleIn(caller, team);
  return role !== undefined && roleAllows(role, "read");
}

/** The teams a person token reads; undefined (all) for the admin token. */
async function readableTeams(caller: Caller): Promise<string[] | undefined> {
  if (caller.kind === "admin") return undefined;
  const { memberships } = await caller.scope();
  const own = roleAllows(caller.person.role, "read") ? [caller.person.team] : [];
  return [
    ...new Set([
      ...own,
      ...memberships.filter((m) => roleAllows(m.role, "read")).map((m) => m.team),
    ]),
  ];
}

/** A handoff as it is shown: the note and turns masked under the team's current patterns. */
function shown(handoff: Handoff, patterns: readonly RedactionPattern[]): Handoff {
  return {
    ...handoff,
    note: handoff.note === null ? null : maskSecrets(handoff.note, patterns).text,
    turns: handoff.turns.map((turn) => ({ ...turn, text: maskSecrets(turn.text, patterns).text })),
  };
}

/** The pull requests a run's events link to, on github.com. */
function pullsOf(events: readonly LedgerEvent[]) {
  const pulls = new Map<string, { owner: string; repo: string; number: number }>();
  for (const event of events) {
    const url =
      event.links?.pr_url ?? (event.target?.type === "pr" ? event.target.value : undefined);
    const match = url ? /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url) : null;
    if (url && match && !pulls.has(url)) {
      pulls.set(url, {
        owner: match[1] ?? "",
        repo: match[2] ?? "",
        number: Number(match[3]),
      });
    }
  }
  return pulls;
}

const AGENT_NAMES: Record<AgentVendor, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  goose: "Goose",
  cursor: "Cursor",
  copilot: "Copilot",
  other: "Agent",
};

const marker = (runId: string) =>
  `<!-- selfhost:run-link ${runId.replace(/[^A-Za-z0-9._:-]/g, "_")} -->`;

/** The run link comment: no names or emails, since a pull request may be read more widely. */
function shareComment(runId: string, url: string, events: readonly LedgerEvent[], now: Date) {
  const run = summarizeRun(runId, events, { now });
  const agent = run.agent ? AGENT_NAMES[run.agent.vendor] : "Agent";
  const handoffs = events.filter((e) => e.kind === HANDOFF_EVENT_KIND).length;
  const facts = [
    `${agent} session \`${runId.slice(0, 12)}\``,
    run.ended_at ? "ended" : "still going",
    `$${run.cost_usd.toFixed(2)} so far`,
    ...(handoffs > 0 ? [`handed over ${handoffs === 1 ? "once" : `${handoffs} times`}`] : []),
  ];
  return [
    `**Agent run:** [open the run in selfhost](${url}): ${facts.join(", ")}.`,
    "",
    "The link needs sign-in and a place in the run's team; secrets stay masked.",
  ].join("\n");
}

/**
 * Handing a run to a teammate, and the run's share link, for both kinds of token:
 *
 * - POST /v1/runs/{run_id}/handoffs: the owner change (a run.handed_off event) and the record the
 *   new owner takes the run over with.
 * - GET /v1/handoffs, GET /v1/handoffs/{id}: records in the teams the caller reads.
 * - POST /v1/handoffs/{id}/takeover: the new owner's own takeover, which gives the transcript
 *   once.
 * - POST /v1/runs/{run_id}/share: the run's stable link, posted on its pull requests by the
 *   GitHub App as one comment that later shares update.
 *
 * Who may hand a run over and take it over is decided in @selfhost/review (handoff.ts). A run,
 * or a handoff, in a team the caller cannot read answers 403 whether or not it exists.
 */
export function handoffRoutes(
  router: Router,
  ledger: Ledger,
  options: HandoffRouteOptions = {},
): void {
  const now = options.now ?? (() => new Date());
  const configOf = teamConfig(ledger, options.config);
  const server = (c: Context) => options.publicUrl ?? new URL(c.req.url).origin;

  /** The run's events, redacted under each team's current settings, and its team. */
  const loadRun = async (id: string) => {
    const rows = await runEvents(databaseOf(ledger), id);
    if (rows.length === 0) return undefined;
    const team = teamOfRun(rows);
    const settings = new Map<string | null, ReturnType<typeof redactionSettings>>();
    const events: LedgerEvent[] = [];
    for (const row of rows) {
      if (row.team !== team) continue;
      let found = settings.get(row.team);
      if (!found) {
        found = redactionSettings(await configOf(row.team));
        settings.set(row.team, found);
      }
      events.push(redactEvent(row.event, found));
    }
    return { team, events };
  };

  router.on(
    "POST",
    "/v1/runs/:run_id/handoffs",
    async (c, caller) => {
      const runId = c.req.param("run_id") ?? "";
      const body = await readBody(c, createBody);
      if (body instanceof Response) return body;
      const run = await loadRun(runId);
      if (!run || !(await canRead(caller, run.team))) return noRun(c, caller, runId);
      const { team, events } = run;
      if (team === null) {
        return c.json(
          apiError(
            "invalid_request",
            `Run ${runId} belongs to no team, so nobody can take it over.`,
          ),
          400,
        );
      }
      // Each owner change of a run gets its own time, so the newest handoff is never a tie.
      const last = Math.max(
        0,
        ...events.filter((e) => e.kind === HANDOFF_EVENT_KIND).map((e) => Date.parse(e.ts)),
      );
      const at = new Date(Math.max(now().getTime(), last + 1));
      const config = await configOf(team);
      const summary = summarizeRun(runId, events, { now: at, team });
      const people = await ledger.teams.listPeople(team);
      const target = people.find((p) => p.id.toLowerCase() === body.to.trim().toLowerCase());
      const decider = await deciderIn(caller, team);
      const refused = handoffRefusal(
        { team, owner: summary.owner },
        { id: target?.id ?? body.to.trim(), ...(target ? { role: target.role } : {}) },
        decider,
      );
      if (refused?.by === "caller") return c.json(apiError("forbidden", refused.message), 403);
      if (refused) return c.json(apiError("invalid_request", refused.message), 400);
      const to = target?.id ?? body.to.trim();

      let transcript: { text: string; info: NonNullable<Handoff["transcript"]> } | undefined;
      if (body.transcript) {
        if (config.handoff?.share_transcript !== true) {
          return c.json(
            apiError(
              "transcript_not_shared",
              `Team ${team} does not share transcripts with handoffs: its selfhost.toml would need [handoff] share_transcript = true. Hand the run over without it.`,
            ),
            400,
          );
        }
        const text = redactTranscript(body.transcript.text, config.redaction).text;
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > HANDOFF_TRANSCRIPT_MAX_BYTES) {
          return c.json(
            apiError(
              "payload_too_large",
              `The transcript is ${bytes} bytes, over the ${HANDOFF_TRANSCRIPT_MAX_BYTES} limit. Hand the run over without it.`,
            ),
            413,
          );
        }
        transcript = {
          text,
          info: {
            vendor: body.transcript.vendor,
            file_name: body.transcript.file_name,
            bytes,
            redacted: true,
          },
        };
      }

      const items = await databaseOf(ledger).query<{ body: unknown }>(
        `SELECT body FROM review_items
         WHERE state = 'open' AND session_id = $1 AND coalesce(team, '') = $2
         ORDER BY created_at, id`,
        [runId, team],
      );
      const openItems: HandoffItem[] = items.map((row) => {
        const item = (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as ReviewItem;
        return { id: item.id, kind: item.kind, title: item.title, blocking: item.blocking };
      });

      const id = uuidv7(at);
      const eventId = uuidv7(at);
      const previous = summary.owner ?? "unknown";
      const branch = body.branch?.trim() || null;
      const event: LedgerEvent = {
        id: eventId,
        schema: EVENT_SCHEMA,
        ts: at.toISOString(),
        source: "server",
        kind: HANDOFF_EVENT_KIND,
        actor:
          caller.kind === "person"
            ? { kind: "person", id: caller.person.id }
            : { kind: "system", id: "selfhost" },
        team,
        ...(summary.repo ? { repo: summary.repo } : {}),
        ...(summary.agent ? { agent: summary.agent } : {}),
        session_id: runId,
        ...(body.commit ? { links: { commit_sha: body.commit } } : {}),
        data: {
          v: HANDOFF_EVENT_DATA_VERSION,
          handoff: id,
          owner: to,
          previous_owner: previous,
          ...(branch ? { branch } : {}),
        },
      };
      await ledger.append([event], { team });
      const patterns = config.redaction;
      const note = body.note?.trim();
      const handoff: Handoff = {
        schema: HANDOFF_SCHEMA,
        id,
        run_id: runId,
        team,
        repo: summary.repo,
        agent: summary.agent,
        from: previous,
        to,
        by: decider.by,
        created_at: at.toISOString(),
        note: note ? maskSecrets(note, patterns).text : null,
        branch,
        commit: body.commit ?? null,
        pushed: body.pushed ?? null,
        uncommitted: (body.uncommitted ?? []).map((path) => maskSecrets(path, patterns).text),
        files: touchedFiles(events),
        open_items: openItems,
        cost_usd: summary.cost_usd,
        tokens: summary.tokens,
        turns: lastTurns(
          events,
          body.turns ?? config.handoff?.turns ?? HANDOFF_TURNS_DEFAULT,
          patterns,
        ),
        transcript: transcript?.info ?? null,
        state: "pending",
        taken_at: null,
        event_id: eventId,
        run_url: runViewUrl(server(c), runId),
      };
      await ledger.handoffs.create(handoff, transcript?.text);
      return c.json(handoff, 201);
    },
    limit(MAX_HANDOFF_BYTES),
  );

  router.on("GET", "/v1/handoffs", async (c, caller) => {
    const parsed = handoffQuery.validate(c.req.query());
    if (!parsed.ok) return invalidQuery(c, parsed.errors);
    const { state, run, to } = parsed.value;
    let person = to;
    if (to === "me") {
      if (caller.kind === "admin") {
        return c.json(apiError("invalid_query", "to: me needs a person token"), 400);
      }
      person = caller.person.id;
    }
    const teams = await readableTeams(caller);
    const found = await ledger.handoffs.list({
      ...(teams ? { teams } : {}),
      ...(state ? { state } : {}),
      ...(run ? { run } : {}),
      ...(person ? { to: person } : {}),
    });
    const handoffs: Handoff[] = [];
    for (const handoff of found) {
      handoffs.push(shown(handoff, (await configOf(handoff.team)).redaction));
    }
    return c.json({ schema: HANDOFFS_SCHEMA, handoffs } satisfies HandoffsResponse);
  });

  router.on("GET", "/v1/handoffs/:id", async (c, caller) => {
    const id = c.req.param("id") ?? "";
    const handoff = await ledger.handoffs.get(id);
    if (!handoff || !(await canRead(caller, handoff.team))) return noHandoff(c, caller, id);
    return c.json(shown(handoff, (await configOf(handoff.team)).redaction));
  });

  router.on(
    "POST",
    "/v1/handoffs/:id/takeover",
    async (c, caller) => {
      const id = c.req.param("id") ?? "";
      const handoff = await ledger.handoffs.get(id);
      if (!handoff || !(await canRead(caller, handoff.team))) return noHandoff(c, caller, id);
      const refused = takeoverRefusal(handoff, await deciderIn(caller, handoff.team));
      if (refused) return c.json(apiError("forbidden", refused), 403);
      const patterns = (await configOf(handoff.team)).redaction;
      const taken = await ledger.handoffs.take(id, now());
      if (!taken) {
        const current = (await ledger.handoffs.get(id)) ?? handoff;
        const why =
          current.state === "taken"
            ? `It was taken over at ${current.taken_at}.`
            : "The run was handed on again since; take over the newer handoff.";
        return c.json(
          {
            ...apiError("not_pending", `Handoff ${id} is ${current.state}. ${why}`),
            handoff: shown(current, patterns),
          },
          409,
        );
      }
      const info = taken.handoff.transcript;
      return c.json({
        schema: TAKEOVER_SCHEMA,
        handoff: shown(taken.handoff, patterns),
        transcript:
          info && taken.transcript !== null
            ? { vendor: info.vendor, file_name: info.file_name, text: taken.transcript }
            : null,
      } satisfies TakeoverResponse);
    },
    limit(SMALL_BODY_BYTES),
  );

  router.on(
    "POST",
    "/v1/runs/:run_id/share",
    async (c, caller) => {
      const runId = c.req.param("run_id") ?? "";
      let request: RunShareRequest = {};
      const text = await c.req.text();
      if (text.trim() !== "") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return c.json(apiError("invalid_request", "Expected a JSON body"), 400);
        }
        const checked = shareBody.validate(parsed);
        if (!checked.ok) {
          const [first] = checked.errors;
          return c.json(apiError("invalid_request", `${first?.field}: ${first?.message}`), 400);
        }
        request = checked.value;
      }
      const run = await loadRun(runId);
      if (!run || !(await canRead(caller, run.team))) return noRun(c, caller, runId);
      const url = runViewUrl(server(c), runId);
      const answer = (fields: Partial<RunShareResponse>) =>
        c.json({
          schema: RUN_SHARE_SCHEMA,
          run_id: runId,
          url,
          comments: [],
          skipped: null,
          ...fields,
        } satisfies RunShareResponse);
      if (request.comment === false) return answer({ skipped: "Not asked to post on GitHub." });
      const app = options.githubApp;
      if (!app) {
        return answer({
          skipped: "No GitHub App on this server, so the link was not posted on any pull request.",
        });
      }
      if (caller.kind === "person" && run.team !== null) {
        const role = await roleIn(caller, run.team);
        if (role === undefined || !roleAllows(role, "work")) {
          return forbidden(c, "work", run.team, role);
        }
      }
      const pulls = pullsOf(run.events);
      if (pulls.size === 0) {
        return answer({ skipped: "The run links to no pull request yet." });
      }
      const body = { body: shareComment(runId, url, run.events, now()), marker: marker(runId) };
      const comments: RunShareResponse["comments"] = [];
      for (const [pr, pull] of pulls) {
        try {
          const installation = await app.repoInstallation(pull.owner, pull.repo);
          if (installation === undefined) {
            comments.push({
              pr,
              url: null,
              action: "failed",
              error: `The selfhost GitHub App is not installed on ${pull.owner}/${pull.repo}.`,
            });
            continue;
          }
          const synced = await syncComment(app.installation(installation), pull, body);
          comments.push({
            pr,
            url: synced.url,
            action:
              synced.write?.action === "create_comment"
                ? "created"
                : synced.write
                  ? "updated"
                  : "unchanged",
          });
        } catch (error) {
          comments.push({
            pr,
            url: null,
            action: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return answer({ comments });
    },
    limit(SMALL_BODY_BYTES),
  );
}
