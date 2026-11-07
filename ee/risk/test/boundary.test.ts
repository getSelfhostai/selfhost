import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** Workspace folders as pnpm-workspace.yaml lists them: `dir/*` globs and plain folders. */
function workspacePackages(): string[] {
  const yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const block = /^packages:\n((?:\s+- .+\n)+)/m.exec(yaml)?.[1] ?? "";
  const patterns = block
    .split("\n")
    .map((line) => line.replace(/^\s+- /, "").trim())
    .filter(Boolean);
  return patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const dir = pattern.slice(0, -2);
    return readdirSync(join(ROOT, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${dir}/${entry.name}`);
  });
}

interface Manifest {
  name: string;
  license?: string;
  private?: boolean;
  [field: string]: unknown;
}

const manifests = workspacePackages()
  .filter((dir) => existsSync(join(ROOT, dir, "package.json")))
  .map((dir) => ({
    dir,
    manifest: JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as Manifest,
  }));

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

describe("the ee/ license boundary", () => {
  it("lists ee/* as a workspace", () => {
    expect(manifests.map((m) => m.dir)).toContain("ee/risk");
  });

  it("keeps every package outside ee/ under Apache-2.0 and every package in it under ee/LICENSE", () => {
    for (const { dir, manifest } of manifests) {
      if (dir.startsWith("ee/")) {
        expect({ dir, license: manifest.license, private: manifest.private }).toEqual({
          dir,
          license: "SEE LICENSE IN ../LICENSE",
          private: true,
        });
      } else {
        expect({ dir, license: manifest.license }).toEqual({ dir, license: "Apache-2.0" });
      }
    }
    const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Manifest;
    expect(root.license).toBe("Apache-2.0");
  });

  it("lets only the CLI and the server depend on ee/ packages", () => {
    const eeNames = new Set(
      manifests.filter((m) => m.dir.startsWith("ee/")).map((m) => m.manifest.name),
    );
    const dependents = manifests
      .filter(({ dir }) => !dir.startsWith("ee/"))
      .flatMap(({ dir, manifest }) =>
        DEPENDENCY_FIELDS.flatMap((field) =>
          Object.keys((manifest[field] as Record<string, string> | undefined) ?? {})
            .filter((name) => eeNames.has(name) || name.startsWith("@selfhost/ee-"))
            .map((name) => `${dir} -> ${name}`),
        ),
      );
    expect(dependents).toEqual([
      "apps/cli -> @selfhost/ee-risk",
      "apps/server -> @selfhost/ee-risk",
    ]);
  });
});
