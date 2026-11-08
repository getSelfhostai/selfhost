import type { TObject, TSchema } from "@sinclair/typebox";
import { stringify } from "yaml";
import {
  AddPersonRequestSchema,
  AddRepoRequestSchema,
  ApiErrorSchema,
  BudgetQuerySchema,
  BudgetResponseSchema,
  ClaudeCodeHookInputSchema,
  CodexHookInputSchema,
  CodexNotifySchema,
  CreateDecisionRequestSchema,
  CreateDecisionResponseSchema,
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  CreateOrgRequestSchema,
  CreateTeamRequestSchema,
  CreateTeamResponseSchema,
  DecisionQuerySchema,
  DecisionRequestSchema,
  DecisionResponseSchema,
  DecisionsPageSchema,
  EventQuerySchema,
  EventsPageSchema,
  eventVersionsFile,
  HealthResponseSchema,
  IngestEventsErrorSchema,
  IngestEventsRequestSchema,
  IngestEventsResponseSchema,
  InvalidPolicyErrorSchema,
  InviteSchema,
  JoinRequestSchema,
  JoinResponseSchema,
  LedgerEventSchema,
  MCP_TOOLS,
  MCP_TOOLS_SCHEMA,
  MeResponseSchema,
  OrgInfoSchema,
  OrgOverviewSchema,
  OrgPolicyResponseSchema,
  OverviewQuerySchema,
  PersonSchema,
  PolicyCoverageQuerySchema,
  PolicyCoverageResponseSchema,
  PolicyObservedExampleSchema,
  PolicyObservedQuerySchema,
  PolicyObservedResponseSchema,
  PolicyObservedRuleSchema,
  PolicyQuerySchema,
  PolicyResponseSchema,
  ProvenanceAgentRowSchema,
  ProvenanceModuleRowSchema,
  ProvenancePersonRowSchema,
  ProvenanceQuerySchema,
  ProvenanceReportSchema,
  ReceiptSchema,
  ReviewItemConflictSchema,
  ReviewItemQuerySchema,
  ReviewItemSchema,
  ReviewItemsPageSchema,
  RevokeTokensResponseSchema,
  SelfhostConfigSchema,
  SetPolicyRequestSchema,
  SetRoleRequestSchema,
  SnoozeRequestSchema,
  TeamInfoSchema,
  TeamInvitesResponseSchema,
  TeamOverviewSchema,
  TeamPeopleResponseSchema,
  TeamProvenanceModulesSchema,
  TeamProvenanceSchema,
  TeamRepoSchema,
  TeamReposResponseSchema,
  UpdateTeamRequestSchema,
  UsageQuerySchema,
  UsageResponseSchema,
  UsageRowSchema,
  UsageTotalsSchema,
  VendorReportedRowSchema,
} from "../src/index.js";

/** Files generated from the TypeBox sources. The drift test fails when they are stale. */

export interface Artifact {
  path: string;
  content: string;
}

const GENERATED =
  "Generated from packages/schema/src. Run `pnpm --filter @selfhost/schema export` after changing the source. Do not edit by hand.";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Plain JSON copy of a TypeBox schema (drops TypeBox's symbol keys). */
function plain(schema: TSchema): { [key: string]: Json } {
  return JSON.parse(JSON.stringify(schema));
}

function mapNested(node: Json, visit: (obj: { [key: string]: Json }) => Json | undefined): Json {
  if (Array.isArray(node)) return node.map((child) => mapNested(child, visit));
  if (node === null || typeof node !== "object") return node;
  const replaced = visit(node);
  if (replaced !== undefined) return replaced;
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, mapNested(v, visit)]));
}

/** Replaces embedded copies of top-level schemas with a $ref, and drops other nested $ids. */
function withRefs(schema: TSchema, refs: ReadonlyMap<string, string>): { [key: string]: Json } {
  const root = plain(schema);
  return Object.fromEntries(
    Object.entries(root).map(([k, v]) => [
      k,
      mapNested(v, (obj) => {
        const id = obj.$id;
        if (typeof id !== "string") return undefined;
        const ref = refs.get(id);
        if (ref) return { $ref: ref };
        const { $id: _drop, ...rest } = obj;
        return mapNested(rest, () => undefined);
      }),
    ]),
  );
}

function jsonText(value: Json): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const JSON_SCHEMA_FILES: ReadonlyArray<readonly [file: string, schema: TSchema]> = [
  ["event.schema.json", LedgerEventSchema],
  ["config.schema.json", SelfhostConfigSchema],
  ["review-item.schema.json", ReviewItemSchema],
  ["receipt.schema.json", ReceiptSchema],
  ["claude-code-hook.schema.json", ClaudeCodeHookInputSchema],
  ["codex-hook.schema.json", CodexHookInputSchema],
  ["codex-notify.schema.json", CodexNotifySchema],
];

