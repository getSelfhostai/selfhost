import { describe, expect, it } from "vitest";
import {
  effectiveRules,
  evaluate,
  type PolicyHit,
  policyChecks,
  type ToolCall,
} from "../src/index.js";
import { CATEGORIES_TOML, config } from "./helpers.js";

// One describe per policy category, all against the schema fixture policy-categories.toml.
const policy = config(CATEGORIES_TOML);
const ids = (hits: PolicyHit[]) => hits.map((hit) => hit.rule_id);
const bash = (command: string, extra: Partial<ToolCall> = {}): ToolCall => ({
  agent: "claude_code",
  tool: "Bash",
  command,
  ...extra,
});

describe("blocked commands", () => {
  it("records a block for a command that matches the pattern anywhere", () => {
    expect(evaluate(policy, bash("cd api && git push origin main --force"))).toEqual([
      {
        rule_id: "no-force-push",
        mode: "observe",
        verdict: "block",
        message: "Force pushes are blocked. Open a PR instead.",
        irreversible: true,
      },
    ]);
    expect(evaluate(policy, bash("git push origin main"))).toEqual([]);
  });

  it("matches shell calls from every agent when the rule names no tool", () => {
    const codex: ToolCall = {
      agent: "codex",
      tool: "exec_command",
      command: "git push -u --force",
    };
    expect(ids(evaluate(policy, codex))).toEqual(["no-force-push"]);
  });

  it("applies the team's mode", () => {
    expect(evaluate(policy, bash("git push --force"), { team: "platform" })[0]?.mode).toBe(
      "enforce",
    );
    expect(evaluate(policy, bash("git push --force"), { team: "growth" })[0]?.mode).toBe("observe");
    expect(evaluate(policy, bash("git push --force"), { team: "nobody" })[0]?.mode).toBe("observe");
  });

  it("fires an agent-limited rule only for the agents it lists", () => {
    const reset = "git reset --hard HEAD~1";
    expect(ids(evaluate(policy, bash(reset)))).toEqual(["ask-before-reset-hard"]);
    expect(evaluate(policy, bash(reset, { agent: "codex" }))).toEqual([]);
    expect(evaluate(policy, { tool: "Bash", command: reset })).toEqual([]);
  });

  it("needs every field of the match", () => {
    expect(evaluate(policy, bash("git reset --hard", { tool: "exec_command" }))).toEqual([]);
    expect(evaluate(policy, { agent: "claude_code", tool: "Bash" })).toEqual([]);
  });
});

describe("protected paths", () => {
  const edit = (path: string): ToolCall => ({ agent: "codex", tool: "apply_patch", path });

  it("matches globs against repo-relative paths", () => {
    expect(evaluate(policy, edit("db/migrations/2026/001_users.sql"))).toEqual([
      {
        rule_id: "protect-migrations",
        mode: "enforce",
        verdict: "ask",
        message: "Migrations need a human review.",
        irreversible: false,
      },
    ]);
    expect(evaluate(policy, edit("db/seeds/users.sql"))).toEqual([]);
    expect(evaluate(policy, edit("src/db/migrations/x.sql"))).toEqual([]);
  });

  it("matches dotfiles at any depth", () => {
    expect(ids(evaluate(policy, edit(".env")))).toEqual(["no-env-files"]);
    expect(ids(evaluate(policy, edit("apps/web/.env.local")))).toEqual(["no-env-files"]);
    expect(evaluate(policy, edit("apps/web/env.ts"))).toEqual([]);
  });

  it("does not fire a path rule on a call without a path", () => {
    expect(evaluate(policy, { agent: "codex", tool: "apply_patch" })).toEqual([]);
  });

  it("skips a rule the team turned off", () => {
    expect(evaluate(policy, edit("db/migrations/001.sql"), { team: "growth" })).toEqual([]);
  });
});

describe("allowed MCP servers", () => {
  const mcp = (tool: string, agent: ToolCall["agent"] = "claude_code"): ToolCall => ({
    agent,
    tool,
    mcpServer: tool.split("__")[1],
  });

  it("lets servers on the list through, by name or glob", () => {
    expect(evaluate(policy, mcp("mcp__github__create_pull_request"))).toEqual([]);
    expect(evaluate(policy, mcp("mcp__acme-docs__search", "codex"))).toEqual([]);
  });

  it("records a block for any other server", () => {
    expect(evaluate(policy, mcp("mcp__slack__post_message", "codex"))).toEqual([
      {
        rule_id: "mcp.allow",
        mode: "observe",
        verdict: "block",
        message: 'MCP server "slack" is not in [mcp] allow.',
        irreversible: false,
      },
    ]);
  });

  it("applies the team's mode and message", () => {
    expect(evaluate(policy, mcp("mcp__slack__post_message"), { team: "platform" })).toEqual([
      {
        rule_id: "mcp.allow",
        mode: "enforce",
        verdict: "block",
        message: "Platform agents only use the github and acme MCP servers.",
        irreversible: false,
      },
    ]);
  });

  it("allows every server when the list is empty", () => {
    const open = config("version = 1\n[mcp]\nmode = 'enforce'\n");
    expect(evaluate(open, mcp("mcp__slack__post_message"))).toEqual([]);
  });
});

