import { connected, failed } from "../http.js";
import type { CheckResult, RepoView } from "../types.js";

export interface WorkflowTool {
  name: string;
  /** Matches the `uses:` line of the tool's step. */
  uses: RegExp;
  /** How to add the workflow, for when no repository has it. */
  howTo: string;
  /** api_key_env: the workflow should pass it, so the check says when none mentions it. */
  keyEnv?: string;
  /** A workflow that runs the tool this way fails the check, with why. */
  refuse?: { test(text: string): boolean; why: string };
}

const list = (items: readonly string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * A reviewer that runs in CI is set up when a workflow in .github/workflows uses its action. Reads
 * each of the team's repositories through `repos`; the network is never called.
 */
export async function workflowCheck(
  tool: WorkflowTool,
  repos: RepoView | undefined,
): Promise<CheckResult> {
  if (!repos || repos.repos.length === 0) {
    const setup =
      repos?.setup ??
      "Run the check inside the repository, or on a team server with the selfhost GitHub App.";
    return failed(
      `${tool.name} runs in CI, so selfhost looks for its workflow in the team's repositories, and it has none to read. ${setup}`,
    );
  }
  const found: string[] = [];
  const missing: string[] = [];
  const unreadable: string[] = [];
  let mentionsKey = false;
  for (const repo of repos.repos) {
    const files = await repos.workflows(repo);
    if (files === undefined) {
      unreadable.push(repo);
      continue;
    }
    const using = files.filter((file) => tool.uses.test(file.text));
    if (using.length === 0) missing.push(repo);
    for (const file of using) {
      if (tool.refuse?.test(file.text))
        return failed(`${file.path} in ${repo}: ${tool.refuse.why}`);
      found.push(`${file.path} in ${repo}`);
      if (tool.keyEnv && file.text.includes(tool.keyEnv)) mentionsKey = true;
    }
  }
  if (found.length > 0) {
    const notIn = missing.length > 0 ? ` Not in ${list(missing)}.` : "";
    const key =
      tool.keyEnv && !mentionsKey
        ? ` No workflow mentions ${tool.keyEnv} (api_key_env); check the step gets its key.`
        : "";
    const name = `${tool.name.charAt(0).toUpperCase()}${tool.name.slice(1)}`;
    return connected(`${name} runs from ${list(found)}.${notIn}${key}`);
  }
  if (missing.length === 0) {
    return failed(
      `Could not read .github/workflows in ${list(unreadable)} through ${repos.via}. ${repos.setup}`,
    );
  }
  return failed(`No workflow in ${list(missing)} runs ${tool.name}. ${tool.howTo}`);
}
