import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeVersionProblem } from "../src/node-version.js";

describe("an older Node", () => {
  it("gets one line naming the version it needs and the one it has", () => {
    expect(nodeVersionProblem({ node: "16.17.0" })).toBe(
      "selfhost needs Node 20 or newer; you have Node 16.17.0. Install a newer Node (nodejs.org, or nvm install 20) and run it again.",
    );
    expect(nodeVersionProblem({ node: "18.20.4" })).toMatch(/^selfhost needs Node 20 or newer/);
    expect(nodeVersionProblem({})).toMatch(/you have an unknown version/);
    expect(nodeVersionProblem({ node: "20.0.0" })).toBeUndefined();
    expect(nodeVersionProblem({ node: "22.22.0" })).toBeUndefined();
    // The standalone binaries run on Bun.
    expect(nodeVersionProblem({ node: "16.0.0", bun: "1.2.0" })).toBeUndefined();
  });

  it("is checked before main.ts loads anything that needs Node 20", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "src", "main.ts"), "utf8");
    const statics = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(statics).toEqual(["./node-version.js"]);
    expect(
      readFileSync(join(import.meta.dirname, "..", "src", "node-version.ts"), "utf8"),
    ).not.toMatch(/^import /m);
    expect(source.indexOf("nodeVersionProblem(process.versions)")).toBeLessThan(
      source.indexOf("await import("),
    );
  });
});