describe("allowed models", () => {
  const on = (model: string): ToolCall => ({ agent: "codex", tool: "exec_command", model });

  it("lets models on the list through", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5", "gpt-5.5", "gpt-5.4-mini"]) {
      expect(evaluate(policy, on(model))).toEqual([]);
    }
  });

  it("records a block for any other model, and nothing when the model is unknown", () => {
    expect(evaluate(policy, on("o3"))).toEqual([
      {
        rule_id: "models.allow",
        mode: "observe",
        verdict: "block",
        message: 'Model "o3" is not in [models] allow.',
        irreversible: false,
      },
    ]);
    expect(evaluate(policy, { agent: "codex", tool: "exec_command" })).toEqual([]);
  });

  it("skips the check for a team that turned it off", () => {
    expect(evaluate(policy, on("o3"), { team: "growth" })).toEqual([]);
  });
});

describe("egress", () => {
  const fetch = (url: string): ToolCall => ({ agent: "claude_code", tool: "WebFetch", url });

  it("matches URL globs", () => {
    expect(ids(evaluate(policy, fetch("https://pastebin.com/raw/x1y2")))).toEqual([
      "no-paste-sites",
    ]);
    expect(ids(evaluate(policy, fetch("https://pastebin.com")))).toEqual(["no-paste-sites"]);
    expect(evaluate(policy, fetch("https://docs.example.com/pastebin.com/"))).toEqual([]);
  });

  it("never fires a rule in mode off", () => {
    expect(evaluate(policy, fetch("https://api.prod.acme.internal/v1/users"))).toEqual([]);
  });
});

describe("evaluate", () => {
  const busy: ToolCall = {
    agent: "claude_code",
    tool: "Bash",
    command: "git push --force",
    path: ".env",
    url: "https://pastebin.com/x",
    mcpServer: "slack",
    model: "o3",
  };

  it("reports hits in file order, then mcp.allow, then models.allow", () => {
    expect(ids(evaluate(policy, busy))).toEqual([
      "no-force-push",
      "no-env-files",
      "no-paste-sites",
      "mcp.allow",
      "models.allow",
    ]);
  });

  it("gives the same result every time and for equal inputs in any order", () => {
    const first = evaluate(policy, busy, { team: "platform" });
    for (let i = 0; i < 100; i++)
      expect(evaluate(policy, busy, { team: "platform" })).toEqual(first);

    const reordered = config(CATEGORIES_TOML);
    reordered.mcp.allow.reverse();
    reordered.models.allow.reverse();
    reordered.teams = Object.fromEntries(Object.entries(reordered.teams).reverse());
    const sameCall = Object.fromEntries(Object.entries(busy).reverse()) as ToolCall;
    expect(evaluate(reordered, sameCall, { team: "platform" })).toEqual(first);
  });

  it("does not change the config", () => {
    const before = structuredClone(policy);
    evaluate(policy, busy, { team: "platform" });
    expect(policy).toEqual(before);
  });
});

describe("policyChecks", () => {
  it("lists every check with the team's mode, including the ones that are off", () => {
    const modes = (team?: string) =>
      policyChecks(policy, { team }).map((check) => `${check.id}:${check.mode}`);
    expect(modes()).toEqual([
      "no-force-push:observe",
      "ask-before-reset-hard:observe",
      "protect-migrations:enforce",
      "no-env-files:observe",
      "no-paste-sites:observe",
      "no-prod-urls:off",
      "mcp.allow:observe",
      "models.allow:observe",
    ]);
    expect(modes("growth")).toContain("models.allow:off");
    expect(modes("platform")).toContain("mcp.allow:enforce");
  });

  it("leaves out allow lists that are empty", () => {
    expect(policyChecks(config("version = 1\n[mcp]\nmode = 'enforce'\n"))).toEqual([]);
  });
});

describe("effectiveRules", () => {
  it("applies the overrides of the team and of every team listing the person", () => {
    const rules = (scope: Parameters<typeof effectiveRules>[1]) =>
      effectiveRules(policy, scope).map((rule) => `${rule.id}:${rule.mode}`);
    expect(rules({ team: "platform" })).toContain("no-force-push:enforce");
    expect(rules({ team: "other", person: "alice@example.com" })).toContain(
      "no-force-push:enforce",
    );
    expect(rules({ team: "other", person: "carol" })).not.toContain("protect-migrations:enforce");
    expect(rules({ team: "other" })).not.toContain("no-prod-urls:off");
    expect(rules({ team: "other", agent: "codex" })).not.toContain("ask-before-reset-hard:observe");
  });
});
