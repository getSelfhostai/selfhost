import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { goldenPath, listFiles, writeFolder } from "@selfhost/compile/golden";
import { CONTEXT_AGENTS, type ContextAgent } from "@selfhost/schema";
import { afterAll, describe, expect, it } from "vitest";
import { buildContext } from "../src/index.js";

// Golden files: fixtures/context-source/repo holds a .selfhost/context source (and a .ruler/ file),
// and fixtures/context-source/expected/<target>/ what it compiles to for one agent alone, or for all of
// them, plus coverage.json. Paths git often ignores locally get a .out suffix (CLAUDE.md.out,
// .claude.out/). A change in the output fails here until the fixtures are regenerated on
// purpose: UPDATE_GOLDEN=1 pnpm --filter @selfhost/context test.
const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures", "context-source");
const REPO = join(FIXTURES, "repo");
const EXPECTED = join(FIXTURES, "expected");
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const HINT = "Regenerate on purpose with UPDATE_GOLDEN=1 pnpm --filter @selfhost/context test.";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function compiled(
  agents: readonly ContextAgent[],
): Promise<Map<string, string | Uint8Array>> {
  const out = mkdtempSync(join(tmpdir(), "selfhost-context-golden-"));
  dirs.push(out);
  const built = await buildContext(REPO, { agents, out });
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  const files = new Map<string, string | Uint8Array>();
  for (const file of built.plan.files) {
    if (file.after !== null) files.set(goldenPath(file.path), file.after);
  }
  files.set("coverage.json", `${JSON.stringify(built.result.coverage, null, 2)}\n`);
  return files;
}

function matchesFolder(dir: string, expected: Map<string, string | Uint8Array>): void {
  if (UPDATE) {
    writeFolder(dir, expected);
    return;
  }
  const shown = relative(join(FIXTURES, "..", ".."), dir);
  expect(listFiles(dir).sort(), `files in ${shown}. ${HINT}`).toEqual([...expected.keys()].sort());
  for (const [name, content] of expected) {
    const actual = readFileSync(join(dir, name));
    if (typeof content === "string") {
      expect(actual.toString("utf8"), `${shown}/${name} drifted. ${HINT}`).toBe(content);
    } else {
      expect(actual.equals(Buffer.from(content)), `${shown}/${name} drifted. ${HINT}`).toBe(true);
    }
  }
}

describe("golden files", () => {
  it("has one folder per agent and one for all of them", () => {
    if (UPDATE) return;
    expect(readdirSync(EXPECTED).sort()).toEqual([...CONTEXT_AGENTS, "all"].sort());
  });

  it.each(CONTEXT_AGENTS.map((agent) => [agent]))(
    "compiles fixtures/context-source/repo for %s alone as in expected/<agent>",
    async (agent) => {
      matchesFolder(join(EXPECTED, agent), await compiled([agent]));
    },
  );

  it("compiles fixtures/context-source/repo for every agent as in expected/all", async () => {
    matchesFolder(join(EXPECTED, "all"), await compiled(CONTEXT_AGENTS));
  });
});
