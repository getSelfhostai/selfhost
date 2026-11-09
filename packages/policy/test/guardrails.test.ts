import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkToolCall,
  decide,
  GUARDRAILS,
  guardrailChecks,
  guardrailHits,
  isSecretPath,
  type PolicyHit,
  selfhostDecisionCommand,
  shellCommands,
  type ToolCall,
  type ToolCallChecker,
} from "../src/index.js";
import { config, FIXTURES } from "./helpers.js";

const WORKSPACE = "/home/dev/acme-api";
const HOME = "/home/dev";
const ENV = { HOME, TMPDIR: "/tmp" };

interface Case {
  id: string;
  shell?: string;
  read?: string;
  write?: string;
  mcp?: { server: string; tool: string };
  verdict: "allow" | "block" | "ask";
  rule_id?: string;
  mode?: "observe" | "enforce";
}

const dir = join(FIXTURES, "guardrails");
const policy = config(readFileSync(join(dir, "selfhost.toml"), "utf8"));
const cases = (JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as { cases: Case[] })
  .cases;

const fill = (text: string) => text.replaceAll("{workspace}", WORKSPACE).replaceAll("{home}", HOME);

/** A file argument as a pre-tool hook passes it: relative inside the workspace, else absolute. */
function filePath(value: string): string {
  const path = fill(value);
  if (path.startsWith("~/")) return `${HOME}${path.slice(1)}`;
  return path;
}

/** The agent-neutral call for a fixture case. */
export function fixtureCall(c: Case): ToolCall {
  const base = { agent: "claude_code" as const, cwd: WORKSPACE, root: WORKSPACE };
  if (c.shell !== undefined) return { ...base, tool: "Bash", command: fill(c.shell) };
  if (c.read !== undefined)
    return { ...base, tool: "Read", path: filePath(c.read), access: "read" };
  if (c.write !== undefined) {
    return { ...base, tool: "Write", path: filePath(c.write), access: "write" };
  }
  if (c.mcp) {
    const tool = `mcp__${c.mcp.server}__${c.mcp.tool}`;
    return { ...base, tool, mcpServer: c.mcp.server };
  }
  throw new Error(`case ${c.id} names no call`);
}

const bash = (command: string, extra: Partial<ToolCall> = {}): ToolCall => ({
  agent: "claude_code",
  tool: "Bash",
  command,
  cwd: WORKSPACE,
  root: WORKSPACE,
  ...extra,
});

const ids = (hits: PolicyHit[]) => hits.map((hit) => hit.rule_id);

describe("the shared fixture cases", () => {
  it.each(cases.map((c) => [c.id, c] as const))("%s", async (_, c) => {
    const decision = await checkToolCall(policy, fixtureCall(c), { env: ENV });
    expect(decision.verdict).toBe(c.verdict);
    expect(decision.hit?.rule_id).toBe(c.rule_id);
    if (c.mode) expect(decision.hit?.mode).toBe(c.mode);
    expect(decision.failures).toEqual([]);
  });

  it("covers every guardrail with at least one block", () => {
    const blocked = new Set(cases.filter((c) => c.verdict === "block").map((c) => c.rule_id));
    for (const id of Object.keys(GUARDRAILS)) expect(blocked).toContain(id);
  });
});

