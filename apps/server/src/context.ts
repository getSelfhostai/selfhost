import { createHash } from "node:crypto";
import {
  type ContextLayer,
  formatContextError,
  type ItemRef,
  itemFiles,
  layerHash,
  mergeLayers,
  parseItemId,
  readLayerFiles,
  withItem,
} from "@selfhost/context";
import { type Ledger, proposalInfo, type Settlement, type StoredProposal } from "@selfhost/ledger";
import { uuidv7 } from "@selfhost/mcp";
import { CONTEXT_PROMOTION_REQUEST, openReviewList, refreshReviewList } from "@selfhost/review";
import {
  type ContextFile,
  type ContextLayerInfo,
  ContextProposalRequestSchema,
  type ContextResponse,
  createValidator,
  EVENT_SCHEMA,
  type LedgerEvent,
  type OrgContextResponse,
  type ResolvedSelfhostConfig,
  roleAllows,
  SetContextRequestSchema,
  type TeamInfo,
} from "@selfhost/schema";
import type { Context } from "hono";
import { apiError, authorize, type Caller, orgOf, type Router } from "./access.js";
import { limit, readBody } from "./http.js";

/** A layer is at most 500 files of up to 1,000,000 characters; JSON escaping can grow them. */
const CONTEXT_BODY_BYTES = 16 * 1024 * 1024;
/** How much of a proposed item the review item's brief shows. */
const BRIEF_CHARS = 4000;

const setContextBody = createValidator(SetContextRequestSchema);
const proposalBody = createValidator(ContextProposalRequestSchema);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export interface ContextRouteOptions {
  /** selfhost.toml for the review items of proposals, as the review list reads it. */
  config?: ResolvedSelfhostConfig;
  now?: () => Date;
}

/** The layer's files as a source, or the 400 naming every problem in them. */
function parsed(c: Context, files: ContextFile[], label: string) {
  const read = readLayerFiles(files, label);
  if (read.ok) return read.source;
  const [first] = read.errors;
  const more = read.errors.length > 1 ? ` (and ${read.errors.length - 1} more)` : "";
  return c.json(
    apiError("invalid_context", `${first ? formatContextError(first) : "Invalid layer"}${more}`),
    400,
  );
}

/**
 * MCP servers in a layer that start a program on every member's laptop, by name, with their
 * settings: only an owner may add or change one, since it runs as each person who syncs.
 */
function commandServers(files: ContextFile[], label: string): Map<string, string> {
  const read = readLayerFiles(files, label);
  if (!read.ok) return new Map();
  return new Map(
    read.source.mcp
      .filter((server) => server.spec.command !== undefined)
      .map((server) => [server.name, JSON.stringify(server.spec)]),
  );
}

/** The command-bearing MCP servers `next` adds or changes compared with `current`. */
function newCommands(current: ContextFile[], next: ContextFile[], label: string): string[] {
  const before = commandServers(current, label);
  return [...commandServers(next, label)]
    .filter(([name, spec]) => before.get(name) !== spec)
    .map(([name]) => name);
}

/** The org and team layers with the team items the org layer replaces. */
function conflictsOf(layers: ContextLayerInfo[]) {
  const sources: ContextLayer[] = [];
  for (const layer of layers) {
    const read = readLayerFiles(layer.files, `${layer.kind}:${layer.name}`);
    if (read.ok) sources.push({ kind: layer.kind, name: layer.name, source: read.source });
  }
  return mergeLayers(sources).conflicts;
}

/** Why a proposal of the item to the team is refused, or undefined when it can go ahead. */
function taken(ref: ItemRef, id: string, org: ContextFile[], team: ContextFile[], name: string) {
  if (itemFiles(org, ref).length > 0) {
    return `The org layer already has ${id}, and the org's items always win, so a team copy would never be used.`;
  }
  if (itemFiles(team, ref).length > 0) {
    return `Team ${name}'s layer already has ${id}. An owner or admin changes it with selfhost context push.`;
  }
  return undefined;
}

/**
 * The org and team context layers (GET and PUT /v1/context, GET and PUT
 * /v1/orgs/{org}/context) and proposals of a person's items to their team (POST
 * /v1/context/proposals). A proposal opens a review item with the proposal's id; once an owner
 * or admin of the team approves it, the next read of the team's context adds the item to the
 * team layer, which every member's laptop pulls on its next sync.
 */
