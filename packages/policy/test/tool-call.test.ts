import { describe, expect, it } from "vitest";
import { mcpServerOf, normalizePath, toolCallFromEvent } from "../src/index.js";
import { toolEvent } from "./helpers.js";

const TS = "2026-10-06T10:00:00.000Z";

describe("mcpServerOf", () => {
  it("reads the server from Claude Code MCP tool names", () => {
    expect(mcpServerOf("mcp__github__create_pull_request")).toBe("github");
    expect(mcpServerOf("mcp__plugin_acme_docs__search")).toBe("plugin_acme_docs");
    expect(mcpServerOf("mcp__acme-docs__search_pages")).toBe("acme-docs");
  });

  it("reads the server from Codex MCP tool names", () => {
    expect(mcpServerOf("mcp__linear__list_issues")).toBe("linear");
    expect(mcpServerOf("mcp__sentry__get_issue_details")).toBe("sentry");
  });

  it("keeps the rest of the name when the tool part is cut off", () => {
    expect(mcpServerOf("mcp__a-very-long-server-name-that-was-shortened0f3c")).toBe(
      "a-very-long-server-name-that-was-shortened0f3c",
    );
  });

  it("is undefined for built-in tools", () => {
    for (const tool of ["Bash", "Edit", "exec_command", "apply_patch", "mcp__", "mcp____x"]) {
      expect(mcpServerOf(tool)).toBeUndefined();
    }
  });
});

describe("normalizePath", () => {
  it("drops ./ and resolves .. inside the path", () => {
    expect(normalizePath("./db/migrations/../migrations/001.sql")).toBe("db/migrations/001.sql");
    expect(normalizePath("src/app.ts")).toBe("src/app.ts");
  });
});

describe("toolCallFromEvent", () => {
  it("maps commands, files, URLs, MCP servers, agents and models", () => {
    expect(
      toolCallFromEvent(
        toolEvent({
          session: "s1",
          ts: TS,
          tool: "Bash",
          model: "claude-opus-5-5",
          target: { type: "command", value: "git push --force origin main" },
        }),
      ),
    ).toEqual({
      agent: "claude_code",
      tool: "Bash",
      command: "git push --force origin main",
      model: "claude-opus-5-5",
    });
    expect(
      toolCallFromEvent(
        toolEvent({
          session: "s1",
          ts: TS,
          tool: "Edit",
          target: { type: "file", value: "./a.ts" },
        }),
      ),
    ).toEqual({ agent: "claude_code", tool: "Edit", path: "a.ts" });
    expect(
      toolCallFromEvent(
        toolEvent({
          session: "s1",
          ts: TS,
          tool: "WebFetch",
          target: { type: "url", value: "https://pastebin.com/raw/x" },
        }),
      ),
    ).toEqual({ agent: "claude_code", tool: "WebFetch", url: "https://pastebin.com/raw/x" });
    expect(
      toolCallFromEvent(
        toolEvent({ session: "s1", ts: TS, tool: "mcp__linear__list_issues", agent: "codex" }),
      ),
    ).toEqual({ agent: "codex", tool: "mcp__linear__list_issues", mcpServer: "linear" });
  });

  it("ignores events that are not tool calls", () => {
    const event = toolEvent({ session: "s1", ts: TS, tool: "Bash" });
    expect(toolCallFromEvent({ ...event, kind: "tool.result" })).toBeUndefined();
  });

  describe("with a repository root", () => {
    const root = "/home/dev/acme-api";
    const edit = (value: string) =>
      toolEvent({ session: "s1", ts: TS, tool: "Edit", target: { type: "file", value } });
    const bash = toolEvent({
      session: "s1",
      ts: TS,
      tool: "Bash",
      target: { type: "command", value: "npm test" },
    });

    it("keeps calls from sessions inside the repository, with repo-relative paths", () => {
      expect(toolCallFromEvent(edit("migrations/001.sql"), root, `${root}/db`)?.path).toBe(
        "db/migrations/001.sql",
      );
      expect(toolCallFromEvent(edit(`${root}/src/app.ts`), root, root)?.path).toBe("src/app.ts");
      expect(toolCallFromEvent(bash, root, `${root}/packages/web`)?.command).toBe("npm test");
    });

    it("drops the path of a file outside the repository but keeps the call", () => {
      expect(toolCallFromEvent(edit("/etc/hosts"), root, root)).toEqual({
        agent: "claude_code",
        tool: "Edit",
      });
      expect(toolCallFromEvent(edit("../acme-api-old/x.ts"), root, root)).toEqual({
        agent: "claude_code",
        tool: "Edit",
      });
    });

    it("keeps a file edited by absolute path from a session outside the repository", () => {
      expect(toolCallFromEvent(edit(`${root}/src/app.ts`), root, "/home/dev")?.path).toBe(
        "src/app.ts",
      );
      expect(toolCallFromEvent(edit(`${root}/src/app.ts`), root, undefined)?.path).toBe(
        "src/app.ts",
      );
    });

    it("leaves out calls it cannot place in the repository", () => {
      expect(toolCallFromEvent(bash, root, "/home/dev/other")).toBeUndefined();
      expect(toolCallFromEvent(bash, root, undefined)).toBeUndefined();
      expect(toolCallFromEvent(edit("src/app.ts"), root, undefined)).toBeUndefined();
      expect(toolCallFromEvent(edit("src/app.ts"), root, "/home/dev/acme-api-old")).toBeUndefined();
    });
  });
});
