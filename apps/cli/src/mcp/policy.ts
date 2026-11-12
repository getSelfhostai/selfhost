import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { effectiveRules } from "@selfhost/policy";
import {
  type McpPolicyQuery,
  type PolicyResponse,
  parseConfig,
  parseRemote,
} from "@selfhost/schema";
import { findTeamPolicy } from "../find-config.js";
import { loadPolicy } from "../hooks/pretool.js";

const run = promisify(execFile);

/** owner/name of the repository at `cwd`, from its origin remote. */
export async function repoAt(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-C", cwd, "remote", "get-url", "origin"]);
    return parseRemote(stdout)?.repo;
  } catch {
    return undefined;
  }
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

export interface LocalPolicyIo {
  env: NodeJS.ProcessEnv;
  /** The folder the agent started selfhost mcp in: its repository. */
  cwd: string;
  /** ~/.selfhost/config.json, which holds a team membership and the pulled team policy. */
  configPath: string;
}

/** The ids of the rules a selfhost.toml text defines. */
function ruleIds(text: string): Set<string> {
  const parsed = parseConfig(text);
  return new Set(parsed.ok ? parsed.config.rules.map((rule) => rule.id) : []);
}

/**
 * The policy the hooks enforce in this repository, as get_policy returns it: the repository's
 * selfhost.toml, and on a machine in a team the team policy pulled by the last sync with the
 * repository's file on top (see policyText). A layered policy names its layers and the layer
 * each rule comes from. `found` is false when no selfhost.toml or team policy is here, so the
 * hooks run the built-in guardrails only.
 */
export async function localPolicy(
  io: LocalPolicyIo,
  query: Omit<McpPolicyQuery, "full">,
  person: string,
  now: Date,
): Promise<{ response: PolicyResponse; found: boolean; repo: string | undefined }> {
  const loaded = loadPolicy(io.cwd, io.env, io.configPath);
  const repo = await repoAt(io.cwd);
  const team = findTeamPolicy(io.configPath);
  const sources = loaded.sources ?? [];
  const [first, second] = sources;
  const teamText = second ? first?.text : first?.layer ? first.text : undefined;
  const repoText = second ? second.text : first?.layer ? undefined : first?.text;
  const layered = team !== undefined && teamText !== undefined;
  const teamRules = teamText !== undefined ? ruleIds(teamText) : new Set<string>();
  const rules = effectiveRules(loaded.config, {
    person: query.person ?? person,
    ...(query.agent ? { agent: query.agent } : {}),
  });
  const response: PolicyResponse = {
    hash: loaded.source?.hash ?? hashOf(""),
    ...(layered ? { team: team.team } : {}),
    ...(repo ? { repo } : {}),
    ...(layered
      ? {
          layers: [
            { kind: "team" as const, name: team.team },
            ...(repoText !== undefined
              ? [{ kind: "repo" as const, name: repo ?? second?.path ?? "selfhost.toml" }]
              : []),
          ],
        }
      : {}),
    ...(loaded.text !== undefined ? { text: loaded.text } : {}),
    loaded_at: now.toISOString(),
    config: loaded.config,
    effective_rules: rules,
    ...(layered
      ? {
          rule_layers: Object.fromEntries(
            loaded.config.rules.map((rule) => [
              rule.id,
              teamRules.has(rule.id) ? ("team" as const) : ("repo" as const),
            ]),
          ),
        }
      : {}),
  };
  return { response, found: loaded.source !== undefined, repo };
}
