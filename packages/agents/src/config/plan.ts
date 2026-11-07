import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { locate } from "../locations.js";
import type { AgentId } from "../types.js";
import { isPlainObject } from "./docs.js";
import { planToml } from "./toml.js";
import { planTree } from "./tree.js";
import type {
  AgentConfigPlan,
  FileChange,
  Manifest,
  ManifestFile,
  PlanItem,
  PlanOptions,
  Target,
} from "./types.js";
import { vendorTargets } from "./vendors.js";

const MANIFEST_SCHEMA = "selfhost.agent_config/v1";

/** selfhost's record of what it wrote for an agent: `<home>/.selfhost/agents/<agent>.json`. */
export function manifestPath(home: string, agent: AgentId): string {
  return join(home, ".selfhost", "agents", `${agent}.json`);
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readManifest(text: string | null, agent: AgentId): Manifest {
  const empty: Manifest = { schema: MANIFEST_SCHEMA, agent, files: {} };
  if (text === null) return empty;
  try {
    const value: unknown = JSON.parse(text);
    if (isPlainObject(value) && value.schema === MANIFEST_SCHEMA && isPlainObject(value.files)) {
      return { schema: MANIFEST_SCHEMA, agent, files: value.files as Record<string, ManifestFile> };
    }
  } catch {
    // An unreadable record is treated as empty: selfhost then owns nothing it can't prove.
  }
  return empty;
}

const ITEM_ORDER = ["env", "otel", "hooks"];

function itemRank(item: PlanItem): string {
  const index = ITEM_ORDER.indexOf(item.item);
  return `${index === -1 ? ITEM_ORDER.length : index}:${item.item}:${item.path ?? ""}`;
}

/**
 * Plans the changes that put selfhost's hooks, env, MCP servers and OpenTelemetry settings
 * into one agent's own settings files. Nothing is written: pass the plan to
 * applyAgentConfig. Running it again with the same input plans no changes.
 */
export function planAgentConfig(agent: AgentId, options: PlanOptions): AgentConfigPlan {
  const { home, processEnv = {}, platform = process.platform, ...input } = options;
  const loc = locate({ home, env: processEnv, platform });
  const statePath = manifestPath(home, agent);
  const stateBefore = readText(statePath);
  const manifest = readManifest(stateBefore, agent);
  const { targets, other } = vendorTargets(agent, input, loc, {
    exists: existsSync,
    readJson(path) {
      try {
        return JSON.parse(readText(path) ?? "null");
      } catch {
        return undefined;
      }
    },
  });
  // Files selfhost wrote before but has no item for now still get their old settings removed.
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (targets.some((target) => target.path === path)) continue;
    const target: Target =
      entry.format === "toml"
        ? { kind: "toml", path, items: [] }
        : { kind: "tree", path, format: entry.format, items: [] };
    targets.push(target);
  }

  const items: PlanItem[] = [...other];
  const changes: FileChange[] = [];
  const files: Record<string, ManifestFile> = {};
  for (const target of targets) {
    const before = readText(target.path);
    const previous = manifest.files[target.path];
    const result =
      target.kind === "toml"
        ? planToml(target, before, previous)
        : planTree(target, before, previous);
    items.push(...result.items);
    if (result.after !== before) {
      changes.push({ path: target.path, role: "config", before, after: result.after });
    }
    if (result.manifest) files[target.path] = result.manifest;
  }

  const stateAfter =
    Object.keys(files).length > 0
      ? `${JSON.stringify({ schema: MANIFEST_SCHEMA, agent, files }, null, 2)}\n`
      : null;
  if (stateAfter !== stateBefore) {
    changes.push({ path: statePath, role: "state", before: stateBefore, after: stateAfter });
  }
  items.sort((a, b) => itemRank(a).localeCompare(itemRank(b)));
  return { agent, items, changes };
}

/**
 * Plans taking out everything selfhost wrote for an agent, restoring the keys the user had.
 * Pass the plan to applyAgentConfig.
 */
export function removeAgentConfig(
  agent: AgentId,
  options: Pick<PlanOptions, "home" | "processEnv" | "platform">,
): AgentConfigPlan {
  return planAgentConfig(agent, {
    home: options.home,
    processEnv: options.processEnv,
    platform: options.platform,
  });
}