export function contextRoutes(
  router: Router,
  ledger: Ledger,
  options: ContextRouteOptions = {},
): void {
  const { teams, orgs, context } = ledger;
  const now = options.now ?? (() => new Date());
  const listFor = (team: string) =>
    openReviewList(ledger, {
      team,
      now,
      ...(options.config ? { config: options.config } : {}),
    });
  const big = limit(CONTEXT_BODY_BYTES);

  /** What becomes of an open proposal whose review item is no longer open. */
  async function outcome(
    proposal: StoredProposal,
    state: string,
    answer: { by: string; verdict: string } | undefined,
  ): Promise<(current: ContextFile[], org: ContextFile[]) => Settlement> {
    const ref = parseItemId(proposal.item);
    if (state === "answered" && answer?.verdict === "approve" && ref) {
      const role = (await teams.getPerson(proposal.team, answer.by))?.role;
      if (!role || !roleAllows(role, "policy.write")) {
        return () => ({
          state: "refused",
          by: answer.by,
          note: `Approved by ${answer.by}, who is not an owner or admin of team ${proposal.team}.`,
        });
      }
      const runs = newCommands([], proposal.files, `personal:${proposal.person}`);
      if (runs.length > 0 && !roleAllows(role, "roles")) {
        return () => ({
          state: "refused",
          by: answer.by,
          note: `Approved by ${answer.by}, but an MCP server that runs a command starts a program on every member's laptop, so only an owner of team ${proposal.team} approves it.`,
        });
      }
      return (current, org) => {
        const note = taken(ref, proposal.item, org, current, proposal.team);
        if (note) return { state: "refused", by: answer.by, note };
        return { state: "applied", by: answer.by, files: withItem(current, ref, proposal.files) };
      };
    }
    const note =
      state === "answered"
        ? `Denied by ${answer?.by ?? "a person"}.`
        : state === "dismissed"
          ? "A newer proposal of the same item replaced it."
          : "Its review item expired.";
    return () => ({ state: "refused", ...(answer ? { by: answer.by } : {}), note });
  }

  /** Applies or refuses the team's open proposals whose review items were answered. */
  async function settleOpen(team: TeamInfo): Promise<void> {
    const open = await context.listProposals(team.id, { state: "open", limit: 200 });
    if (open.length === 0) return;
    const list = listFor(team.id);
    const org = (await context.getOrgContext(team.org ?? ""))?.files ?? [];
    for (const proposal of open) {
      const item = await list.get(proposal.id);
      if (!item || item.state === "open") continue;
      const decide = await outcome(proposal, item.state, item.answer);
      await context.settle(proposal.id, (current) => decide(current, org));
    }
  }

  async function contextOf(team: TeamInfo): Promise<ContextResponse> {
    await settleOpen(team);
    const org = team.org ?? "";
    const [orgLayer, teamLayer, proposals] = await Promise.all([
      context.getOrgContext(org),
      context.getTeamContext(team.id),
      context.listProposals(team.id),
    ]);
    const layers: ContextLayerInfo[] = [];
    if (orgLayer) {
      layers.push({
        kind: "org",
        name: org,
        hash: layerHash(orgLayer.files),
        updated_at: orgLayer.updatedAt,
        files: orgLayer.files,
      });
    }
    if (teamLayer) {
      layers.push({
        kind: "team",
        name: team.id,
        hash: layerHash(teamLayer.files),
        updated_at: teamLayer.updatedAt,
        files: teamLayer.files,
      });
    }
    return {
      team: team.id,
      org,
      hash: sha256(layers.map((layer) => `${layer.kind}:${layer.name}:${layer.hash}`).join("\n")),
      layers,
      conflicts: conflictsOf(layers),
      proposals: proposals.map(proposalInfo),
    };
  }

  /** The team a request is about, which must exist: the one named, else the person token's. */
  function teamFor(c: Context, caller: Caller, named: string | undefined) {
    const team = named ?? (caller.kind === "person" ? caller.person.team : undefined);
    if (team === undefined) {
      return c.json(apiError("invalid_query", "team: Required with the admin token"), 400);
    }
    return team;
  }

  router.on("GET", "/v1/context", async (c, caller) => {
    const team = teamFor(c, caller, c.req.query("team"));
    if (team instanceof Response) return team;
    const refused = await authorize(c, caller, team, "read");
    if (refused) return refused;
    const info = await teams.getTeam(team);
    if (!info) return c.json(apiError("not_found", `No team ${team}`), 404);
    return c.json((await contextOf(info)) satisfies ContextResponse);
  });

  router.on(
    "PUT",
    "/v1/context",
    async (c, caller) => {
      const team = teamFor(c, caller, c.req.query("team"));
      if (team instanceof Response) return team;
      const refused = await authorize(c, caller, team, "policy.write");
      if (refused) return refused;
      const body = await readBody(c, setContextBody);
      if (body instanceof Response) return body;
      const info = await teams.getTeam(team);
      if (!info) return c.json(apiError("not_found", `No team ${team}`), 404);
      const source = parsed(c, body.files, `team:${team}`);
      if (source instanceof Response) return source;
      const current = (await context.getTeamContext(team))?.files ?? [];
      const commands = newCommands(current, body.files, `team:${team}`);
      if (commands.length > 0 && caller.kind === "person") {
        const owner = await authorize(c, caller, team, "roles");
        if (owner) {
          return c.json(
            apiError(
              "forbidden",
              `MCP servers that run a command (${commands.join(", ")}) start a program on every member's laptop, so only an owner of team ${team} adds or changes them.`,
            ),
            403,
          );
        }
      }
      await context.setTeamContext(team, body.files);
      return c.json((await contextOf(info)) satisfies ContextResponse);
    },
    big,
  );

  /** The org a request is about, which a person token must belong to. */
  async function orgFor(c: Context, caller: Caller) {
    const org = c.req.param("org") ?? "";
    const own = await orgOf(caller);
    if (own !== undefined && own !== org) {
      return c.json(apiError("forbidden", `You are not in org ${org}.`), 403);
    }
    if (!(await orgs.getOrg(org))) return c.json(apiError("not_found", `No org ${org}`), 404);
    return org;
  }

  async function orgContextOf(org: string): Promise<OrgContextResponse> {
    const stored = await context.getOrgContext(org);
    const files = stored?.files ?? [];
    return { org, hash: layerHash(files), updated_at: stored?.updatedAt ?? null, files };
  }

  router.on("GET", "/v1/orgs/:org/context", async (c, caller) => {
    const org = await orgFor(c, caller);
    if (org instanceof Response) return org;
    return c.json((await orgContextOf(org)) satisfies OrgContextResponse);
  });

  router.on(
    "PUT",
    "/v1/orgs/:org/context",
    async (c, caller) => {
      if (caller.kind !== "admin") {
        return c.json(
          apiError("forbidden", "Only the server's admin token sets the org's context layer."),
          403,
        );
      }
      const org = await orgFor(c, caller);
      if (org instanceof Response) return org;
      const body = await readBody(c, setContextBody);
      if (body instanceof Response) return body;
      const source = parsed(c, body.files, `org:${org}`);
      if (source instanceof Response) return source;
      await context.setOrgContext(org, body.files);
      return c.json((await orgContextOf(org)) satisfies OrgContextResponse);
    },
    big,
  );

  router.on(
    "POST",
    "/v1/context/proposals",
    async (c, caller) => {
      if (caller.kind !== "person") {
        return c.json(
          apiError(
            "forbidden",
            "A proposal comes from a person: send it with the person token from selfhost join.",
          ),
          403,
        );
      }
      const body = await readBody(c, proposalBody);
      if (body instanceof Response) return body;
      const team = body.team ?? caller.person.team;
      const refused = await authorize(c, caller, team, "work");
      if (refused) return refused;
      const info = await teams.getTeam(team);
      if (!info) return c.json(apiError("not_found", `No team ${team}`), 404);
      const source = parsed(c, body.files, `personal:${caller.person.id}`);
      if (source instanceof Response) return source;
      const ids = [
        ...source.rules,
        ...source.skills,
        ...source.commands,
        ...source.agents,
        ...source.mcp,
      ].map((item) => `${item.kind}:${item.name}`);
      const ref = parseItemId(body.item);
      if (!ref || ids.length !== 1 || ids[0] !== body.item) {
        return c.json(
          apiError(
            "invalid_context",
            `files: Expected exactly the files of ${body.item}, found ${ids.length === 0 ? "no item" : ids.join(", ")}`,
          ),
          400,
        );
      }
      const org = (await context.getOrgContext(info.org ?? ""))?.files ?? [];
      const current = (await context.getTeamContext(team))?.files ?? [];
      const conflict = taken(ref, body.item, org, current, team);
      if (conflict) return c.json(apiError("item_exists", conflict), 409);

      const at = now();
      const id = uuidv7(at);
      const proposal = await context.addProposal({
        id,
        team,
        person: caller.person.id,
        item: body.item,
        files: body.files,
      });
      const brief = body.files
        .map((file) => `${file.path}:\n\n${file.text}`)
        .join("\n\n")
        .slice(0, BRIEF_CHARS);
      const event: LedgerEvent = {
        id: uuidv7(at),
        schema: EVENT_SCHEMA,
        ts: at.toISOString(),
        source: "server",
        kind: "approval.requested",
        actor: { kind: "person", id: caller.person.id },
        links: { item_id: id },
        data: { request: CONTEXT_PROMOTION_REQUEST, item: body.item, summary: brief },
      };
      await ledger.append([event], { team });
      await refreshReviewList(ledger, listFor(team));
      return c.json(proposal, 201);
    },
    big,
  );
}

/**
 * For the review list's decision route: only an owner or admin of the team answers the review
 * item of a context proposal. undefined for every other item.
 */
export async function refuseContextDecision(
  c: Context,
  ledger: Ledger,
  caller: Caller,
  id: string,
): Promise<Response | undefined> {
  const proposal = await ledger.context.getProposal(id.toLowerCase());
  if (!proposal) return undefined;
  return authorize(c, caller, proposal.team, "policy.write");
}
