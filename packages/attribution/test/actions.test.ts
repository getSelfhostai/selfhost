import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentAccounts, agentLabels, agentPullCondition, webhookPullAgent } from "../src/index.js";
import { GITHUB_FIXTURES } from "./helpers.js";

/**
 * Just enough of the GitHub Actions expression language to run what agentPullCondition writes:
 * property paths, string literals, == and != (ignoring case), !, &&, ||, parentheses, and the
 * startsWith, contains and join functions with GitHub's case-insensitive string semantics.
 */
function evaluate(expression: string, context: Record<string, unknown>): unknown {
  const tokens = expression.match(/'(?:[^']|'')*'|==|!=|&&|\|\||[()!,]|[A-Za-z_][\w.*-]*/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected?: string) => {
    const token = tokens[at++];
    if (expected !== undefined && token !== expected)
      throw new Error(`expected ${expected}, got ${token}`);
    return token as string;
  };
  const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
  const lookup = (path: string): unknown => {
    let values: unknown[] = [context];
    let star = false;
    for (const part of path.split(".")) {
      if (part === "*") {
        star = true;
        values = values.flatMap((value) => (Array.isArray(value) ? value : []));
        continue;
      }
      values = values.map((value) => (value as Record<string, unknown> | undefined)?.[part]);
    }
    return star ? values : values[0];
  };
  const call = (name: string, args: unknown[]) => {
    if (name === "startsWith")
      return text(args[0]).toLowerCase().startsWith(text(args[1]).toLowerCase());
    if (name === "contains")
      return text(args[0]).toLowerCase().includes(text(args[1]).toLowerCase());
    if (name === "join") return (args[0] as unknown[]).map(text).join(text(args[1]));
    throw new Error(`unknown function ${name}`);
  };
  const primary = (): unknown => {
    const token = take();
    if (token === "(") {
      const value = or();
      take(")");
      return value;
    }
    if (token === "!") return !primary();
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token === "false" || token === "true") return token === "true";
    if (peek() === "(") {
      take("(");
      const args: unknown[] = [];
      while (peek() !== ")") {
        args.push(or());
        if (peek() === ",") take(",");
      }
      take(")");
      return call(token, args);
    }
    return lookup(token);
  };
  const compare = (): unknown => {
    const left = primary();
    const op = peek();
    if (op !== "==" && op !== "!=") return left;
    take();
    const right = primary();
    const same =
      typeof left === "string" && typeof right === "string"
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
    return op === "==" ? same : !same;
  };
  const and = (): unknown => {
    let value = compare();
    while (peek() === "&&") {
      take();
      const right = compare();
      value = Boolean(value) && Boolean(right);
    }
    return value;
  };
  const or = (): unknown => {
    let value = and();
    while (peek() === "||") {
      take();
      const right = and();
      value = Boolean(value) || Boolean(right);
    }
    return value;
  };
  const value = or();
  if (at !== tokens.length) throw new Error(`unparsed from ${tokens[at]}`);
  return value;
}

interface FixturePull {
  number: number;
  draft?: boolean;
  user: { login: string; type: string } | null;
  body: string | null;
  head: { ref: string };
  labels?: { name: string }[];
}

const pulls = (): FixturePull[] => {
  const dir = join(GITHUB_FIXTURES, "repos", "acme", "acme-api", "pulls");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
};

const run = (expression: string, pull: FixturePull, event: Record<string, unknown> = {}) =>
  evaluate(expression, {
    github: {
      event: { action: "opened", ...event, pull_request: { draft: false, labels: [], ...pull } },
    },
  });

describe("agentPullCondition", () => {
  const condition = agentPullCondition();

  it("agrees with webhookPullAgent on every fixture pull request", () => {
    const all = pulls();
    expect(all.length).toBeGreaterThan(5);
    for (const pull of all) {
      expect({ number: pull.number, runs: run(condition, pull) }).toEqual({
        number: pull.number,
        runs: webhookPullAgent(pull) !== undefined,
      });
    }
  });

  it("runs on an agent label, once: a labeled event only when nothing else marks the pull request", () => {
    const person = {
      number: 1,
      user: { login: "bob", type: "User" },
      body: "Fix",
      head: { ref: "fix" },
    };
    const label = { name: "selfhost:agent-codex" };
    expect(run(condition, person)).toBe(false);
    expect(run(condition, { ...person, labels: [label] }, { action: "synchronize" })).toBe(true);
    expect(run(condition, { ...person, labels: [label] }, { action: "labeled", label })).toBe(true);
    const branch = { ...person, head: { ref: "claude/x" }, labels: [label] };
    expect(run(condition, branch, { action: "labeled", label })).toBe(false);
    expect(run(condition, person, { action: "labeled", label: { name: "bug" } })).toBe(false);
  });

  it("never runs on a draft, and without label events checks labels already on it", () => {
    const agent = { number: 2, user: null, body: null, head: { ref: "codex/y" } };
    expect(run(condition, { ...agent, draft: true })).toBe(false);
    const plain = agentPullCondition({ labelEvents: false });
    expect(plain).not.toContain("github.event.action");
    expect(
      run(plain, {
        number: 3,
        user: { login: "bob", type: "User" },
        body: "",
        head: { ref: "x" },
        labels: [{ name: "selfhost:agent-claude-code" }],
      }),
    ).toBe(true);
  });

  it("lists the agent accounts and labels", () => {
    expect(agentAccounts()).toEqual(expect.arrayContaining(["claude[bot]", "copilot[bot]"]));
    expect(agentLabels()).toContain("selfhost:agent-claude-code");
  });
});