function jsonSchemaFile(schema: TSchema): Json {
  const { $id, ...rest } = withRefs(schema, new Map());
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: schema.$id ?? null,
    $comment: GENERATED,
    ...rest,
  };
}

const COMPONENT_SCHEMAS: ReadonlyArray<readonly [name: string, schema: TSchema]> = [
  ["HealthResponse", HealthResponseSchema],
  ["ApiError", ApiErrorSchema],
  ["IngestEventsRequest", IngestEventsRequestSchema],
  ["IngestEventsResponse", IngestEventsResponseSchema],
  ["IngestEventsError", IngestEventsErrorSchema],
  ["EventsPage", EventsPageSchema],
  ["ReviewItemsPage", ReviewItemsPageSchema],
  ["DecisionRequest", DecisionRequestSchema],
  ["DecisionResponse", DecisionResponseSchema],
  ["SnoozeRequest", SnoozeRequestSchema],
  ["ReviewItemConflict", ReviewItemConflictSchema],
  ["DecisionsPage", DecisionsPageSchema],
  ["CreateDecisionRequest", CreateDecisionRequestSchema],
  ["CreateDecisionResponse", CreateDecisionResponseSchema],
  ["PolicyResponse", PolicyResponseSchema],
  ["PolicyCoverageResponse", PolicyCoverageResponseSchema],
  ["PolicyObservedExample", PolicyObservedExampleSchema],
  ["PolicyObservedRule", PolicyObservedRuleSchema],
  ["PolicyObservedResponse", PolicyObservedResponseSchema],
  ["SetPolicyRequest", SetPolicyRequestSchema],
  ["InvalidPolicyError", InvalidPolicyErrorSchema],
  ["CreateTeamRequest", CreateTeamRequestSchema],
  ["CreateTeamResponse", CreateTeamResponseSchema],
  ["CreateInviteRequest", CreateInviteRequestSchema],
  ["CreateInviteResponse", CreateInviteResponseSchema],
  ["Invite", InviteSchema],
  ["TeamInvitesResponse", TeamInvitesResponseSchema],
  ["RevokeTokensResponse", RevokeTokensResponseSchema],
  ["JoinRequest", JoinRequestSchema],
  ["JoinResponse", JoinResponseSchema],
  ["MeResponse", MeResponseSchema],
  ["TeamInfo", TeamInfoSchema],
  ["Person", PersonSchema],
  ["UpdateTeamRequest", UpdateTeamRequestSchema],
  ["TeamPeopleResponse", TeamPeopleResponseSchema],
  ["AddPersonRequest", AddPersonRequestSchema],
  ["SetRoleRequest", SetRoleRequestSchema],
  ["CreateOrgRequest", CreateOrgRequestSchema],
  ["OrgInfo", OrgInfoSchema],
  ["OrgPolicyResponse", OrgPolicyResponseSchema],
  ["AddRepoRequest", AddRepoRequestSchema],
  ["TeamRepo", TeamRepoSchema],
  ["TeamReposResponse", TeamReposResponseSchema],
  ["BudgetResponse", BudgetResponseSchema],
  ["TeamOverview", TeamOverviewSchema],
  ["OrgOverview", OrgOverviewSchema],
  ["UsageTotals", UsageTotalsSchema],
  ["UsageRow", UsageRowSchema],
  ["UsageResponse", UsageResponseSchema],
  ["ProvenanceAgentRow", ProvenanceAgentRowSchema],
  ["ProvenancePersonRow", ProvenancePersonRowSchema],
  ["ProvenanceModuleRow", ProvenanceModuleRowSchema],
  ["VendorReportedRow", VendorReportedRowSchema],
  ["ProvenanceReport", ProvenanceReportSchema],
  ["TeamProvenance", TeamProvenanceSchema],
  ["TeamProvenanceModules", TeamProvenanceModulesSchema],
];

const ENTITY_REFS = new Map<string, string>([
  [LedgerEventSchema.$id as string, "#/components/schemas/LedgerEvent"],
  [ReviewItemSchema.$id as string, "#/components/schemas/ReviewItem"],
  [SelfhostConfigSchema.$id as string, "#/components/schemas/SelfhostConfig"],
]);

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const jsonContent = (name: string) => ({ "application/json": { schema: ref(name) } });

const errorResponse = (description: string) => ({ description, content: jsonContent("ApiError") });