describe("guardrail settings", () => {
  it("lists every guardrail in the [guardrails] mode, with disabled ones off", () => {
    const off = config(`version = 1
[guardrails]
mode = "observe"
disable = ["guard.reset_hard"]
`);
    expect(guardrailChecks(off).map((check) => [check.id, check.mode])).toEqual([
      ["guard.force_push", "observe"],
      ["guard.reset_hard", "off"],
      ["guard.rm_outside_workspace", "observe"],
      ["guard.secret_read", "observe"],
      ["guard.prod_sql", "observe"],
      ["guard.prod_credentials", "observe"],
    ]);
    expect(guardrailHits(off, bash("git reset --hard"), { env: ENV })).toEqual([]);
    expect(guardrailHits(off, bash("git push -f"), { env: ENV })).toEqual([
      expect.objectContaining({ rule_id: "guard.force_push", mode: "observe", verdict: "block" }),
    ]);
  });

  it("blocks by default and fires nothing when the mode is off", () => {
    const defaults = config("version = 1\n");
    expect(defaults.guardrails.mode).toBe("enforce");
    expect(ids(guardrailHits(defaults, bash("cat .env"), { env: ENV }))).toEqual([
      "guard.secret_read",
    ]);
    const off = config('version = 1\n[guardrails]\nmode = "off"\n');
    expect(guardrailHits(off, bash("rm -rf / && git push -f"), { env: ENV })).toEqual([]);
  });

  it("checks prod databases and credentials only when something is marked prod", () => {
    const defaults = config("version = 1\n");
    const drop = bash("psql -h db.prod.acme.internal -c 'DROP TABLE users'");
    expect(guardrailHits(defaults, drop, { env: ENV })).toEqual([]);
    expect(guardrailHits(defaults, bash("aws s3 ls --profile prod"), { env: ENV })).toEqual([]);
  });

  it("blocks printing the whole environment when it holds a production variable", () => {
    const env = { ...ENV, PROD_API_TOKEN: "set" };
    expect(ids(guardrailHits(policy, bash("env"), { env }))).toEqual(["guard.prod_credentials"]);
    expect(ids(guardrailHits(policy, bash("printenv | sort"), { env }))).toEqual([
      "guard.prod_credentials",
    ]);
    expect(guardrailHits(policy, bash("env"), { env: ENV })).toEqual([]);
  });
});

describe("rm outside the workspace", () => {
  it("sees through a symlink in the workspace that points outside it", () => {
    const links: Record<string, string> = { [`${WORKSPACE}/data`]: "/mnt/shared" };
    const realpath = (path: string) => {
      for (const [link, target] of Object.entries(links)) {
        if (path === link || path.startsWith(`${link}/`)) return target + path.slice(link.length);
      }
      return path.startsWith("/home") || path === "/" || path.startsWith("/mnt") ? path : undefined;
    };
    const hits = guardrailHits(policy, bash("rm -rf data/old"), { env: ENV, realpath });
    expect(ids(hits)).toEqual(["guard.rm_outside_workspace"]);
    // The link itself is in the workspace; rm removes the link, not what it points at.
    expect(guardrailHits(policy, bash("rm -rf data"), { env: ENV, realpath })).toEqual([]);
    expect(ids(guardrailHits(policy, bash("rm -rf data/"), { env: ENV, realpath }))).toEqual([
      "guard.rm_outside_workspace",
    ]);
  });

  it("follows variables set earlier in the same command", () => {
    expect(ids(guardrailHits(policy, bash("X=/etc; rm -rf $X/nginx"), { env: ENV }))).toEqual([
      "guard.rm_outside_workspace",
    ]);
    expect(guardrailHits(policy, bash("export OUT=dist\nrm -rf $OUT"), { env: ENV })).toEqual([]);
  });

  it("asks when the call has no folder to resolve a relative path against", () => {
    const call: ToolCall = { tool: "Bash", command: "rm -rf build" };
    expect(guardrailHits(policy, call, { env: ENV })).toEqual([
      expect.objectContaining({ rule_id: "guard.rm_outside_workspace", verdict: "ask" }),
    ]);
  });
});

describe("a workspace inside a temp folder", () => {
  const repo = "/tmp/acme-api";
  const inTmp = (command: string) => bash(command, { cwd: repo, root: repo });

  it("blocks rm -rf on the workspace's neighbours and on the temp folder itself", () => {
    for (const command of ["rm -rf /tmp/other-repo", "rm -rf ../other-repo", "rm -rf /tmp"]) {
      expect(ids(guardrailHits(policy, inTmp(command), { env: ENV }))).toEqual([
        "guard.rm_outside_workspace",
      ]);
    }
  });

  it("still allows rm -rf inside the workspace and in other temp folders", () => {
    const env = { ...ENV, TMPDIR: "/var/folders/xy/T" };
    expect(guardrailHits(policy, inTmp("rm -rf build"), { env })).toEqual([]);
    expect(guardrailHits(policy, inTmp("rm -rf /var/folders/xy/T/cache"), { env })).toEqual([]);
    // From a workspace elsewhere, /tmp stays a temp folder.
    expect(guardrailHits(policy, bash("rm -rf /tmp/other-repo"), { env: ENV })).toEqual([]);
  });
});

