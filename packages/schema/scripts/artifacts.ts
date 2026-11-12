import type { TObject, TSchema } from "@sinclair/typebox";
import { stringify } from "yaml";
import {
  AddNotifyTargetRequestSchema,
  AddPersonRequestSchema,
  AddRepoRequestSchema,
  ApiErrorSchema,
  BackgroundRunSchema,
  BackgroundRunsQuerySchema,
  BackgroundRunsResponseSchema,
  BudgetQuerySchema,
  BudgetResponseSchema,
  ClaudeCodeHookInputSchema,
  CodexHookInputSchema,
  CodexNotifySchema,
  ContextConflictSchema,
  ContextFileSchema,
  ContextLayerSchema,
  ContextProposalRequestSchema,
  ContextProposalSchema,
  ContextResponseSchema,
  CreateDecisionRequestSchema,
  CreateDecisionResponseSchema,
  CreateHandoffRequestSchema,
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
  ExceptionGrantSchema,
  ExceptionGrantStatusSchema,
  ExceptionGrantUseRequestSchema,
  ExceptionKeySchema,
  ExceptionKeysResponseSchema,
  eventVersionsFile,
  GatewayKeysResponseSchema,
  GatewayStatusSchema,
  GatewaySyncReportSchema,
  HandoffItemSchema,
  HandoffQuerySchema,
  HandoffSchema,
  HandoffsResponseSchema,
  HandoffTranscriptInfoSchema,
  HandoffTurnSchema,
  HealthResponseSchema,
  INTEGRATION_KINDS,
  IngestEventsErrorSchema,
  IngestEventsRequestSchema,
  IngestEventsResponseSchema,
  IntegrationStateSchema,
  IntegrationsQuerySchema,
  IntegrationsResponseSchema,
  InvalidPolicyErrorSchema,
  InviteSchema,
  IssueGatewayKeyRequestSchema,
  IssueGatewayKeyResponseSchema,
  JoinRequestSchema,
  JoinResponseSchema,
  KillRequestSchema,
  KillResponseSchema,
  LaptopHeartbeatSchema,
  LaptopManagedSchema,
  LaptopRowSchema,
  LaptopsQuerySchema,
  LedgerEventSchema,
  MCP_TOOLS,
  MCP_TOOLS_SCHEMA,
  MeResponseSchema,
  NotifySendSchema,
  NotifySendsResponseSchema,
  NotifySettingsSchema,
  NotifyTargetSchema,
  NotifyTestRequestSchema,
  NotifyTestResponseSchema,
  OrgContextResponseSchema,
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
  PresenceOverlapSchema,
  PresenceQuerySchema,
  PresenceResponseSchema,
  PresenceRunSchema,
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
  RoiAgentRowSchema,
  RoiBaselineSchema,
  RoiQuerySchema,
  RoiResponseSchema,
  RunHandoffSchema,
  RunPullRequestSchema,
  RunQuerySchema,
  RunResponseSchema,
  RunShareRequestSchema,
  RunShareResponseSchema,
  RunSummarySchema,
  SandboxLeftoverSchema,
  SandboxRecordSchema,
  SandboxRuntimeWasteSchema,
  SandboxRunWasteSchema,
  SandboxSizeSchema,
  SandboxSuggestionSchema,
  SandboxWasteQuerySchema,
  SandboxWasteResponseSchema,
  SandboxWasteWindowSchema,
  SelfhostConfigSchema,
  SetContextRequestSchema,
  SetIntegrationRequestSchema,
  SetNotifyDigestRequestSchema,
  SetPolicyRequestSchema,
  SetRoleRequestSchema,
  SnoozeRequestSchema,
  StartRunRequestSchema,
  TailQuerySchema,
  TailResponseSchema,
  TakeoverResponseSchema,
  TeamInfoSchema,
  TeamInvitesResponseSchema,
  TeamLaptopsResponseSchema,
  TeamOverviewSchema,
  TeamPeopleResponseSchema,
  TeamProvenanceModulesSchema,
  TeamProvenanceSchema,
  TeamRepoSchema,
  TeamReposResponseSchema,
  TranscriptUploadSchema,
  UpdateTeamRequestSchema,
  UsageQuerySchema,
  UsageResponseSchema,
  UsageRowSchema,
  UsageTotalsSchema,
  VendorReportedRowSchema,
  WebhookRunRequestSchema,
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
  ["IntegrationState", IntegrationStateSchema],
  ["IntegrationsResponse", IntegrationsResponseSchema],
  ["SetIntegrationRequest", SetIntegrationRequestSchema],
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
  ["ExceptionGrant", ExceptionGrantSchema],
  ["ExceptionGrantStatus", ExceptionGrantStatusSchema],
  ["ExceptionGrantUseRequest", ExceptionGrantUseRequestSchema],
  ["ExceptionKey", ExceptionKeySchema],
  ["ExceptionKeysResponse", ExceptionKeysResponseSchema],
  ["LaptopHeartbeat", LaptopHeartbeatSchema],
  ["LaptopManaged", LaptopManagedSchema],
  ["LaptopRow", LaptopRowSchema],
  ["TeamLaptopsResponse", TeamLaptopsResponseSchema],
  ["AddPersonRequest", AddPersonRequestSchema],
  ["SetRoleRequest", SetRoleRequestSchema],
  ["CreateOrgRequest", CreateOrgRequestSchema],
  ["OrgInfo", OrgInfoSchema],
  ["OrgPolicyResponse", OrgPolicyResponseSchema],
  ["ContextFile", ContextFileSchema],
  ["SetContextRequest", SetContextRequestSchema],
  ["ContextLayer", ContextLayerSchema],
  ["ContextConflict", ContextConflictSchema],
  ["ContextProposal", ContextProposalSchema],
  ["ContextProposalRequest", ContextProposalRequestSchema],
  ["ContextResponse", ContextResponseSchema],
  ["OrgContextResponse", OrgContextResponseSchema],
  ["AddRepoRequest", AddRepoRequestSchema],
  ["TeamRepo", TeamRepoSchema],
  ["TeamReposResponse", TeamReposResponseSchema],
  ["BudgetResponse", BudgetResponseSchema],
  ["GatewayStatus", GatewayStatusSchema],
  ["GatewayKeysResponse", GatewayKeysResponseSchema],
  ["IssueGatewayKeyRequest", IssueGatewayKeyRequestSchema],
  ["IssueGatewayKeyResponse", IssueGatewayKeyResponseSchema],
  ["GatewaySyncReport", GatewaySyncReportSchema],
  ["TeamOverview", TeamOverviewSchema],
  ["OrgOverview", OrgOverviewSchema],
  ["UsageTotals", UsageTotalsSchema],
  ["UsageRow", UsageRowSchema],
  ["UsageResponse", UsageResponseSchema],
  ["RoiAgentRow", RoiAgentRowSchema],
  ["RoiBaseline", RoiBaselineSchema],
  ["RoiResponse", RoiResponseSchema],
  ["SandboxSize", SandboxSizeSchema],
  ["SandboxRecord", SandboxRecordSchema],
  ["SandboxSuggestion", SandboxSuggestionSchema],
  ["SandboxRuntimeWaste", SandboxRuntimeWasteSchema],
  ["SandboxWasteWindow", SandboxWasteWindowSchema],
  ["SandboxLeftover", SandboxLeftoverSchema],
  ["SandboxRunWaste", SandboxRunWasteSchema],
  ["SandboxWasteResponse", SandboxWasteResponseSchema],
  ["ProvenanceAgentRow", ProvenanceAgentRowSchema],
  ["ProvenancePersonRow", ProvenancePersonRowSchema],
  ["ProvenanceModuleRow", ProvenanceModuleRowSchema],
  ["VendorReportedRow", VendorReportedRowSchema],
  ["ProvenanceReport", ProvenanceReportSchema],
  ["TeamProvenance", TeamProvenanceSchema],
  ["TeamProvenanceModules", TeamProvenanceModulesSchema],
  ["RunSummary", RunSummarySchema],
  ["RunPullRequest", RunPullRequestSchema],
  ["RunHandoff", RunHandoffSchema],
  ["RunResponse", RunResponseSchema],
  ["RunShareRequest", RunShareRequestSchema],
  ["RunShareResponse", RunShareResponseSchema],
  ["HandoffTurn", HandoffTurnSchema],
  ["HandoffItem", HandoffItemSchema],
  ["HandoffTranscriptInfo", HandoffTranscriptInfoSchema],
  ["Handoff", HandoffSchema],
  ["TranscriptUpload", TranscriptUploadSchema],
  ["CreateHandoffRequest", CreateHandoffRequestSchema],
  ["HandoffsResponse", HandoffsResponseSchema],
  ["TakeoverResponse", TakeoverResponseSchema],
  ["TailResponse", TailResponseSchema],
  ["PresenceRun", PresenceRunSchema],
  ["PresenceOverlap", PresenceOverlapSchema],
  ["PresenceResponse", PresenceResponseSchema],
  ["BackgroundRun", BackgroundRunSchema],
  ["BackgroundRunsResponse", BackgroundRunsResponseSchema],
  ["StartRunRequest", StartRunRequestSchema],
  ["WebhookRunRequest", WebhookRunRequestSchema],
  ["KillRequest", KillRequestSchema],
  ["KillResponse", KillResponseSchema],
  ["NotifyTarget", NotifyTargetSchema],
  ["NotifySettings", NotifySettingsSchema],
  ["AddNotifyTargetRequest", AddNotifyTargetRequestSchema],
  ["SetNotifyDigestRequest", SetNotifyDigestRequestSchema],
  ["NotifyTestRequest", NotifyTestRequestSchema],
  ["NotifySend", NotifySendSchema],
  ["NotifyTestResponse", NotifyTestResponseSchema],
  ["NotifySendsResponse", NotifySendsResponseSchema],
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

const PERSON_NOTE =
  "A person token only: each person sets their own notifications. The admin token has none and gets 404.";

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
      "/v1/exception-keys": {
        get: {
          operationId: "getExceptionKeys",
          summary: "List the public keys one-time exception grants are signed with.",
          description:
            "Either token. The server makes an Ed25519 key on first start and keeps it next to its API token; the private key never leaves the server. Laptops pin these keys at join and on every sync (and in the root-owned managed settings when those are installed) and accept only grants that verify with one of them.",
          responses: {
            "200": { description: "The keys.", content: jsonContent("ExceptionKeysResponse") },
            ...authErrors,
          },
        },
      },
      "/v1/exception-keys/rotate": {
        post: {
          operationId: "rotateExceptionKey",
          summary: "Add a signing key and sign new grants with it.",
          description:
            "Admin token only. The older keys stay listed, so grants they signed still verify until they expire. Laptops pin the new key on their next sync; where the managed settings hold the pin, the admin command the sync prints installs it there.",
          responses: {
            "200": { description: "The keys now.", content: jsonContent("ExceptionKeysResponse") },
            ...authErrors,
          },
        },
      },
      "/v1/exception-grants/{id}": {
        get: {
          operationId: "getExceptionGrant",
          summary: "Fetch the signed grant for one of your exceptions.",
          description:
            "Person token of the person whose agent was blocked. Once a person the team allows approved the exception, the server signs a grant binding the exception id, a nonce, the call's fingerprint and rules, the session, the repository, the requester, the approver and the expiry, keeps it, and returns the same grant on every fetch until a laptop reports it used.",
          parameters: [pathParameter("id", "Exception id: the review item the block named.")],
          responses: {
            "200": {
              description: "Where the exception stands, with the grant once approved.",
              content: jsonContent("ExceptionGrantStatus"),
            },
            ...authErrors,
            "404": errorResponse("No such exception on the list yet."),
          },
        },
      },
      "/v1/exception-grants/{id}/use": {
        post: {
          operationId: "reportExceptionGrantUse",
          summary: "Report that a grant was used.",
          description:
            "Person token of the requester. Marks the grant used, so the server hands it out no more. Laptops send it on the sync after the hook used the grant; best effort, since the hook checks grants offline.",
          parameters: [pathParameter("id", "Exception id.")],
          requestBody: { required: true, content: jsonContent("ExceptionGrantUseRequest") },
          responses: {
            "200": { description: "Marked used.", content: jsonContent("ExceptionGrantStatus") },
            "400": errorResponse("Invalid request."),
            ...authErrors,
            "404": errorResponse("No grant was issued for this exception."),
            "409": errorResponse("The nonce is not this grant's."),
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
      "/v1/context": {
        get: {
          operationId: "getContext",
          summary: "Get the team's context layers: the org's and the team's own.",
          description: `${ROLE_NOTE.read} The org and team layers of .selfhost/context items (rules, skills, commands, subagents, MCP servers) every member's laptop pulls on sync and merges with the repository's own and the person's, in the order org, team, repo, personal. On a conflict the earlier layer's item is used, so the org's always wins; conflicts lists the team items the org layer replaces. Reading also applies the team's proposals whose review items an owner or admin approved.`,
          parameters: [teamParameter],
          responses: {
            "200": { description: "The layers.", content: jsonContent("ContextResponse") },
            "400": errorResponse("No team given with the admin token."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
          },
        },
        put: {
          operationId: "setContext",
          summary: "Replace the team's context layer.",
          description: `${ROLE_NOTE.admin} The files are validated like selfhost context compile reads .selfhost/context; an invalid layer changes nothing. Members get the new layer on their next sync.`,
          parameters: [teamParameter],
          requestBody: { required: true, content: jsonContent("SetContextRequest") },
          responses: {
            "200": { description: "Stored.", content: jsonContent("ContextResponse") },
            "400": errorResponse("The files are not a valid context folder. Nothing was stored."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
          },
        },
      },
      "/v1/context/proposals": {
        post: {
          operationId: "proposeContextItem",
          summary: "Propose one of the caller's own context items to the team.",
          description:
            "A person token of anyone in the team. Opens a context_promotion review item with the proposal's id. The item is added to the team layer only after an owner or admin of the team approves that review item; a member's answer is refused.",
          requestBody: { required: true, content: jsonContent("ContextProposalRequest") },
          responses: {
            "201": { description: "Proposed.", content: jsonContent("ContextProposal") },
            "400": errorResponse(
              "The files are not valid, or are not exactly the files of the item named.",
            ),
            ...authErrors,
            "403": errorResponse("The admin token, or a team the person is not in."),
            "404": errorResponse("No such team."),
            "409": errorResponse("The org or team layer already has the item."),
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
      "/v1/integrations": {
        get: {
          operationId: "getIntegrations",
          summary: "The router, tracer, runtime and reviewer the team picked, each checked now.",
          description: `${ROLE_NOTE.read} Reads [integrations] from the policy in use (the org's, then the team's; a team's table for a job replaces the org's) and checks each tool from the server with the cheapest call its docs give: the gateway's health and admin key, the tracer's API key, the runtime's API key, and for a reviewer its workflow file or GitHub App through the selfhost GitHub App. A team with no policy gets every job not_configured. Checks time out after a few seconds each.`,
          parameters: queryParameters(IntegrationsQuerySchema),
          responses: {
            "200": {
              description: "Each job's tool and status.",
              content: jsonContent("IntegrationsResponse"),
            },
            "400": errorResponse("Invalid query, or no team given with the admin token."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
          },
        },
      },
      "/v1/integrations/{kind}": {
        put: {
          operationId: "setIntegration",
          summary:
            "Pick the tool for one job, writing [integrations.<kind>] in the team's selfhost.toml.",
          description: `${ROLE_NOTE.admin} Replaces the [integrations.<kind>] table of the team's own selfhost.toml with tool and settings (tool null removes it) and leaves the rest of the file as it was, comments included. The new file is validated like PUT /v1/policy, against the org floor too, and an invalid one changes nothing. Answers with the same body as GET /v1/integrations.`,
          parameters: [
            {
              name: "kind",
              in: "path",
              required: true,
              description: "The job.",
              schema: { type: "string", enum: [...INTEGRATION_KINDS] },
            },
            teamParameter,
          ],
          requestBody: { required: true, content: jsonContent("SetIntegrationRequest") },
          responses: {
            "200": {
              description: "Stored, with each job checked again.",
              content: jsonContent("IntegrationsResponse"),
            },
            "400": {
              description:
                "The tool is not one for this job, or the settings make selfhost.toml invalid or relax the org floor: an InvalidPolicyError naming each field. An unknown kind or a body that is not JSON answers an ApiError. Nothing was stored.",
              content: jsonContent("InvalidPolicyError"),
            },
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
            "409": errorResponse(
              "[integrations.<kind>] is written in a way that cannot be replaced safely, such as an inline table. Change it with PUT /v1/policy.",
            ),
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
      "/v1/teams/{team}/laptops": {
        get: {
          operationId: "listTeamLaptops",
          summary: "List the laptops of a team with the config version each one runs.",
          description: `${ROLE_NOTE.read} Built from the heartbeats laptops send on join and on every sync (config.reported events, data.heartbeat a LaptopHeartbeat): the newest one per laptop, compared with the team's policy now. A laptop is behind when it runs another policy hash, silent when it sent nothing in silent_days, and not_installed when its managed settings files are pending or turned off. People in the team with no heartbeat at all are listed apart.`,
          parameters: [pathParameter("team", "Team id."), ...queryParameters(LaptopsQuerySchema)],
          responses: {
            "200": {
              description: "Every laptop, flagged ones first.",
              content: jsonContent("TeamLaptopsResponse"),
            },
            "400": errorResponse("Invalid query."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
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
      "/v1/teams/{team}/roi": {
        get: {
          operationId: "getTeamRoi",
          summary: "What each merged pull request cost, by agent and model, next to the baseline.",
          description: `${ROLE_NOTE.read} Computed on read from the ledger. The baseline is the team's first 7 UTC days of data, or [roi] baseline_from and baseline_to in its policy; it is computed the first time it is read after its period ended and then frozen, with the definition it used.`,
          parameters: [pathParameter("team", "Team id."), ...queryParameters(RoiQuerySchema)],
          responses: {
            "200": { description: "The report.", content: jsonContent("RoiResponse") },
            "400": errorResponse("Invalid query or time range."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such team."),
          },
        },
      },
      "/v1/teams/{team}/sandboxes": {
        get: {
          operationId: "getTeamSandboxWaste",
          summary:
            "Sandbox cost of a team's background runs: the idle share by runtime for 7 and 30 days, sandboxes left running after their run, and each run's sandbox and model cost.",
          description: `${ROLE_NOTE.read} Computed on read from sandbox.started and sandbox.stopped events (data.sandbox a SandboxRecord), the runs' cost.recorded events and the events that end a run (session.ended, or alert.raised run_failed or run_stuck). Idle seconds are billed seconds with no command running. A runtime that bills reserved time with an idle share above 50% gets a cheaper billing model and its estimated monthly saving.`,
          parameters: [
            pathParameter("team", "Team id."),
            ...queryParameters(SandboxWasteQuerySchema),
          ],
          responses: {
            "200": { description: "The report.", content: jsonContent("SandboxWasteResponse") },
            "400": errorResponse("Invalid query."),
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
      "/v1/runs/{run_id}": {
        get: {
          operationId: "getRun",
          summary:
            "One agent run for the console's run view, with links to it in the team's tracer.",
          description: `${ROLE_NOTE.read} A run is one agent session: run_id is the session_id its events carry, and it belongs to the team most of its events were written to. The answer has the run's summary, its ledger events oldest first (limit and cursor page through them), the pull requests they link to and trace_url, the run in the team's tracer from [integrations.tracer] run_url once the server has sent it there. Events are redacted under the team's current [ledger] and [[redaction]] settings. The full trace lives in the tracer; this is the summary and the way out to it.`,
          parameters: [
            pathParameter("run_id", "Run id: the agent's session id."),
            ...queryParameters(RunQuerySchema),
          ],
          responses: {
            "200": { description: "The run.", content: jsonContent("RunResponse") },
            "400": errorResponse("Invalid limit or cursor."),
            ...authErrors,
            "403": errorResponse(
              "A person token whose teams do not include the run's team. The same answer whether or not the run exists, so it shows nothing of it.",
            ),
            "404": errorResponse("No such run (admin token)."),
          },
        },
      },
      "/v1/runs/{run_id}/share": {
        post: {
          operationId: "shareRun",
          summary: "The run's stable link, posted on its pull requests by the GitHub App.",
          description: `${ROLE_NOTE.read} Posting on GitHub needs the work role. The link opens the run view in the console, which needs sign-in and the read role in the run's team; anyone else gets an access error with nothing of the run. With the GitHub App configured, the link goes on each pull request the run links to as one comment, found again by a hidden marker: a second share updates it instead of adding another. selfhost share makes this call.`,
          parameters: [pathParameter("run_id", "Run id: the agent's session id.")],
          requestBody: { required: false, content: jsonContent("RunShareRequest") },
          responses: {
            "200": {
              description: "The link and what was posted.",
              content: jsonContent("RunShareResponse"),
            },
            "400": errorResponse("Invalid body."),
            ...authErrors,
            "403": errorResponse(
              "A person token whose teams do not include the run's team, the same answer whether or not the run exists; or a role without work when posting.",
            ),
            "404": errorResponse("No such run (admin token)."),
          },
        },
      },
      "/v1/runs/{run_id}/handoffs": {
        post: {
          operationId: "handOffRun",
          summary: "Hand a run to a teammate: owner change in the ledger and a handoff record.",
          description:
            "The run's current owner with the work role in its team, a team owner or admin, or the admin token. The new owner must be in the run's team with the work role. Writes a run.handed_off ledger event (data v 1: handoff, owner, previous_owner, branch) and stores the record: branch, commit, uncommitted files, files the run touched, its open review items (which route to the new owner from then on), cost so far and the last turns, redacted under the team's settings, with the note. A transcript is accepted only when the team's [handoff] share_transcript is on; it is masked again and kept until the takeover. An earlier pending handoff of the run is superseded. selfhost handoff makes this call.",
          parameters: [pathParameter("run_id", "Run id: the agent's session id.")],
          requestBody: { required: true, content: jsonContent("CreateHandoffRequest") },
          responses: {
            "201": { description: "The handoff.", content: jsonContent("Handoff") },
            "400": errorResponse(
              "Invalid body, a new owner who is not in the team, the run's own owner, or a transcript while [handoff] share_transcript is off.",
            ),
            ...authErrors,
            "403": errorResponse(
              "Not the run's owner nor a team owner or admin, or not in the run's team (the same answer whether or not the run exists).",
            ),
            "404": errorResponse("No such run (admin token)."),
            "413": errorResponse("The body is over the transcript limit."),
          },
        },
      },
      "/v1/handoffs": {
        get: {
          operationId: "listHandoffs",
          summary: "Handoffs in the caller's teams, newest first; to=me for the ones to take over.",
          description: `${ROLE_NOTE.read} A person token sees the handoffs of every team of its org it can read. Notes and turns are masked under each team's current settings.`,
          parameters: queryParameters(HandoffQuerySchema),
          responses: {
            "200": { description: "The handoffs.", content: jsonContent("HandoffsResponse") },
            "400": errorResponse("Invalid query."),
            ...authErrors,
          },
        },
      },
      "/v1/handoffs/{id}": {
        get: {
          operationId: "getHandoff",
          summary: "One handoff record.",
          description: `${ROLE_NOTE.read} The transcript's text is not in it; the new owner gets it once, from the takeover.`,
          parameters: [pathParameter("id", "Handoff id.")],
          responses: {
            "200": { description: "The handoff.", content: jsonContent("Handoff") },
            ...authErrors,
            "403": errorResponse("No handoff the caller can read has this id."),
            "404": errorResponse("No such handoff (admin token)."),
          },
        },
      },
      "/v1/handoffs/{id}/takeover": {
        post: {
          operationId: "takeOverRun",
          summary: "The new owner takes the run over: the record and the transcript, once.",
          description:
            "A person token only, of the handoff's new owner, who must still be in the run's team with the work role: a takeover runs under that person's own login, never the previous owner's. Marks the handoff taken and answers with the transcript, deleting the server's copy. selfhost takeover makes this call.",
          parameters: [pathParameter("id", "Handoff id.")],
          responses: {
            "200": { description: "Taken over.", content: jsonContent("TakeoverResponse") },
            ...authErrors,
            "403": errorResponse(
              "The admin token, someone other than the new owner, or a new owner no longer in the run's team.",
            ),
            "409": errorResponse("Already taken over, or handed on again."),
          },
        },
      },
      "/v1/background-runs": {
        post: {
          operationId: "startBackgroundRun",
          summary: "Start a background run: an agent CLI in a sandbox on the team's runtime.",
          description:
            "A person token only, with the work role in the team: the run works for that person and under their own agent login. The trigger is checked ([background] allowed, kill switches, rate_limit_per_hour, max_concurrent, a runtime) and recorded as a run.triggered event either way. The run goes on in the background: a sandbox, a clone on its own branch, the agent CLI and the team's hooks, the tests-first gate, one pull request. Read it back with GET /v1/background-runs/{id}.",
          requestBody: { required: true, content: jsonContent("StartRunRequest") },
          responses: {
            "202": {
              description: "Started; the run as queued.",
              content: jsonContent("BackgroundRun"),
            },
            "400": errorResponse("Invalid body."),
            ...authErrors,
            "403": errorResponse(
              "The admin token, a caller without the work role, or a person not on [background] allowed.",
            ),
            "409": errorResponse("A team or org kill switch is on."),
            "429": errorResponse("The team's hourly or concurrent run limit is reached."),
            "503": errorResponse("No runtime is set up for the team, or background runs are off."),
          },
        },
        get: {
          operationId: "listBackgroundRuns",
          summary: "Background runs, newest first, with the kill switches in force.",
          description: `${ROLE_NOTE.read} A person token sees the runs of every team of its org it is in.`,
          parameters: queryParameters(BackgroundRunsQuerySchema),
          responses: {
            "200": { description: "The runs.", content: jsonContent("BackgroundRunsResponse") },
            "400": errorResponse("Invalid query."),
            ...authErrors,
            "403": forbiddenResponse,
          },
        },
      },
      "/v1/background-runs/{id}": {
        get: {
          operationId: "getBackgroundRun",
          summary: "One background run: state, health line, live cost, gate and pull request.",
          description: `${ROLE_NOTE.read} cost rises while the run goes; once it is final it equals the cost on its last run.updated event.`,
          parameters: [pathParameter("id", "Run id.")],
          responses: {
            "200": { description: "The run.", content: jsonContent("BackgroundRun") },
            ...authErrors,
            "403": errorResponse("No run the caller can read has this id."),
            "404": errorResponse("No such run (admin token)."),
          },
        },
      },
      "/v1/background-runs/{id}/cancel": {
        post: {
          operationId: "cancelBackgroundRun",
          summary: "Stop one run and its sandbox.",
          description:
            "The admin token, or a person token with the work role in the run's team. Who stopped it is recorded on the run. A final run is answered as it is.",
          parameters: [pathParameter("id", "Run id.")],
          responses: {
            "200": { description: "The run.", content: jsonContent("BackgroundRun") },
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No such run."),
          },
        },
      },
      "/v1/background-runs/kill": {
        post: {
          operationId: "killBackgroundRuns",
          summary: "Turn a team or org kill switch on: stop every run in it, refuse new ones.",
          description:
            "A team switch needs the admin token or an owner or admin of the team; an org switch the admin token or an owner in the org. Who used it is kept.",
          requestBody: { required: true, content: jsonContent("KillRequest") },
          responses: {
            "200": {
              description: "The switch, and the runs stopped.",
              content: jsonContent("KillResponse"),
            },
            "400": errorResponse("Invalid body."),
            ...authErrors,
            "403": forbiddenResponse,
            "503": errorResponse("Background runs are off."),
          },
        },
        delete: {
          operationId: "clearBackgroundKill",
          summary: "Turn a kill switch off, so runs may start again.",
          description: "The same callers as turning it on. Who cleared it is kept.",
          parameters: [
            {
              name: "scope",
              in: "query",
              required: true,
              schema: { type: "string", enum: ["team", "org"] },
            },
            { name: "target", in: "query", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "The switch.", content: jsonContent("KillResponse") },
            "400": errorResponse("Invalid query."),
            ...authErrors,
            "403": forbiddenResponse,
            "503": errorResponse("Background runs are off."),
          },
        },
      },
      "/v1/background-runs/webhook": {
        post: {
          operationId: "webhookBackgroundRun",
          summary: "Start a run from a signed webhook (the Slack and Telegram bridges use it).",
          description:
            "No bearer token: X-Selfhost-Signature-256, sha256= and the HMAC-SHA256 in hex of `<X-Selfhost-Timestamp>.<X-Selfhost-Delivery>.<body>` under the secret in the server variable [background] webhook_secret_env names, is the credential. X-Selfhost-Timestamp is the Unix time in seconds, within 5 minutes of the server's; X-Selfhost-Delivery is a new id for each request, taken once. A missing or wrong signature, an old timestamp or a repeated delivery starts nothing and is recorded as a refused run.triggered event. sender is the person the bridge mapped the message to and must be on [background] webhook_senders; the same checks as POST /v1/background-runs apply.",
          security: [],
          requestBody: { required: true, content: jsonContent("WebhookRunRequest") },
          responses: {
            "202": { description: "Started.", content: jsonContent("BackgroundRun") },
            "400": errorResponse("Invalid body, or no team."),
            "401": errorResponse(
              "The signature does not match, the timestamp is too old, or webhooks are off for the team.",
            ),
            "403": errorResponse("The sender is not on webhook_senders or may not start runs."),
            "404": errorResponse("Background runs are off on this server."),
            "409": errorResponse("A kill switch is on, or the delivery id was used before."),
            "429": errorResponse("A run limit is reached."),
            "503": errorResponse("No runtime is set up for the team."),
          },
        },
      },
      "/v1/events/tail": {
        get: {
          operationId: "tailEvents",
          summary: "The events that reached the ledger since the last call, for selfhost tail.",
          description: `${ROLE_NOTE.read} A long poll in ingest order: pass the cursor of the previous answer as after, and wait to hold the request until something lands. The admin token reads every team and events with no team; a person token reads the teams of its org it is in. Events are redacted under each team's current [ledger] and [[redaction]] settings, as GET /v1/runs/{run_id} shows them, so prompt text appears only while log_prompts is on.`,
          parameters: queryParameters(TailQuerySchema),
          responses: {
            "200": { description: "What landed.", content: jsonContent("TailResponse") },
            "400": errorResponse("Invalid query or cursor."),
            ...authErrors,
            "403": forbiddenResponse,
          },
        },
      },
      "/v1/presence": {
        get: {
          operationId: "getPresence",
          summary:
            "Who (people and named agents) is working right now on which repo, branch and files, and who owns each run.",
          description: `${ROLE_NOTE.read} A run is active from its first event until its session ends (or its background run finishes) or it has had no event for idle_minutes. A person token sees the teams of its org it can read; the admin token sees every team and runs with no team. overlaps lists files two active runs in one repo both edited; the team server also warns each of their owners with an overlap item. selfhost who and the MCP tool who give the same answer.`,
          parameters: queryParameters(PresenceQuerySchema),
          responses: {
            "200": {
              description: "Who is working where.",
              content: jsonContent("PresenceResponse"),
            },
            "400": errorResponse("Invalid query."),
            ...authErrors,
            "403": forbiddenResponse,
          },
        },
      },
      "/v1/budget": {
        get: {
          operationId: "getBudget",
          summary: "Spend so far against a team's budget, with a forecast.",
          description: `${ROLE_NOTE.read} The budget is [budget] in the team's selfhost.toml. Nothing is charged back; with [budget] mode = hard the AI gateway also refuses requests once it is spent (GET /v1/gateway shows its limits). The MCP tool get_budget makes the same call.`,
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
      "/v1/gateway": {
        get: {
          operationId: "getGateway",
          summary: "The AI gateway: health, the team's hard limits and the caller's own key.",
          description: `${ROLE_NOTE.read} The gateway (Bifrost or LiteLLM, [integrations.router]) holds the provider keys and enforces the limits; selfhost sets them from [budget] and reads its request logs into the ledger. Key values are never returned here.`,
          parameters: [teamParameter],
          responses: {
            "200": { description: "The gateway.", content: jsonContent("GatewayStatus") },
            "400": errorResponse("No team given with the admin token."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No gateway is configured on this server."),
          },
        },
      },
      "/v1/gateway/keys": {
        get: {
          operationId: "listGatewayKeys",
          summary: "The team's gateway keys and their limits, never their values.",
          description: ROLE_NOTE.admin,
          parameters: [teamParameter],
          responses: {
            "200": { description: "The keys.", content: jsonContent("GatewayKeysResponse") },
            "400": errorResponse("No team given with the admin token."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No gateway is configured on this server."),
          },
        },
        post: {
          operationId: "issueGatewayKey",
          summary: "Issue a gateway key and return its value, once.",
          description:
            "A person key goes only to its person, with their person token. A team key needs the owner or admin role, or the admin token. A run key is refused (403): the server issues each background run its own key, capped at [budget] run_usd, and revokes it when the run ends. The value is in this answer only; selfhost keeps no copy.",
          requestBody: { required: true, content: jsonContent("IssueGatewayKeyRequest") },
          responses: {
            "201": { description: "Key issued.", content: jsonContent("IssueGatewayKeyResponse") },
            "400": errorResponse("Invalid request."),
            ...authErrors,
            "403": forbiddenResponse,
            "404": errorResponse("No gateway is configured on this server."),
            "409": errorResponse("The key exists; ask again with rotate to replace its value."),
            "502": errorResponse("The gateway refused or did not answer."),
          },
        },
      },
      "/v1/gateway/sync": {
        post: {
          operationId: "syncGateway",
          summary: "Write teams, budgets and key settings to the gateway now.",
          description:
            "Admin token only. The server also does this every few minutes. Safe to repeat: only what differs is changed.",
          responses: {
            "200": { description: "What changed.", content: jsonContent("GatewaySyncReport") },
            ...authErrors,
            "404": errorResponse("No gateway is configured on this server."),
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
      "/v1/orgs/{org}/context": {
        get: {
          operationId: "getOrgContext",
          summary: "Get the org's context layer: the floor of every team's context.",
          description: "The admin token, or a person token of anyone in the org.",
          parameters: [pathParameter("org", "Org id.")],
          responses: {
            "200": { description: "The org layer.", content: jsonContent("OrgContextResponse") },
            ...authErrors,
            "403": errorResponse("A person token of another org."),
            "404": errorResponse("No such org."),
          },
        },
        put: {
          operationId: "setOrgContext",
          summary: "Replace the org's context layer.",
          description:
            "Admin token only. Its items are merged first on every member's laptop, so a team, repo or personal item of the same name is never used in their place.",
          parameters: [pathParameter("org", "Org id.")],
          requestBody: { required: true, content: jsonContent("SetContextRequest") },
          responses: {
            "200": { description: "Stored.", content: jsonContent("OrgContextResponse") },
            "400": errorResponse("The files are not a valid context folder. Nothing was stored."),
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
            "One line per row of GET /v1/usage for the same query, after a header line: the grouped dimensions, then usd, tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_hit_rate (empty when unknown), requests, sessions, prs_opened and prs_merged. Text that a spreadsheet would read as a formula starts with an apostrophe.",
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
      "/v1/notify": {
        get: {
          operationId: "getNotifySettings",
          summary: "The caller's notification targets, masked, and digest cadence.",
          description: `${PERSON_NOTE} Targets are Apprise URLs; only their service and a masked form are returned, never the URL.`,
          responses: {
            "200": { description: "The settings.", content: jsonContent("NotifySettings") },
            ...authErrors,
          },
        },
      },
      "/v1/notify/targets": {
        post: {
          operationId: "addNotifyTarget",
          summary: "Add an Apprise URL the caller's alerts and digests go to.",
          description: `${PERSON_NOTE} The URL is kept on the server and never returned. At most ten targets per person.`,
          requestBody: { required: true, content: jsonContent("AddNotifyTargetRequest") },
          responses: {
            "201": { description: "Added.", content: jsonContent("NotifySettings") },
            "400": errorResponse("Not an Apprise URL, or an invalid name."),
            ...authErrors,
            "409": errorResponse("The name is taken, or the caller has ten targets."),
          },
        },
      },
      "/v1/notify/targets/{name}": {
        delete: {
          operationId: "removeNotifyTarget",
          summary: "Remove one of the caller's targets.",
          description: PERSON_NOTE,
          parameters: [pathParameter("name", "Target name.")],
          responses: {
            "200": { description: "Removed.", content: jsonContent("NotifySettings") },
            ...authErrors,
            "404": errorResponse("The caller has no target with this name."),
          },
        },
      },
      "/v1/notify/digest": {
        put: {
          operationId: "setNotifyDigest",
          summary: "Set the caller's digest cadence: daily, weekly or off.",
          description: `${PERSON_NOTE} Digests go out at [notify] digest_hour (UTC), weekly ones on Mondays.`,
          requestBody: { required: true, content: jsonContent("SetNotifyDigestRequest") },
          responses: {
            "200": { description: "Set.", content: jsonContent("NotifySettings") },
            "400": errorResponse("Not daily, weekly or off."),
            ...authErrors,
          },
        },
      },
      "/v1/notify/test": {
        post: {
          operationId: "testNotify",
          summary: "Send a test message to the caller's targets.",
          description: `${PERSON_NOTE} Each send is recorded by target name, ok or failed, with any URL in an error masked.`,
          requestBody: { required: true, content: jsonContent("NotifyTestRequest") },
          responses: {
            "200": {
              description: "One send per target.",
              content: jsonContent("NotifyTestResponse"),
            },
            ...authErrors,
            "404": errorResponse("The caller has no targets, or none with this name."),
            "503": errorResponse(
              "The server has no Apprise to send through (SELFHOST_APPRISE_URL).",
            ),
          },
        },
      },
      "/v1/notify/sends": {
        get: {
          operationId: "listNotifySends",
          summary: "The caller's recent sends, newest first.",
          description: `${PERSON_NOTE} Kept 90 days.`,
          parameters: [
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            "200": { description: "The sends.", content: jsonContent("NotifySendsResponse") },
            "400": errorResponse("Invalid limit."),
            ...authErrors,
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
