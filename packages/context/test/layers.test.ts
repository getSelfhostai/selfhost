import { chmodSync, statSync, writeFileSync } from "node:fs";
import type { ContextFile } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import {
  buildContext,
  type ContextLayer,
  itemFiles,
  layerHash,
  mergeLayers,
  parseItemId,
  readLayerDir,
  readLayerFiles,
  withItem,
  writeLayerDir,
} from "../src/index.js";
import { temp } from "./helpers.js";

function layer(kind: ContextLayer["kind"], name: string, files: ContextFile[]): ContextLayer {
  const read = readLayerFiles(files, `${kind}:${name}`);
  if (!read.ok) throw new Error(JSON.stringify(read.errors));
  return { kind, name, source: read.source };
}

const rule = (name: string, text: string): ContextFile => ({ path: `rules/${name}.md`, text });
const mcp = (servers: Record<string, unknown>): ContextFile => ({
  path: "mcp.json",
  text: JSON.stringify({ mcpServers: servers }),
});

describe("mergeLayers", () => {
  it("adds items in the order org, team, repo, personal, whatever order they come in", () => {
    const merged = mergeLayers([
      layer("personal", "dev@example.com", [rule("mine", "Personal.\n")]),
      layer("repo", "api", [rule("repo-rule", "Repo.\n")]),
      layer("org", "acme", [rule("org-rule", "Org.\n")]),
      layer("team", "web", [rule("team-rule", "Team.\n")]),
    ]);
    expect(merged.conflicts).toEqual([]);
    expect(merged.source.rules.map((r) => [r.name, r.path])).toEqual([
      ["org-rule", "org:acme/rules/org-rule.md"],
      ["team-rule", "team:web/rules/team-rule.md"],
      ["repo-rule", "repo:api/rules/repo-rule.md"],
      ["mine", "personal:dev@example.com/rules/mine.md"],
    ]);
  });

  it("keeps the earlier layer's item on a conflict and names the one that lost", () => {
    const merged = mergeLayers([
      layer("org", "acme", [rule("no-secrets", "Never print secrets.\n")]),
      layer("team", "web", [
        rule("no-secrets", "Secrets are fine in tests.\n"),
        { path: "commands/review.md", text: "Review $ARGUMENTS.\n" },
      ]),
      layer("personal", "dev", [
        rule("no-secrets", "Print what you like.\n"),
        {
          path: "skills/review/SKILL.md",
          text: "---\nname: review\ndescription: Reviews.\nversion: 1.0.0\n---\nReview it.\n",
        },
      ]),
    ]);
    expect(merged.source.rules.map((r) => r.body)).toEqual(["Never print secrets.\n"]);
    expect(merged.source.skills).toEqual([]);
    expect(
      merged.conflicts.map((c) => [c.lost.item, c.lost.layer, c.kept.item, c.kept.layer]),
    ).toEqual([
      ["rule:no-secrets", "team", "rule:no-secrets", "org"],
      ["rule:no-secrets", "personal", "rule:no-secrets", "org"],
      ["skill:review", "personal", "command:review", "team"],
    ]);
    expect(merged.conflicts[0]?.message).toBe(
      "rule:no-secrets from the team layer (team:web/rules/no-secrets.md) is not used: the org layer (the org floor, which always wins) has rule:no-secrets (org:acme/rules/no-secrets.md), and the earlier layer wins.",
    );
  });

  it("merges MCP servers by name, so a team memory server reaches everyone", () => {
    const merged = mergeLayers([
      layer("team", "web", [mcp({ "team-memory": { url: "https://memory.acme.dev/mcp" } })]),
      layer("personal", "dev", [mcp({ notes: { command: "notes-mcp" } })]),
    ]);
    expect(merged.source.mcp.map((s) => [s.name, s.path])).toEqual([
      ["team-memory", "team:web/mcp.json"],
      ["notes", "personal:dev/mcp.json"],
    ]);
  });
});