function queryParameters(schema: TObject): Json[] {
  return Object.entries(schema.properties).map(([name, property]) => {
    const converted = withRefs(property, ENTITY_REFS);
    const { description, ...rest } = converted;
    return {
      name,
      in: "query",
      required: false,
      ...(description === undefined ? {} : { description }),
      schema: rest,
    };
  });
}

const pathParameter = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string" },
});
const formatParameter = {
  name: "format",
  in: "query",
  required: false,
  description:
    "json (default) or text: the same page as plain text, one block per decision with its id and links.",
  schema: { type: "string", enum: ["json", "text"], default: "json" },
};

const teamParameter = {
  name: "team",
  in: "query",
  required: false,
  description:
    "Team id. Needed with the admin token; a person token writes its own team by default, or another team it is in.",
  schema: { type: "string" },
};

const repoParameter = {
  name: "repo",
  in: "query",
  required: false,
  description: "A repo the team owns, as owner/name: set that repo's own rules instead.",
  schema: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
};

/** Who may call a route, from the permission table in src/team.ts. */
const ROLE_NOTE = {
  read: "The admin token, or a person token of anyone in the team.",
  admin: "The admin token, or a person token whose role in the team is owner or admin.",
  owner: "The admin token, or a person token whose role in the team is owner.",
};

const forbiddenResponse = errorResponse(
  "The caller is not in the team, or their role there does not allow this. The message names the role needed and the caller's own.",
);

