import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

interface Manifest {
  name: string;
  license?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Every workspace package by name, with its folder. */
function workspace(): Map<string, { dir: string; manifest: Manifest }> {
  const packages = new Map<string, { dir: string; manifest: Manifest }>();
  for (const parent of ["packages", "apps", "adapters", "ee"]) {
    if (!existsSync(join(ROOT, parent))) continue;
    for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
      const file = join(ROOT, parent, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
      packages.set(manifest.name, { dir: `${parent}/${entry.name}`, manifest });
    }
  }
  return packages;
}

/** The workspace packages a package needs at run time, itself included. */
function runtimeGraph(name: string): string[] {
  const packages = workspace();
  const seen = new Set<string>();
  const visit = (current: string) => {
    if (seen.has(current)) return;
    seen.add(current);
    for (const dependency of Object.keys(packages.get(current)?.manifest.dependencies ?? {})) {
      if (packages.has(dependency)) visit(dependency);
    }
  };
  visit(name);
  return [...seen].sort();
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("the brief without ee/", () => {
  it("depends on no ee/ package, directly or through another package", () => {
    const packages = workspace();
    for (const name of ["@selfhost/brief", "@selfhost/pr"]) {
      const graph = runtimeGraph(name);
      expect(graph).toContain(name);
      const ee = graph.filter(
        (dependency) =>
          dependency.startsWith("@selfhost/ee-") || packages.get(dependency)?.dir.startsWith("ee/"),
      );
      expect({ name, ee }).toEqual({ name, ee: [] });
      for (const dependency of graph) {
        expect({ dependency, license: packages.get(dependency)?.manifest.license }).toEqual({
          dependency,
          license: "Apache-2.0",
        });
      }
    }
  });

  it("imports nothing from ee/ in the code it runs", () => {
    const packages = workspace();
    const dirs = runtimeGraph("@selfhost/brief").map((name) => `${packages.get(name)?.dir}/src`);
    const offenders = dirs
      .flatMap(sourceFiles)
      .filter((file) =>
        /from\s+["'](?:@selfhost\/ee-|[^"']*\/ee\/)/.test(readFileSync(file, "utf8")),
      );
    expect(offenders).toEqual([]);
  });
});
