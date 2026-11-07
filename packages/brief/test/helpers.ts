import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ChangedFile, parseHunks } from "@selfhost/pr";
import type { BriefInputs } from "../src/index.js";

export const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");
export const BRIEF_FIXTURES = join(FIXTURES, "brief");

export const FIXTURE_NAMES = ["agent-pr", "no-run", "local"] as const;

type FixtureFile = Omit<ChangedFile, "hunks"> & { patch?: string };

/** A fixture run: files carry their patch as GitHub returns it, parsed into hunks here. */
export function fixture(name: (typeof FIXTURE_NAMES)[number]): BriefInputs {
  const { inputs } = JSON.parse(readFileSync(join(BRIEF_FIXTURES, `${name}.json`), "utf8")) as {
    inputs: Omit<BriefInputs, "files"> & { files: FixtureFile[] };
  };
  return {
    ...inputs,
    files: inputs.files.map(({ patch, ...file }) =>
      patch === undefined ? file : { ...file, hunks: parseHunks(patch) },
    ),
  };
}
