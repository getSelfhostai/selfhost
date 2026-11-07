import type { TObject } from "@sinclair/typebox";
import {
  BudgetQuerySchema,
  BudgetResponseSchema,
  DecisionQuerySchema,
  DecisionResponseSchema,
  DecisionsPageSchema,
  EventQuerySchema,
  EventsPageSchema,
  PolicyQuerySchema,
  PolicyResponseSchema,
  RecordDecisionInputSchema,
  ReviewItemQuerySchema,
  ReviewItemsPageSchema,
} from "./api.js";

export const MCP_TOOLS_SCHEMA = "selfhost.mcp_tools/v1";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: TObject;
  outputSchema: TObject;
}

/** Tools the selfhost MCP server exposes to agents. Outputs match the HTTP API bodies. */
export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "get_policy",
    description:
      "Get the team rules that apply to you: selfhost.toml with team overrides resolved for a person and agent.",
    inputSchema: PolicyQuerySchema,
    outputSchema: PolicyResponseSchema,
  },
  {
    name: "get_budget",
    description: "Get spend so far, the budget and the forecast for a person or team.",
    inputSchema: BudgetQuerySchema,
    outputSchema: BudgetResponseSchema,
  },
  {
    name: "list_review_items",
    description: "List review items, ranked: blocking first, then by risk.",
    inputSchema: ReviewItemQuerySchema,
    outputSchema: ReviewItemsPageSchema,
  },
  {
    name: "search_events",
    description: "Search the ledger by person, agent, model, session, kind and time range.",
    inputSchema: EventQuerySchema,
    outputSchema: EventsPageSchema,
  },
  {
    name: "search_decisions",
    description:
      "Search past rule verdicts and human decisions by file path, topic, rule or person, for example to check whether a person already decided a similar case before asking again.",
    inputSchema: DecisionQuerySchema,
    outputSchema: DecisionsPageSchema,
  },
  {
    name: "record_decision",
    description: "Record a human decision on a review item. Writes a decision.recorded event.",
    inputSchema: RecordDecisionInputSchema,
    outputSchema: DecisionResponseSchema,
  },
];