describe("selfhost decision commands", () => {
  const off = config('version = 1\n[guardrails]\nmode = "off"\n');

  it.each([
    "selfhost inbox approve 019a5b01",
    "CLAUDECODE=1 selfhost inbox approve 019a5b01 < /dev/null",
    "env -i selfhost review deny 019a5b01",
    "npx -y selfhostai inbox approve 019a5b01",
    "pnpm exec selfhost decide 019a5b01 approve",
    "/usr/local/bin/selfhost policy promote no-curl --to off",
    "node apps/cli/dist/main.js inbox approve 019a5b01",
    "pnpm --filter @selfhost/cli dev inbox approve 019a5b01",
    "bash -c 'selfhost guard uninstall'",
    "selfhost team policy push selfhost.toml",
    "selfhost init --undo",
    "selfhost notify add - < url.txt",
    "selfhost notify remove phone",
    "selfhost agents configure --remove",
    "cd /tmp && selfhost team leave",
  ])("blocks %s, even with the guardrails off", async (command) => {
    const decision = await checkToolCall(off, bash(command), { env: ENV });
    expect(decision.verdict).toBe("block");
    expect(decision.hit).toEqual(
      expect.objectContaining({ rule_id: "guard.selfhost_decision", mode: "enforce" }),
    );
  });

  it.each([
    "selfhost inbox",
    "selfhost inbox open 019a5b01",
    "selfhost review list",
    "selfhost init",
    "selfhost agents configure",
    "git commit -m 'selfhost inbox approve'",
    "pnpm install",
  ])("allows %s", (command) => {
    expect(guardrailHits(off, bash(command), { env: ENV })).toEqual([]);
  });

  it("names the command it found", () => {
    expect(selfhostDecisionCommand(["npx", "selfhostai", "inbox", "approve", "x"])).toBe(
      "inbox approve",
    );
    expect(selfhostDecisionCommand(["selfhost", "init", "--undo"])).toBe("init --undo");
    expect(selfhostDecisionCommand(["ls", "inbox", "approve"])).toBeUndefined();
  });
});

describe("secret files", () => {
  it.each([
    "/home/dev/acme-api/.env",
    "/home/dev/acme-api/.env.local",
    "/home/dev/acme-api/deploy/prod.env",
    "/home/dev/.ssh/id_rsa",
    "/home/dev/.ssh",
    "/home/dev/acme-api/certs/server.key",
    "/home/dev/acme-api/certs/server.pem",
    "/home/dev/.npmrc",
    "/home/dev/.netrc",
    "/home/dev/.git-credentials",
    "/home/dev/.aws/credentials",
    "/home/dev/.docker/config.json",
    "/home/dev/.kube/config",
    "/home/dev/.config/gh/hosts.yml",
    "/home/dev/.codex/auth.json",
    "/home/dev/.claude/.credentials.json",
    "/home/dev/.selfhost/config.json",
  ])("treats %s as a secret file", (path) => {
    expect(isSecretPath(path)).toBe(true);
  });

  it.each([
    "/home/dev/acme-api/.env.example",
    "/home/dev/acme-api/.env.sample",
    "/home/dev/acme-api/.envrc",
    "/home/dev/acme-api/src/env.ts",
    "/home/dev/.ssh/id_rsa.pub",
    "/home/dev/.ssh/known_hosts",
    "/home/dev/.ssh/config",
    "/home/dev/.aws/config",
  ])("does not treat %s as a secret file", (path) => {
    expect(isSecretPath(path)).toBe(false);
  });

  it("does not block a write to a secret file or a mention of one", () => {
    const write: ToolCall = { tool: "Write", path: ".env", access: "write", root: WORKSPACE };
    expect(guardrailHits(policy, write, { env: ENV })).toEqual([]);
    expect(guardrailHits(policy, bash("echo .env >> .gitignore"), { env: ENV })).toEqual([]);
    expect(guardrailHits(policy, bash("ls -la .env && chmod 600 .env"), { env: ENV })).toEqual([]);
  });
});

