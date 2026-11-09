import { describe, expect, it } from "vitest";
import { callHosts, checkToolCall, evaluate, policyChecks } from "../src/index.js";
import { config } from "./helpers.js";

const POLICY = config(`version = 1
[egress]
mode = "enforce"
allow = ["github.com", "*.npmjs.org"]

[teams.payments.egress]
allow = ["github.com"]

[teams.lab.rules."egress.allow"]
mode = "observe"
`);

describe("egress.allow", () => {
  it("blocks a fetch or a command that reaches a host outside the list", () => {
    expect(evaluate(POLICY, { tool: "WebFetch", url: "https://evil.test/x" })).toEqual([
      {
        rule_id: "egress.allow",
        mode: "enforce",
        verdict: "block",
        message: 'Host "evil.test" is not in [egress] allow.',
        alternative:
          "Use a host in [egress] allow, or ask the user to add this one to the team's list.",
        irreversible: false,
        hosts: ["evil.test"],
      },
    ]);
    expect(
      evaluate(POLICY, {
        tool: "Bash",
        command: "curl https://registry.npmjs.org/x && curl https://a.test https://b.test",
      }).map((hit) => hit.message),
    ).toEqual(['Hosts "a.test", "b.test" are not in [egress] allow.']);
    expect(evaluate(POLICY, { tool: "WebFetch", url: "https://github.com/acme" })).toEqual([]);
    expect(evaluate(POLICY, { tool: "Bash", command: "npm test" })).toEqual([]);
  });

  it("uses the team's own list and mode", () => {
    const npm = { tool: "WebFetch", url: "https://registry.npmjs.org/react" };
    expect(evaluate(POLICY, npm, { team: "payments" }).map((hit) => hit.rule_id)).toEqual([
      "egress.allow",
    ]);
    expect(evaluate(POLICY, { tool: "WebFetch", url: "https://x.test" }, { team: "lab" })).toEqual([
      expect.objectContaining({ mode: "observe" }),
    ]);
  });

  it("is listed with the other checks, and absent without [egress]", () => {
    expect(policyChecks(POLICY).map((check) => check.id)).toEqual(["egress.allow"]);
    expect(policyChecks(config("version = 1\n"))).toEqual([]);
    expect(evaluate(config("version = 1\n"), { tool: "WebFetch", url: "https://x.test" })).toEqual(
      [],
    );
  });

  it("decides the same for one call wherever it is checked", async () => {
    const call = { tool: "Bash", command: "git clone git@gitlab.evil.test:a/b.git" };
    const first = await checkToolCall(POLICY, call);
    const second = await checkToolCall(POLICY, { ...call, cwd: "/workspace", root: "/workspace" });
    expect(first.verdict).toBe("block");
    expect(second).toEqual(first);
    expect(callHosts(call)).toEqual(["gitlab.evil.test"]);
  });
});
