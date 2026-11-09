/**
 * The tools each [integrations] slot can name. Kept in their own module, with no imports, so the
 * review item and second-opinion schemas can use them without importing the config schema.
 */
export const ROUTER_TOOLS = ["bifrost", "litellm"] as const;
export const TRACER_TOOLS = ["langfuse", "phoenix", "datadog", "otlp"] as const;
export const RUNTIME_TOOLS = ["e2b", "daytona", "modal", "coder"] as const;
export const REVIEWER_TOOLS = ["pr-agent", "claude-code-action", "coderabbit"] as const;
export type RouterTool = (typeof ROUTER_TOOLS)[number];
export type TracerTool = (typeof TRACER_TOOLS)[number];
export type RuntimeTool = (typeof RUNTIME_TOOLS)[number];
export type ReviewerTool = (typeof REVIEWER_TOOLS)[number];