describe("shell commands", () => {
  const argv = (text: string) =>
    shellCommands(text, { cwd: WORKSPACE, env: ENV }).map((command) => command.argv);

  it("splits on operators and newlines but not inside quotes", () => {
    expect(argv("a && b || c; d | e\nf")).toEqual([["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]);
    expect(argv('git commit -m "one\ntwo; three"')).toEqual([
      ["git", "commit", "-m", "one\ntwo; three"],
    ]);
  });

  it("looks through wrappers and into the scripts commands run", () => {
    expect(argv("sudo -u root nice -n 5 timeout 10 git status")).toEqual([["git", "status"]]);
    expect(argv("sh -c 'ls; pwd'")).toEqual([["sh", "-c", "ls; pwd"], ["ls"], ["pwd"]]);
    expect(argv('eval "git push -f"')).toEqual([
      ["eval", "git push -f"],
      ["git", "push", "-f"],
    ]);
    expect(argv("echo `whoami` $(id -u)")).toEqual([
      ["id", "-u"],
      ["whoami"],
      ["echo", "`whoami`", "$(...)"],
    ]);
    expect(argv("diff <(cat a) b")).toEqual([
      ["cat", "a"],
      ["diff", "b"],
    ]);
  });

  it("follows cd for later commands and undoes it after a subshell", () => {
    const commands = shellCommands("cd src && (cd /tmp && ls) && pwd", { cwd: WORKSPACE });
    expect(commands.map((command) => [command.argv[0], command.cwd])).toEqual([
      ["cd", WORKSPACE],
      ["cd", `${WORKSPACE}/src`],
      ["ls", "/tmp"],
      ["pwd", `${WORKSPACE}/src`],
    ]);
  });

  it("keeps file redirects out of the arguments and lists the files read", () => {
    const [command] = shellCommands("sort < in.txt > out.txt 2>&1", { cwd: WORKSPACE });
    expect(command?.argv).toEqual(["sort"]);
    expect(command?.inputs).toEqual(["in.txt"]);
  });
});

describe("extra checkers", () => {
  const hit = (rule_id: string, mode: "observe" | "enforce" = "enforce"): PolicyHit => ({
    rule_id,
    mode,
    verdict: "block",
    message: `${rule_id} fired`,
    irreversible: false,
  });

  it("adds their hits after the rules and guardrails", async () => {
    const packages: ToolCallChecker = async (call) =>
      call.command?.includes("npm install") ? [hit("packages.unknown")] : [];
    const decision = await checkToolCall(policy, bash("npm install lefpad"), {
      env: ENV,
      checkers: [packages],
    });
    expect(decision.verdict).toBe("block");
    expect(decision.hit?.rule_id).toBe("packages.unknown");
    const clean = await checkToolCall(policy, bash("npm test"), { env: ENV, checkers: [packages] });
    expect(clean.verdict).toBe("allow");
  });

  it("fails open for a checker that throws or runs out of time, and says which", async () => {
    let aborted = false;
    async function slow(_call: ToolCall, _config: unknown, { signal }: { signal: AbortSignal }) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      aborted = signal.aborted;
      return [hit("late")];
    }
    async function broken(): Promise<PolicyHit[]> {
      throw new Error("registry unreachable");
    }
    const decision = await checkToolCall(policy, bash("npm install"), {
      env: ENV,
      checkers: [slow, broken, async () => [hit("observed", "observe")]],
      budgetMs: 20,
    });
    expect(decision.verdict).toBe("allow");
    expect(decision.hit?.rule_id).toBe("observed");
    expect(decision.failures).toEqual([
      { checker: "slow", timedOut: true, message: "no answer within 20 ms" },
      { checker: "broken", timedOut: false, message: "registry unreachable" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(aborted).toBe(true);
  });
});

describe("decide", () => {
  const h = (
    rule_id: string,
    mode: "observe" | "enforce",
    verdict: "block" | "ask",
  ): PolicyHit => ({
    rule_id,
    mode,
    verdict,
    message: rule_id,
    irreversible: false,
  });

  it("lets enforce hits decide, block before ask, and keeps the first observe hit for allow", () => {
    expect(decide([])).toEqual({ verdict: "allow" });
    expect(decide([h("a", "enforce", "ask"), h("b", "enforce", "block")]).hit?.rule_id).toBe("b");
    expect(decide([h("a", "observe", "block"), h("b", "enforce", "ask")])).toMatchObject({
      verdict: "ask",
      hit: { rule_id: "b" },
    });
    expect(decide([h("a", "observe", "ask"), h("b", "observe", "block")])).toMatchObject({
      verdict: "allow",
      hit: { rule_id: "b" },
    });
  });
});
