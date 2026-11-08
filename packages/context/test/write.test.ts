import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatContextItem, readContextSource, writeContextItem } from "../src/index.js";
import { temp } from "./helpers.js";

describe("writeContextItem", () => {
  it("writes one item of each kind that the reader reads back the same", () => {
    const dir = temp();
    expect(
      writeContextItem(dir.root, {
        kind: "rule",
        name: "api",
        agents: ["claude_code", "cursor"],
        globs: ["src/api/**"],
        body: "Validate input.",
      }),
    ).toEqual([".selfhost/context/rules/api.md"]);
    writeContextItem(dir.root, { kind: "rule", name: "plain", body: "Be brief.\n" });
    writeContextItem(dir.root, {
      kind: "skill",
      name: "deploy",
      description: "Deploys the app.",
      version: "2.0.1",
      extra: { "allowed-tools": "Bash(make deploy)" },
      body: "Run make deploy.",
      files: [{ path: "scripts/check.sh", content: "#!/bin/sh\nexit 0\n", executable: true }],
    });
    writeContextItem(dir.root, {
      kind: "command",
      name: "ship",
      description: "Ship it",
      argumentHint: "<version>",
      body: "Tag $ARGUMENTS and push.",
    });
    writeContextItem(dir.root, {
      kind: "agent",
      name: "reviewer",
      description: "Reviews diffs.",
      tools: ["Read", "Grep"],
      model: { claude_code: "sonnet" },
      body: "Find bugs.",
    });
    writeContextItem(dir.root, { kind: "mcp", name: "docs", server: { command: "docs-mcp" } });
    writeContextItem(dir.root, {
      kind: "mcp",
      name: "remote",
      server: { type: "http", url: "https://mcp.example.com", headers: { "X-Team": "a" } },
    });

    const read = readContextSource(dir.root);
    if (!read.ok) throw new Error(JSON.stringify(read.errors));
    const { source } = read;
    expect(source.rules.map((rule) => [rule.name, rule.agents, rule.globs, rule.body])).toEqual([
      ["api", ["claude_code", "cursor"], ["src/api/**"], "Validate input.\n"],
      ["plain", expect.any(Array), [], "Be brief.\n"],
    ]);
    expect(readFileSync(dir.path(".selfhost/context/rules/plain.md"), "utf8")).toBe("Be brief.\n");
    const deploy = source.skills[0];
    expect([
      deploy?.version,
      deploy?.frontMatter["allowed-tools"],
      deploy?.files[0]?.executable,
    ]).toEqual(["2.0.1", "Bash(make deploy)", true]);
    expect(
      statSync(dir.path(".selfhost/context/skills/deploy/scripts/check.sh")).mode & 0o111,
    ).not.toBe(0);
    expect(source.commands[0]).toMatchObject({
      argumentHint: "<version>",
      body: "Tag $ARGUMENTS and push.\n",
    });
    expect(source.agents[0]).toMatchObject({
      tools: ["Read", "Grep"],
      model: { claude_code: "sonnet" },
    });
    expect(source.mcp.map((server) => server.name)).toEqual(["docs", "remote"]);
  });

  it("refuses to replace an item unless asked, and merges MCP servers", () => {
    const dir = temp();
    const rule = { kind: "rule", name: "a", body: "One." } as const;
    writeContextItem(dir.root, rule);
    expect(() => writeContextItem(dir.root, rule)).toThrow(/already exists/);
    writeContextItem(dir.root, { ...rule, body: "Two." }, { overwrite: true });
    expect(readFileSync(dir.path(".selfhost/context/rules/a.md"), "utf8")).toBe("Two.\n");
    const server = { kind: "mcp", name: "x", server: { command: "x" } } as const;
    writeContextItem(dir.root, server);
    expect(() => writeContextItem(dir.root, server)).toThrow(/already has a server named x/);
  });

  it("validates before writing anything", () => {
    expect(() =>
      formatContextItem({
        kind: "skill",
        name: "Bad_Name",
        description: "d",
        version: "1",
        body: "b",
      }),
    ).toThrow(/skill Bad_Name is not valid: name: .*; version: /);
    expect(() => formatContextItem({ kind: "mcp", name: "x", server: {} })).toThrow(
      /either a command \(stdio\) or a url/,
    );
    expect(() => formatContextItem({ kind: "rule", name: "has space", body: "b" })).toThrow(
      /name must be/,
    );
    expect(() =>
      formatContextItem({
        kind: "skill",
        name: "ok",
        description: "d",
        version: "1.0.0",
        body: "b",
        files: [{ path: "../escape.sh", content: "" }],
      }),
    ).toThrow(/not a path inside the skill folder/);
  });
});
