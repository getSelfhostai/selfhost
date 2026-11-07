import type { TObject, TSchema } from "@sinclair/typebox";
import { stringify } from "yaml";
import {
  ApiErrorSchema,
  ClaudeCodeHookInputSchema,
  CodexHookInputSchema,
  CodexNotifySchema,
  CreateTeamRequestSchema,
  CreateTeamResponseSchema,
  DecisionRequestSchema,
  DecisionResponseSchema,
  EventQuerySchema,
  EventsPageSchema,
  HealthResponseSchema,
  IngestEventsErrorSchema,
  IngestEventsRequestSchema,
  IngestEventsResponseSchema,
  InvalidPolicyErrorSchema,
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
  ["PolicyResponse", PolicyResponseSchema],
  ["SetPolicyRequest", SetPolicyRequestSchema],
  ["InvalidPolicyError", InvalidPolicyErrorSchema],
  ["CreateTeamRequest", CreateTeamRequestSchema],
  ["CreateTeamResponse", CreateTeamResponseSchema],
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
        "HTTP API of the selfhost server: ledger ingest and search, the review list and team policy. Laptop, self-hosted and hosted installs serve the same API.",
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
          parameters: queryParameters(EventQuerySchema),
          responses: {
            "200": { description: "One page of events.", content: jsonContent("EventsPage") },
            "400": errorResponse("Invalid filter."),
            ...authErrors,
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
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "Review item id.",
              schema: { type: "string" },
            },
          ],
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
            "400": errorResponse("Invalid name."),
            ...authErrors,
            "409": errorResponse("A team with this id already exists."),
          },
        },
      },
      "/v1/join": {
        post: {
          operationId: "joinTeam",
          summary: "Exchange an invite code for a person token.",
          description:
            "The invite code is the credential, so no bearer token is needed. Joining again with the same person id returns a new token for the same person.",
          security: [],
          requestBody: { required: true, content: jsonContent("JoinRequest") },
          responses: {
            "200": { description: "Joined.", content: jsonContent("JoinResponse") },
            "400": errorResponse("Invalid body."),
            "403": errorResponse("Unknown or revoked invite code."),
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
