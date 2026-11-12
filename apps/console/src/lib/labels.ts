import type { ReviewItemKind, RuleAction, RuleMode } from "@selfhost/schema";

/** Plain-English names for what the API returns as ids. */

/** What a rule does now: it records, blocks, asks a person, or nothing. */
export function modeLabel(mode: RuleMode, action: RuleAction = "block"): string {
  if (mode === "off") return "Off";
  if (mode === "observe") return "Recording only";
  return action === "ask" ? "Asks a person" : "Blocking";
}

export const REVIEW_KIND_NAMES: Record<ReviewItemKind, string> = {
  pr: "Pull request",
  approval: "Approval",
  question: "Question",
  blocked_action: "Blocked action",
  exception: "Exception requested",
  stuck_run: "Stuck run",
  budget: "Budget",
  spend_spike: "Spend spike",
  quality: "Code quality",
  policy_report: "Rules report",
  context_promotion: "Team context proposal",
  security: "Security alert",
  overlap: "Edit overlap",
};

/** The built-in guardrails, in the order the hooks check them. */
export const GUARDRAILS: { id: string; name: string }[] = [
  { id: "guard.force_push", name: "Force push" },
  { id: "guard.reset_hard", name: "git reset --hard" },
  { id: "guard.rm_outside_workspace", name: "rm -rf outside the workspace" },
  { id: "guard.secret_read", name: "Reading .env and key files" },
  { id: "guard.prod_sql", name: "DROP or TRUNCATE on production databases" },
  { id: "guard.prod_credentials", name: "Using production credentials" },
];

/** The agent tools whose native controls the coverage report covers. */
export const COVERAGE_VENDORS = ["claude_code", "codex", "cursor", "copilot"] as const;

export const INTEGRATION_NAMES = {
  router: { title: "Model router", blurb: "The AI gateway agents' model traffic goes through." },
  tracer: { title: "Tracer", blurb: "Where agent traces go, and where a run opens." },
  runtime: { title: "Runtime", blurb: "Where background agents run." },
  reviewer: { title: "AI reviewer", blurb: "Whose findings join the review list." },
} as const;

/** Tools per job, as [integrations] in selfhost.toml lists them (a test keeps them equal). */
export const INTEGRATION_TOOLS = {
  router: ["bifrost", "litellm"],
  tracer: ["langfuse", "phoenix", "datadog", "otlp"],
  runtime: ["e2b", "daytona", "modal", "coder", "opensandbox"],
  reviewer: ["pr-agent", "claude-code-action", "coderabbit"],
} as const;

/** The plain settings each job takes, as [integrations.<job>] keys. */
export const INTEGRATION_SETTINGS = {
  router: [
    { key: "url", label: "Gateway address" },
    { key: "admin_key_env", label: "Admin key variable" },
  ],
  tracer: [
    { key: "endpoint", label: "OTLP endpoint" },
    { key: "run_url", label: "Run link template" },
  ],
  runtime: [
    { key: "url", label: "API address" },
    { key: "api_key_env", label: "API key variable" },
    { key: "template", label: "Template" },
  ],
  reviewer: [
    { key: "api_key_env", label: "API key variable" },
    { key: "model", label: "Model" },
  ],
} as const;

export const TOOL_NAMES: Record<string, string> = {
  bifrost: "Bifrost",
  litellm: "LiteLLM",
  langfuse: "Langfuse",
  phoenix: "Phoenix",
  datadog: "Datadog",
  otlp: "OpenTelemetry endpoint",
  e2b: "E2B",
  daytona: "Daytona",
  modal: "Modal",
  coder: "Coder",
  opensandbox: "OpenSandbox (your own server)",
  "pr-agent": "PR-Agent",
  "claude-code-action": "Claude Code Action",
  coderabbit: "CodeRabbit",
};

export const toolName = (tool: string) => TOOL_NAMES[tool] ?? tool;
