import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run, tempDir } from "./run.js";

const POLICY = `version = 1

[egress]
mode = "enforce"
allow = ["github.com", "*.npmjs.org"]

[secrets.env]
STRIPE_KEY = { from = "env:SELFHOST_RUN_SECRET_STRIPE_KEY", host = "api.stripe.com" }

[integrations.runtime]
tool = "modal"
`;

function repo(text = POLICY) {
  const dir = tempDir("runtime-check");
  mkdirSync(dir.path(".git"));
  dir.write("selfhost.toml", text);
  return dir;
}

describe("selfhost runtime check", () => {
  it("passes a runtime that holds every rule natively", async () => {
    const dir = repo();
    const result = await run(["runtime", "check", "e2b"], { cwd: dir.root });
    expect(result.code).toBe(0);
    expect(result.out).toBe("e2b: [egress] 2 hosts, 1 secrets; holds every rule");
  });

  it("flags each rule a runtime cannot hold, and fails on a weaker one", async () => {
    const dir = repo();
    const result = await run(["runtime", "check", "coder"], { cwd: dir.root });
    expect(result.code).toBe(1);
    expect(result.out.split("\n")).toEqual([
      "coder: [egress] 2 hosts, 1 secrets; 2 not held as written",
      "  weaker egress.allow github.com: Coder's Agent Firewall lets domain=<host> reach the host's subdomains too.",
      "  weaker secrets.env.STRIPE_KEY STRIPE_KEY: coder cannot inject a secret at egress, so the value is in the sandbox's environment.",
    ]);
  });

  it("checks the configured runtime and the local sandboxes by default, as JSON", async () => {
    const dir = repo();
    const result = await run(["runtime", "check", "--json"], { cwd: dir.root });
    const report = JSON.parse(result.out);
    expect(report.schema).toBe("selfhost.runtime_check/v1");
    expect(report.reports.map((r: { target: string }) => r.target)).toEqual([
      "modal",
      "docker-sandboxes",
      "sandbox-runtime",
      "devcontainer",
    ]);
    expect(report.reports[0].gaps.map((g: { entry?: string; effect: string }) => g.entry)).toEqual([
      "github.com",
      "*.npmjs.org",
      "STRIPE_KEY",
    ]);
    expect(result.code).toBe(1);
  });

  it("refuses an unknown target and says when there is nothing to translate", async () => {
    expect((await run(["runtime", "check", "lambda"], { cwd: repo().root })).out).toMatch(
      /^Unknown target lambda: expected laptop, docker-sandboxes/,
    );
    const plain = await run(["runtime", "check"], { cwd: repo("version = 1\n").root });
    expect(plain.code).toBe(0);
    expect(plain.out).toMatch(/has no \[egress\] or \[secrets\]: nothing to translate\.$/);
  });
});

describe("selfhost doctor", () => {
  it("lists the rules the configured runtime and the local sandboxes cannot hold", async () => {
    const dir = repo();
    const result = await run(["doctor"], { cwd: dir.root });
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "sandbox  modal: [egress] 2 hosts, 1 secrets; 3 not held as written",
    );
    expect(result.out).toContain(
      "           stricter egress.allow github.com: modal allows addresses and ranges only, so the host name is blocked.",
    );
    const json = JSON.parse((await run(["doctor", "--json"], { cwd: dir.root })).out);
    expect(json.enforcement.map((r: { target: string }) => r.target)).toEqual([
      "modal",
      "docker-sandboxes",
      "sandbox-runtime",
      "devcontainer",
    ]);
  });
});