function openApiDocument(): Json {
  const authErrors = {
    "401": { $ref: "#/components/responses/Unauthorized" },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "selfhost API",
      version: "1",
      description:
        "HTTP API of the selfhost server: ledger ingest and search, the review list, the decision log and team policy. Laptop, self-hosted and hosted installs serve the same API.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/health": {
        get: {
          operationId: "getHealth",
          summary: "Liveness check.",
          security: [],
          responses: {
            "200": { description: "Server is up.", content: jsonContent("HealthResponse") },
          },
        },
      },
      "/v1/events": {
        post: {
          operationId: "ingestEvents",
          summary: "Append a batch of ledger events.",
          description:
            "Atomic: if any event is invalid, nothing is written and the response lists every error by index and field. Events in an older schema version are upgraded to the current one before they are stored, for 12 months after the version that replaced it was released (GET /v1/health lists the accepted versions); an unknown or expired version is an error on schema. Event ids are idempotency keys, so retrying a batch is safe. With a person token, events whose actor is a person must carry that person's id (an event with no actor gets it), system actors are refused, and team is set to the person's team.",
          requestBody: { required: true, content: jsonContent("IngestEventsRequest") },
          responses: {
            "200": {
              description: "All events stored.",
              content: jsonContent("IngestEventsResponse"),
            },
            "400": {
              description: "At least one event is invalid. Nothing was written.",
              content: jsonContent("IngestEventsError"),
            },
            ...authErrors,
            "413": errorResponse("More than 1000 events in one batch."),
          },
        },
        get: {
          operationId: "listEvents",
          summary: "Search ledger events.",
          description:
            "With a person token, only events written with that team's person tokens: the team filter is the token's team.",
          parameters: queryParameters(EventQuerySchema),
          responses: {
            "200": { description: "One page of events.", content: jsonContent("EventsPage") },
            "400": errorResponse("Invalid filter."),
            ...authErrors,
            "403": errorResponse("A person token asked for another team's events."),
          },
        },
      },
      "/v1/review-items": {
        get: {
          operationId: "listReviewItems",
          summary: "List review items, ranked.",
          description:
            "Blocking items first, then by risk score, then oldest first, then by id; snoozed items after the rest until their snooze ends. With a person token, only items built from that team's events.",
          parameters: queryParameters(ReviewItemQuerySchema),
          responses: {
            "200": { description: "One page of items.", content: jsonContent("ReviewItemsPage") },
            "400": errorResponse("Invalid filter."),
            ...authErrors,
            "403": errorResponse("A person token asked for another team's items."),
          },
        },
      },
      "/v1/review-items/{id}": {
        get: {
          operationId: "getReviewItem",
          summary: "Open one review item.",
          parameters: [pathParameter("id", "Review item id.")],
          responses: {
            "200": { description: "The item.", content: jsonContent("ReviewItem") },
            ...authErrors,
            "404": errorResponse("No such review item."),
          },
        },
      },
      "/v1/review-items/{id}/decision": {
        post: {
          operationId: "recordDecision",
          summary: "Answer a review item.",
          description:
            "Writes a decision.recorded event, attributed to the person the token belongs to (with the admin token, to by), and closes the item. Every surface reads the same list, so the next read anywhere shows the answer.",
          parameters: [pathParameter("id", "Review item id.")],
          requestBody: { required: true, content: jsonContent("DecisionRequest") },
          responses: {
            "200": { description: "Decision recorded.", content: jsonContent("DecisionResponse") },
            "400": errorResponse("Invalid decision."),
            ...authErrors,
            "404": errorResponse("No such review item."),
            "409": {
              description: "The item is no longer open. Nothing was written.",
              content: jsonContent("ReviewItemConflict"),
            },
          },
        },
      },
      "/v1/review-items/{id}/snooze": {
        post: {
          operationId: "snoozeReviewItem",
          summary: "Snooze a review item.",
          description:
            "Ranks the item after the rest until the given time. It stays open, and a blocking approval still times out at its deadline.",
          parameters: [pathParameter("id", "Review item id.")],
          requestBody: { required: true, content: jsonContent("SnoozeRequest") },
          responses: {
            "200": { description: "The snoozed item.", content: jsonContent("ReviewItem") },
            "400": errorResponse("Invalid snooze."),
            ...authErrors,
            "404": errorResponse("No such review item."),
            "409": {
              description: "The item is no longer open.",
              content: jsonContent("ReviewItemConflict"),
            },
          },
        },
      },
      "/v1/decisions": {
        get: {
          operationId: "listDecisions",
          summary: "Search human decisions and rule verdicts.",
          description:
            "decision.recorded and policy.evaluated events, newest first. path matches a file, the files under a folder and the folders that hold it; topic needs every word in the question or reason. The MCP tool search_decisions makes the same call.",
          parameters: [...queryParameters(DecisionQuerySchema), formatParameter],
          responses: {
            "200": {
              description: "One page of decisions.",
              content: {
                ...jsonContent("DecisionsPage"),
                "text/plain": { schema: { type: "string" } },
              },
            },
            "400": errorResponse("Invalid filter."),
            ...authErrors,
          },
        },
        post: {
          operationId: "createDecision",
          summary: "Record a human decision.",
          description:
            "Every surface records decisions through this call: GitHub reviews and comments on agent pull requests, rule promotions, exception approvals, the CLI inbox, and Slack and Telegram buttons. Writes one decision.recorded event. Decisions are never edited: to correct or overturn one, record a new decision with replaces_event_id. With key and ts, sending the same action again returns the stored decision with duplicate true. Needs the admin token.",
          requestBody: { required: true, content: jsonContent("CreateDecisionRequest") },
          responses: {
            "201": {
              description: "Decision recorded.",
              content: jsonContent("CreateDecisionResponse"),
            },
            "200": {
              description: "This action was already recorded. Nothing new was written.",
              content: jsonContent("CreateDecisionResponse"),
            },
            "400": errorResponse(
              "Invalid decision, or replaces_event_id names no decision. Nothing was written.",
            ),
            ...authErrors,
          },
        },
      },
      "/v1/policy": {
        get: {
          operationId: "getPolicy",
          summary: "Get the team config in use and the rules that apply.",
          description: `${ROLE_NOTE.read} The config in use is the org floor, then the team's selfhost.toml, then with repo the repo's own rules; layers says which. With one layer text is that file as it was set.`,
          parameters: queryParameters(PolicyQuerySchema),
          responses: {
            "200": { description: "Policy in use.", content: jsonContent("PolicyResponse") },
            "400": errorResponse("Invalid query, or no team given with the admin token."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse(
              "No such team, the team does not own the repo, or neither the team nor its org has a policy yet.",
            ),
          },
        },
        put: {
          operationId: "setPolicy",
          summary: "Replace a team's selfhost.toml, or the rules of one of its repos.",
          description: `${ROLE_NOTE.admin} The text is validated first, like selfhost doctor, then against the org floor: a field that would relax an org rule (a lower mode, ask where the org blocks, fewer agents, another match, an allow list that widens, a guardrail the org keeps on) fails and names the org rule in org_rule. Teams and repos can add rules and tighten the org's. An invalid file changes nothing.`,
          parameters: [teamParameter, repoParameter],
          requestBody: { required: true, content: jsonContent("SetPolicyRequest") },
          responses: {
            "200": { description: "Policy stored.", content: jsonContent("PolicyResponse") },
            "400": {
              description:
                "The selfhost.toml is invalid or relaxes the org floor. Nothing was stored.",
              content: jsonContent("InvalidPolicyError"),
            },
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team, or the team does not own the repo."),
          },
        },
      },
      "/v1/policy/coverage": {
        get: {
          operationId: "getPolicyCoverage",
          summary: "Get what each vendor's native controls cover of the team's rules.",
          description:
            "Compiles the team's selfhost.toml the way selfhost policy compile does and returns the coverage of every rule per vendor: compiled, partial, not_expressible or not_applicable, and whether the selfhost hook covers the rest.",
          parameters: queryParameters(PolicyCoverageQuerySchema),
          responses: {
            "200": {
              description: "Coverage per rule and vendor.",
              content: jsonContent("PolicyCoverageResponse"),
            },
            "400": errorResponse("Invalid query, or no team given with the admin token."),
            ...authErrors,
            "403": errorResponse("A person token asked for another team's policy."),
            "404": errorResponse("No such team, or the team has no policy yet."),
          },
        },
      },
      "/v1/policy/observed": {
        get: {
          operationId: "getPolicyObserved",
          summary: "Get what each rule and guardrail of a team blocked or would have blocked.",
          description: `${ROLE_NOTE.read} Reads the team's policy.evaluated events in the window (default the last 7 days): per rule, guardrail and allow list, the observe-mode hits (what it would have blocked or sent to a person, one per tool call, with the most frequent calls and likely false positives as in the weekly policy report) and the enforce-mode verdicts (what it blocked or sent to a person), with the rule's mode in the team's policy now. At most the newest 20,000 verdicts are read.`,
          parameters: queryParameters(PolicyObservedQuerySchema),
          responses: {
            "200": {
              description: "Hits and verdicts per rule.",
              content: jsonContent("PolicyObservedResponse"),
            },
            "400": errorResponse(
              "Invalid query or time range, or no team given with the admin token.",
            ),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
          },
        },
      },
      "/v1/teams": {
        post: {
          operationId: "createTeam",
          summary: "Create a team and its invite code.",
          description:
            "Admin token only. The team goes in org (default: default). The first person to join with its invite is its owner.",
          requestBody: { required: true, content: jsonContent("CreateTeamRequest") },
          responses: {
            "201": { description: "Team created.", content: jsonContent("CreateTeamResponse") },
            "400": errorResponse("Invalid name or invite lifetime."),
            ...authErrors,
            "404": errorResponse("No such org."),
            "409": errorResponse("A team with this id already exists."),
          },
        },
      },
      "/v1/teams/{team}": {
        patch: {
          operationId: "updateTeam",
          summary: "Rename a team.",
          description: `${ROLE_NOTE.admin} The id stays the same.`,
          parameters: [pathParameter("team", "Team id.")],
          requestBody: { required: true, content: jsonContent("UpdateTeamRequest") },
          responses: {
            "200": { description: "The team.", content: jsonContent("TeamInfo") },
            "400": errorResponse("Invalid name."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
          },
        },
      },
      "/v1/teams/{team}/people": {
        get: {
          operationId: "listTeamPeople",
          summary: "List the people in a team and their roles.",
          description: ROLE_NOTE.read,
          parameters: [pathParameter("team", "Team id.")],
          responses: {
            "200": { description: "The people.", content: jsonContent("TeamPeopleResponse") },
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
          },
        },
        post: {
          operationId: "addTeamPerson",
          summary: "Add someone already in another team of the org.",
          description: `${ROLE_NOTE.admin} Adding someone as admin or owner needs an owner. The tokens they hold work in this team from then on. People new to the org join with an invite instead.`,
          parameters: [pathParameter("team", "Team id.")],
          requestBody: { required: true, content: jsonContent("AddPersonRequest") },
          responses: {
            "201": { description: "Added.", content: jsonContent("Person") },
            "400": errorResponse("Invalid body."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team, or the person is in no team of its org."),
            "409": errorResponse("The person is in the team already."),
          },
        },
      },
      "/v1/teams/{team}/people/{person}/role": {
        put: {
          operationId: "setTeamRole",
          summary: "Change a person's role in a team.",
          description: `${ROLE_NOTE.owner} Every person has exactly one role per team, and a team always keeps an owner.`,
          parameters: [pathParameter("team", "Team id."), pathParameter("person", "Person id.")],
          requestBody: { required: true, content: jsonContent("SetRoleRequest") },
          responses: {
            "200": { description: "The person with the new role.", content: jsonContent("Person") },
            "400": errorResponse("Invalid role."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such person in the team."),
            "409": errorResponse("The change would leave the team with no owner."),
          },
        },
      },
      "/v1/teams/{team}/repos": {
        get: {
          operationId: "listTeamRepos",
          summary: "List the repos a team owns.",
          description: ROLE_NOTE.read,
          parameters: [pathParameter("team", "Team id.")],
          responses: {
            "200": { description: "The repos.", content: jsonContent("TeamReposResponse") },
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
          },
        },
        post: {
          operationId: "addTeamRepo",
          summary: "Give a repo to a team, by its remote URL.",
          description: `${ROLE_NOTE.admin} Every run in the repo is the team's from then on: events that name the repo, and events of a run (session) once any of its events names it, go to the team for its people, review list, spend and budget.`,
          parameters: [pathParameter("team", "Team id.")],
          requestBody: { required: true, content: jsonContent("AddRepoRequest") },
          responses: {
            "201": { description: "The repo.", content: jsonContent("TeamRepo") },
            "400": errorResponse("Not a remote URL or owner/name."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
            "409": errorResponse("Another team of the org owns the repo."),
          },
        },
      },
      "/v1/teams/{team}/repos/{owner}/{name}": {
        delete: {
          operationId: "removeTeamRepo",
          summary: "Take a repo back from a team.",
          description: `${ROLE_NOTE.admin} Events already written keep their team.`,
          parameters: [
            pathParameter("team", "Team id."),
            pathParameter("owner", "Repo owner."),
            pathParameter("name", "Repo name."),
          ],
          responses: {
            "200": {
              description: "The team's repos now.",
              content: jsonContent("TeamReposResponse"),
            },
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("The team does not own the repo."),
          },
        },
      },
      "/v1/teams/{team}/overview": {
        get: {
          operationId: "getTeamOverview",
          summary: "One team's dashboard: spend, budget, people, repos and review list.",
          description: ROLE_NOTE.read,
          parameters: [pathParameter("team", "Team id."), ...queryParameters(OverviewQuerySchema)],
          responses: {
            "200": { description: "The overview.", content: jsonContent("TeamOverview") },
            "400": errorResponse("Invalid time range."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
          },
        },
      },
      "/v1/teams/{team}/provenance": {
        get: {
          operationId: "getTeamProvenance",
          summary:
            "Lines merged by agent, model, person and module in each repo of a team, with revert and rework rates.",
          description: `${ROLE_NOTE.read} Computed on read. For a repo the server has a clone of (SELFHOST_GIT_CLONES, as <owner>/<name>), every non-blank line merged to the main branch in the range is traced with git blame to the commit that wrote it, joined to the agent run the ledger recorded for that commit (else the commit's own attribution, else its merged pull request), and followed for [review] revert_window_days: lines a later commit changed or deleted are reworked (fix-forward edits count), lines a revert took out are reverted. A repo with no clone is ledger_only: lines from its pr.merged events, no modules, no rates. Modules and the threshold come from [review] in the team's policy.`,
          parameters: [
            pathParameter("team", "Team id."),
            ...queryParameters(ProvenanceQuerySchema),
          ],
          responses: {
            "200": { description: "One report per repo.", content: jsonContent("TeamProvenance") },
            "400": errorResponse("Invalid time range."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team, or the team does not own the repo."),
          },
        },
      },
      "/v1/teams/{team}/provenance/modules": {
        get: {
          operationId: "getTeamProvenanceModules",
          summary: "A team's modules ranked by agent-written lines, across its repos.",
          description: `${ROLE_NOTE.read} The modules of every repo with a clone, from the same reports as /v1/teams/{team}/provenance. above_threshold marks the modules whose agent lines were reverted or reworked above [review] revert_rate_threshold; new pull requests that touch them score higher risk.`,
          parameters: [
            pathParameter("team", "Team id."),
            ...queryParameters(ProvenanceQuerySchema),
          ],
          responses: {
            "200": {
              description: "The ranking.",
              content: jsonContent("TeamProvenanceModules"),
            },
            "400": errorResponse("Invalid time range."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team, or the team does not own the repo."),
          },
        },
      },
      "/v1/budget": {
        get: {
          operationId: "getBudget",
          summary: "Spend so far against a team's budget, with a forecast.",
          description: `${ROLE_NOTE.read} The budget is [budget] in the team's selfhost.toml. Nothing is charged back or stopped. The MCP tool get_budget makes the same call.`,
          parameters: queryParameters(BudgetQuerySchema),
          responses: {
            "200": { description: "The budget.", content: jsonContent("BudgetResponse") },
            "400": errorResponse("Invalid query, or no team given with the admin token."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
          },
        },
      },
      "/v1/orgs": {
        post: {
          operationId: "createOrg",
          summary: "Create an org.",
          description:
            "Admin token only. Teams go in it with POST /v1/teams and org. Every team created without one is in the org default.",
          requestBody: { required: true, content: jsonContent("CreateOrgRequest") },
          responses: {
            "201": { description: "Org created.", content: jsonContent("OrgInfo") },
            "400": errorResponse("Invalid name."),
            ...authErrors,
            "409": errorResponse("An org with this id already exists."),
          },
        },
      },
      "/v1/orgs/{org}/policy": {
        get: {
          operationId: "getOrgPolicy",
          summary: "Get the org floor: the selfhost.toml every team and repo builds on.",
          description:
            "The admin token, or a person token of anyone in the org. conflicts lists stored team and repo rules that relax it.",
          parameters: [pathParameter("org", "Org id.")],
          responses: {
            "200": { description: "The org policy.", content: jsonContent("OrgPolicyResponse") },
            ...authErrors,
            "403": errorResponse("A person token of another org."),
            "404": errorResponse("No such org, or it has no policy yet."),
          },
        },
        put: {
          operationId: "setOrgPolicy",
          summary: "Replace the org floor.",
          description:
            "Admin token only. Every team's and repo's policy builds on it: they can add rules and tighten its own, never relax them. Stored team and repo rules that relax the new floor are listed in conflicts, and the org's value applies to them until they are changed.",
          parameters: [pathParameter("org", "Org id.")],
          requestBody: { required: true, content: jsonContent("SetPolicyRequest") },
          responses: {
            "200": { description: "Stored.", content: jsonContent("OrgPolicyResponse") },
            "400": {
              description: "The selfhost.toml is invalid. Nothing was stored.",
              content: jsonContent("InvalidPolicyError"),
            },
            ...authErrors,
            "403": errorResponse("Not the admin token."),
            "404": errorResponse("No such org."),
          },
        },
      },
      "/v1/orgs/{org}/overview": {
        get: {
          operationId: "getOrgOverview",
          summary: "The cross-team view for the lead.",
          description:
            "Every team of the org with the admin token; with a person token, the teams where the person is owner or admin. The org's [budget] is shown to whoever sees every team. Nothing is charged back.",
          parameters: [pathParameter("org", "Org id."), ...queryParameters(OverviewQuerySchema)],
          responses: {
            "200": { description: "The overview.", content: jsonContent("OrgOverview") },
            "400": errorResponse("Invalid time range."),
            ...authErrors,
            "403": errorResponse("A person token of another org, or one that leads no team of it."),
            "404": errorResponse("No such org."),
          },
        },
      },
      "/v1/usage": {
        get: {
          operationId: "getUsage",
          summary: "Tokens, cost, sessions and pull requests, grouped and filtered.",
          description:
            "What the console shows. Every filter applies to every row and to the total, from the ledger's events whatever source wrote them. The admin token sees every team of the org and events with no team; a person token sees the teams of its org it is in. A team filter for a team the caller is not in answers 403.",
          parameters: queryParameters(UsageQuerySchema),
          responses: {
            "200": {
              description: "The rows and the total.",
              content: jsonContent("UsageResponse"),
            },
            "400": errorResponse("Invalid query or time range."),
            ...authErrors,
            "403": errorResponse("The caller is not in the team or the org asked for."),
          },
        },
      },
      "/v1/usage.csv": {
        get: {
          operationId: "getUsageCsv",
          summary: "The same rows as GET /v1/usage, as CSV.",
          description:
            "One line per row of GET /v1/usage for the same query, after a header line: the grouped dimensions, then usd, tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, requests, sessions, prs_opened and prs_merged. Text that a spreadsheet would read as a formula starts with an apostrophe.",
          parameters: queryParameters(UsageQuerySchema),
          responses: {
            "200": {
              description: "The rows as CSV.",
              content: { "text/csv": { schema: { type: "string" } } },
            },
            "400": errorResponse("Invalid query or time range."),
            ...authErrors,
            "403": errorResponse("The caller is not in the team or the org asked for."),
          },
        },
      },
      "/v1/teams/{team}/invites": {
        get: {
          operationId: "listInvites",
          summary: "List a team's open invites.",
          description: `${ROLE_NOTE.admin} Invites that still work, newest first: not revoked and not expired. The codes themselves are never stored, so only their ids are listed.`,
          parameters: [pathParameter("team", "Team id.")],
          responses: {
            "200": {
              description: "The open invites.",
              content: jsonContent("TeamInvitesResponse"),
            },
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
          },
        },
        post: {
          operationId: "createInvite",
          summary: "Create another invite code for a team.",
          description: `${ROLE_NOTE.admin} The invite expires after ttl_seconds (default 7 days). With an email, only that person can join with it, and their person id is the email.`,
          parameters: [pathParameter("team", "Team id.")],
          requestBody: { required: true, content: jsonContent("CreateInviteRequest") },
          responses: {
            "201": { description: "Invite created.", content: jsonContent("CreateInviteResponse") },
            "400": errorResponse("Invalid lifetime or email."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
          },
        },
      },
      "/v1/invites/{id}": {
        delete: {
          operationId: "revokeInvite",
          summary: "Revoke an invite code.",
          description: `${ROLE_NOTE.admin} Joining with a revoked invite answers 401. People who already joined keep their tokens. Revoking twice is not an error.`,
          parameters: [pathParameter("id", "sha256 of the invite code, in hex.")],
          responses: {
            "200": { description: "Invite revoked.", content: jsonContent("Invite") },
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such invite."),
          },
        },
      },
      "/v1/teams/{team}/people/{person}/tokens": {
        delete: {
          operationId: "revokePersonTokens",
          summary: "Revoke every token a person holds.",
          description: `${ROLE_NOTE.admin} Revoking an owner needs an owner; anyone can revoke their own. The person's events stay in the ledger; their tokens answer 401 from now on. They can join again only with a new invite.`,
          parameters: [pathParameter("team", "Team id."), pathParameter("person", "Person id.")],
          responses: {
            "200": {
              description: "Tokens revoked.",
              content: jsonContent("RevokeTokensResponse"),
            },
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team or person."),
          },
        },
      },
      "/v1/join": {
        post: {
          operationId: "joinTeam",
          summary: "Exchange an invite code for a person token.",
          description:
            "The invite code is the credential, so no bearer token is needed. A team-wide invite only adds people new to the org: a person id already in any team of the org (compared ignoring case) is refused, so the holder cannot take over the owner's or anyone else's identity, which acts in every team of the org it is in. An invite for an email joins only that person, also when they are already in the team, which adds another token for them.",
          security: [],
          requestBody: { required: true, content: jsonContent("JoinRequest") },
          responses: {
            "200": { description: "Joined.", content: jsonContent("JoinResponse") },
            "400": errorResponse("Invalid body."),
            "401": errorResponse(
              "Unknown, expired or revoked invite code, or an invite for another person.",
            ),
          },
        },
      },
      "/v1/me": {
        get: {
          operationId: "getMe",
          summary: "Who the bearer token belongs to, their role and what it allows.",
          description:
            "For a person token: the person, their team, their role there, the actions the permission table gives that role (the console offers only these), and every team of the org they are in.",
          responses: {
            "200": { description: "The token's owner.", content: jsonContent("MeResponse") },
            ...authErrors,
          },
        },
      },
      "/v1/me/token": {
        delete: {
          operationId: "revokeOwnToken",
          summary: "Revoke the person token that makes this request.",
          description:
            "What selfhost team leave calls. Only that token is revoked; the person's other tokens and their events stay.",
          responses: {
            "200": {
              description: "Token revoked.",
              content: jsonContent("RevokeTokensResponse"),
            },
            ...authErrors,
            "403": errorResponse(
              "The admin token is set on the server and cannot be revoked here.",
            ),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "API token from the selfhost server.",
        },
      },
      responses: {
        Unauthorized: errorResponse("Missing or invalid bearer token."),
      },
      schemas: {
        LedgerEvent: { $ref: "./json/event.schema.json" },
        ReviewItem: { $ref: "./json/review-item.schema.json" },
        SelfhostConfig: { $ref: "./json/config.schema.json" },
        ...Object.fromEntries(
          COMPONENT_SCHEMAS.map(([name, schema]) => [name, withRefs(schema, ENTITY_REFS)]),
        ),
      },
    },
  };
}

function mcpTools(): Json {
  return {
    $comment: GENERATED,
    schema: MCP_TOOLS_SCHEMA,
    tools: MCP_TOOLS.map((tool) => {
      const { title: _inTitle, ...inputSchema } = withRefs(tool.inputSchema, new Map());
      const { title: _outTitle, ...outputSchema } = withRefs(tool.outputSchema, new Map());
      return {
        name: tool.name,
        description: tool.description,
        annotations: { readOnlyHint: tool.readOnly },
        inputSchema,
        outputSchema,
      };
    }),
  };
}

export function buildArtifacts(): Artifact[] {
  return [
    ...JSON_SCHEMA_FILES.map(([file, schema]) => ({
      path: `json/${file}`,
      content: jsonText(jsonSchemaFile(schema)),
    })),
    {
      path: "openapi.yaml",
      content: `# ${GENERATED}\n${stringify(openApiDocument(), { lineWidth: 0, aliasDuplicateObjects: false })}`,
    },
    { path: "mcp-tools.json", content: jsonText(mcpTools()) },
    { path: "event-versions.json", content: jsonText(eventVersionsFile()) },
  ];
}
