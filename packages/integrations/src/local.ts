import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoView, WorkflowFile } from "./types.js";

const WORKFLOWS = ".github/workflows";
const WORKFLOW_FILE = /\.ya?ml$/;

/** The workflow files of a checkout; undefined when .github/workflows cannot be read. */
export function readWorkflows(dir: string): WorkflowFile[] | undefined {
  let names: string[];
  try {
    names = readdirSync(join(dir, WORKFLOWS));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined;
  }
  return names
    .filter((name) => WORKFLOW_FILE.test(name))
    .sort()
    .flatMap((name) => {
      try {
        return [
          { path: `${WORKFLOWS}/${name}`, text: readFileSync(join(dir, WORKFLOWS, name), "utf8") },
        ];
      } catch {
        return [];
      }
    });
}

/**
 * One checkout on this machine, for reviewer checks from the CLI: its workflow files only. GitHub
 * App installations cannot be seen from here.
 */
export function localRepoView(dir: string, repo: string): RepoView {
  return {
    via: "this checkout",
    repos: [repo],
    setup: `Check ${WORKFLOWS} in ${dir} can be read.`,
    workflows: async () => readWorkflows(dir),
  };
}
