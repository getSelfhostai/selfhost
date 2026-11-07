import type { TObject, TSchema } from "@sinclair/typebox";
import { stringify } from "yaml";
import {
  ApiErrorSchema,
  ClaudeCodeHookInputSchema,
  CodexHookInputSchema,
  CodexNotifySchema,
  CreateDecisionRequestSchema,
  CreateDecisionResponseSchema,
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  CreateTeamRequestSchema,
  CreateTeamResponseSchema,
  DecisionQuerySchema,
  DecisionRequestSchema,
  DecisionResponseSchema,
  DecisionsPageSchema,
  EventQuerySchema,
  EventsPageSchema,
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
  PolicyQuerySchema,
  PolicyResponseSchema,
  ReviewItemQuerySchema,
  ReviewItemSchema,
  ReviewItemsPageSchema,
  RevokeTokensResponseSchema,
  SelfhostConfigSchema,
  SetPolicyRequestSchema,
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
  ["DecisionsPage", DecisionsPageSchema],
  ["CreateDecisionRequest", CreateDecisionRequestSchema],
  ["CreateDecisionResponse", CreateDecisionResponseSchema],
  ["PolicyResponse", PolicyResponseSchema],
  ["SetPolicyRequest", SetPolicyRequestSchema],
  ["InvalidPolicyError", InvalidPolicyErrorSchema],
  ["CreateTeamRequest", CreateTeamRequestSchema],
  ["CreateTeamResponse", CreateTeamResponseSchema],
  ["CreateInviteRequest", CreateInviteRequestSchema],
  ["CreateInviteResponse", CreateInviteResponseSchema],
  ["Invite", InviteSchema],
  ["RevokeTokensResponse", RevokeTokensResponseSchema],
  ["JoinRequest", JoinRequestSchema],
  ["JoinResponse", JoinResponseSchema],
  ["MeResponse", MeResponseSchema],
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
  description: "Team id. Needed with the admin token; a person token writes its own team.",
  schema: { type: "string" },
};

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
            "Atomic: if any event is invalid, nothing is written and the response lists every error by index and field. Event ids are idempotency keys, so retrying a batch is safe. With a person token, events whose actor is a person must carry that person's id (an event with no actor gets it), system actors are refused, and team is set to the person's team.",
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
          parameters: queryParameters(ReviewItemQuerySchema),
          responses: {
            "200": { description: "One page of items.", content: jsonContent("ReviewItemsPage") },
            "400": errorResponse("Invalid filter."),
            ...authErrors,
          },
        },
      },
      "/v1/review-items/{id}/decision": {
        post: {
          operationId: "recordDecision",
          summary: "Answer a review item.",
          description:
            "Writes a decision.recorded event, attributed to the person the token belongs to, and closes the item.",
          parameters: [pathParameter("id", "Review item id.")],
          requestBody: { required: true, content: jsonContent("DecisionRequest") },
          responses: {
            "200": { description: "Decision recorded.", content: jsonContent("DecisionResponse") },
            "400": errorResponse("Invalid decision."),
            ...authErrors,
            "404": errorResponse("No such review item."),
            "409": errorResponse("The item is no longer open."),
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
          parameters: queryParameters(PolicyQuerySchema),
          responses: {
            "200": { description: "Policy in use.", content: jsonContent("PolicyResponse") },
            "400": errorResponse("Invalid query, or no team given with the admin token."),
            ...authErrors,
            "403": errorResponse("A person token asked for another team's policy."),
            "404": errorResponse("No such team, or the team has no policy yet."),
          },
        },
        put: {
          operationId: "setPolicy",
          summary: "Replace a team's selfhost.toml.",
          description:
            "Admin token, or a person token whose role is owner or admin. The text is validated first; an invalid file changes nothing.",
          parameters: [teamParameter],
          requestBody: { required: true, content: jsonContent("SetPolicyRequest") },
          responses: {
            "200": { description: "Policy stored.", content: jsonContent("PolicyResponse") },
            "400": {
              description: "The selfhost.toml is invalid. Nothing was stored.",
              content: jsonContent("InvalidPolicyError"),
            },
            ...authErrors,
            "403": errorResponse("The person token's role is not owner or admin."),
            "404": errorResponse("No such team."),
          },
        },
      },
      "/v1/teams": {
        post: {
          operationId: "createTeam",
          summary: "Create a team and its invite code.",
          description: "Admin token only.",
          requestBody: { required: true, content: jsonContent("CreateTeamRequest") },
          responses: {
            "201": { description: "Team created.", content: jsonContent("CreateTeamResponse") },
            "400": errorResponse("Invalid name or invite lifetime."),
            ...authErrors,
            "409": errorResponse("A team with this id already exists."),
          },
        },
      },
      "/v1/teams/{team}/invites": {
        post: {
          operationId: "createInvite",
          summary: "Create another invite code for a team.",
          description:
            "Admin token only. The invite expires after ttl_seconds (default 7 days). With an email, only that person can join with it, and their person id is the email.",
          parameters: [pathParameter("team", "Team id.")],
          requestBody: { required: true, content: jsonContent("CreateInviteRequest") },
          responses: {
            "201": { description: "Invite created.", content: jsonContent("CreateInviteResponse") },
            "400": errorResponse("Invalid lifetime or email."),
            ...authErrors,
            "404": errorResponse("No such team."),
          },
        },
      },
      "/v1/invites/{id}": {
        delete: {
          operationId: "revokeInvite",
          summary: "Revoke an invite code.",
          description:
            "Admin token only. Joining with a revoked invite answers 401. People who already joined keep their tokens. Revoking twice is not an error.",
          parameters: [pathParameter("id", "sha256 of the invite code, in hex.")],
          responses: {
            "200": { description: "Invite revoked.", content: jsonContent("Invite") },
            ...authErrors,
            "404": errorResponse("No such invite."),
          },
        },
      },
      "/v1/teams/{team}/people/{person}/tokens": {
        delete: {
          operationId: "revokePersonTokens",
          summary: "Revoke every token a person holds.",
          description:
            "Admin token only. The person's events stay in the ledger; their tokens answer 401 from now on. They can join again only with a new invite.",
          parameters: [pathParameter("team", "Team id."), pathParameter("person", "Person id.")],
          responses: {
            "200": {
              description: "Tokens revoked.",
              content: jsonContent("RevokeTokensResponse"),
            },
            ...authErrors,
            "404": errorResponse("No such team or person."),
          },
        },
      },
      "/v1/join": {
        post: {
          operationId: "joinTeam",
          summary: "Exchange an invite code for a person token.",
          description:
            "The invite code is the credential, so no bearer token is needed. A team-wide invite only adds new people: a person id already in the team (compared ignoring case) is refused, so the holder cannot take over the owner's or anyone else's identity. An invite for an email joins only that person, also when they are already in the team, which adds another token for them.",
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
          summary: "Who the bearer token belongs to.",
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
      return { name: tool.name, description: tool.description, inputSchema, outputSchema };
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
  ];
}
