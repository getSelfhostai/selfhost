export { type AppliedChange, applyAgentConfig } from "./config/apply.js";
export { isPlainObject, openDoc, type Plain, type TreeDoc } from "./config/docs.js";
export {
  claudeMcpServer,
  codexMcpTable,
  cursorMcpServer,
  gooseExtension,
  type McpTransport,
  mcpTransport,
  opencodeMcpServer,
} from "./config/mcp.js";
export {
  GATEWAY_PROFILE,
  manifestPath,
  planAgentConfig,
  removeAgentConfig,
} from "./config/plan.js";
export {
  BLOCK_END,
  BLOCK_START,
  extractBlock,
  insertBlock,
  tomlBlock,
  tomlKey,
  tomlTable,
  tomlValue,
} from "./config/toml.js";
export type {
  AgentConfigInput,
  AgentConfigPlan,
  FileChange,
  GatewaySpec,
  HooksSpec,
  ItemStatus,
  McpServerSpec,
  OtelSpec,
  OtlpProtocol,
  PlanItem,
  PlanOptions,
  TomlBlock,
} from "./config/types.js";
export {
  CURSOR_HOOK_EVENTS,
  GATEWAY_PROVIDER,
  gooseGatewayProvider,
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
export {
  type SubscriptionLogin,
  type SubscriptionOptions,
  subscriptionLogin,
} from "./subscription.js";
export * from "./types.js";