describe("layer files", () => {
  it("reads a folder, writes it back and hashes it the same in any order", () => {
    const dir = temp();
    dir.write("rules/a.md", "A.\n");
    dir.write("skills/s/SKILL.md", "---\nname: s\ndescription: S.\nversion: 1.0.0\n---\nS.\n");
    dir.write("skills/s/run.sh", "#!/bin/sh\n");
    dir.write("README.md", "Not compiled.\n");
    dir.write(".DS_Store", "");
    chmodSync(dir.path("skills/s/run.sh"), 0o755);
    const files = readLayerDir(dir.root);
    expect(files.map((f) => [f.path, f.executable ?? false])).toEqual([
      ["rules/a.md", false],
      ["skills/s/SKILL.md", false],
      ["skills/s/run.sh", true],
    ]);
    const copy = temp();
    writeLayerDir(copy.path("layer"), files);
    expect(readLayerDir(copy.path("layer"))).toEqual(files);
    expect(statSync(copy.path("layer", "skills/s/run.sh")).mode & 0o111).not.toBe(0);
    expect(layerHash([...files].reverse())).toBe(layerHash(files));
  });

  it("refuses paths outside the layout and binary files", () => {
    expect(readLayerFiles([{ path: "../escape.md", text: "x" }], "team:web")).toMatchObject({
      ok: false,
    });
    expect(() => writeLayerDir(temp().root, [{ path: "rules/../../x.md", text: "x" }])).toThrow(
      /not a file of a context folder/,
    );
    const dir = temp();
    dir.write("rules/a.md", "ok");
    writeFileSync(dir.path("rules/b.md"), Buffer.from([0xff, 0xfe, 0x00]));
    expect(() => readLayerDir(dir.root)).toThrow(/not UTF-8 text/);
  });

  it("takes one item out of a layer and adds it to another", () => {
    const personal: ContextFile[] = [
      rule("mine", "Mine.\n"),
      mcp({ notes: { command: "notes-mcp" }, other: { command: "other" } }),
    ];
    const team: ContextFile[] = [rule("team", "Team.\n"), mcp({ memory: { url: "https://m" } })];
    const ref = parseItemId("mcp:notes");
    if (!ref) throw new Error("expected an item id");
    const notes = itemFiles(personal, ref);
    expect(JSON.parse(notes[0]?.text ?? "")).toEqual({
      mcpServers: { notes: { command: "notes-mcp" } },
    });
    const added = withItem(team, ref, notes);
    expect(JSON.parse(added.find((f) => f.path === "mcp.json")?.text ?? "").mcpServers).toEqual({
      memory: { url: "https://m" },
      notes: { command: "notes-mcp" },
    });
    const ruleRef = { kind: "rule", name: "mine" } as const;
    expect(withItem(team, ruleRef, itemFiles(personal, ruleRef)).map((f) => f.path)).toEqual([
      "mcp.json",
      "rules/mine.md",
      "rules/team.md",
    ]);
    expect(parseItemId("rule:Bad Name")).toBeUndefined();
    expect(parseItemId("widget:x")).toBeUndefined();
  });
});

describe("buildContext with layers", () => {
  it("compiles the merged layers, also in a repository without .selfhost/context", async () => {
    const repo = temp();
    const built = await buildContext(repo.root, {
      agents: ["claude_code"],
      layers: [
        layer("org", "acme", [rule("no-secrets", "Never print secrets.\n")]),
        layer("personal", "dev", [rule("no-secrets", "Anything goes.\n"), rule("tabs", "Tabs.\n")]),
      ],
    });
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    expect(built.layers.map((l) => l.kind)).toEqual(["org", "repo", "personal"]);
    expect(built.conflicts.map((c) => c.lost.path)).toEqual(["personal:dev/rules/no-secrets.md"]);
    const claude = built.plan.files.find((f) => f.path === "CLAUDE.md");
    const text = String(claude?.after);
    expect(text).toContain("Never print secrets.");
    expect(text).toContain("Tabs.");
    expect(text).not.toContain("Anything goes.");
    expect(text.indexOf("Never print secrets.")).toBeLessThan(text.indexOf("Tabs."));
  });

  it("still needs .selfhost/context when there are no other layers", async () => {
    expect(await buildContext(temp().root)).toMatchObject({ ok: false });
  });
});
