export { type AppliedChange, applyAgentConfig } from "./config/apply.js";
export { manifestPath, planAgentConfig, removeAgentConfig } from "./config/plan.js";
export { BLOCK_END, BLOCK_START, tomlBlock } from "./config/toml.js";
export type {
  AgentConfigInput,
  AgentConfigPlan,
  FileChange,
  HooksSpec,
  ItemStatus,
  McpServerSpec,
  OtelSpec,
  OtlpProtocol,
  PlanItem,
  PlanOptions,
} from "./config/types.js";
export {
  CURSOR_HOOK_EVENTS,
  OPENCODE_PLUGIN_FILE,
  PRE_TOOL_HOOK_EVENTS,
} from "./config/vendors.js";
export {
  CONTEXT_KIND_LABELS,
  CONTEXT_READER_NAMES,
  CONTEXT_READERS,
  type ContextFile,
  type ContextKind,
  type ContextOptions,
  type ContextReader,
  findContextFiles,
  repoRoot,
} from "./context.js";
export { type DetectOptions, detectAgents, parseVersion, versionFromPath } from "./detect.js";
export { redactLine, unifiedDiff } from "./diff.js";
export { type AgentLocations, locate, PATH_ENV_VARS } from "./locations.js";
export { macKeychain, pathLookup, systemProbes, versionProbe } from "./probes.js";
export * from "./types.js";
