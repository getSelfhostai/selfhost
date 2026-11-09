import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cronMatches, parseConfig, parseCron } from "@selfhost/schema";
import { describe, expect, it } from "vitest";
import {
  dueSchedules,
  githubRunRequest,
  HealthMonitor,
  personForLogin,
  signWebhook,
  toolCallsIn,
  verifyWebhook,
} from "../src/index.js";

const ROOT = join(import.meta.dirname, "../../..");
const webhook = (name: string) =>
  JSON.parse(readFileSync(join(ROOT, "fixtures/github/webhooks/runs", name), "utf8"));

const background = { github_command: "/selfhost run", github_label: "selfhost" };

describe("GitHub triggers", () => {
  it("reads a /selfhost run comment with an agent and a task", () => {
    expect(
      githubRunRequest("issue_comment", webhook("issue_comment.created.run.json"), background),
    ).toEqual({
      source: "github_comment",
      repo: "acme/acme-api",
      number: 42,
      installation: 61000001,
      sender: "octocat",
      agent: "codex",
      task: "Add a regression test for the empty password case and fix it",
      url: "https://github.com/acme/acme-api/issues/42#issuecomment-9001",
    });
  });

  it("uses the issue as the task for a bare command, and for the run label", () => {
    const payload = webhook("issue_comment.created.run.json");
    payload.comment.body = "/selfhost run";
    const found = githubRunRequest("issue_comment", payload, background);
    expect("task" in found && found.task).toBe(
      "Resolve GitHub issue #42: Login accepts an empty password\n\nSteps: submit the form with no password.",
    );
    const labeled = githubRunRequest("issues", webhook("issues.labeled.selfhost.json"), background);
    expect(labeled).toMatchObject({ source: "github_label", sender: "octocat", number: 42 });
  });

  it("starts nothing for bots, other comments, other labels and unknown agents", () => {
    const payload = webhook("issue_comment.created.run.json");
    expect(
      githubRunRequest(
        "issue_comment",
        { ...payload, comment: { ...payload.comment, user: { login: "x[bot]", type: "Bot" } } },
        background,
      ),
    ).toEqual({ skip: "comments from bots start no runs" });
    expect(
      githubRunRequest(
        "issue_comment",
        { ...payload, comment: { ...payload.comment, body: "lgtm" } },
        background,
      ),
    ).toEqual({ skip: "not a run command" });
    expect(
      githubRunRequest(
        "issue_comment",
        { ...payload, comment: { ...payload.comment, body: "/selfhost run --agent cursor do it" } },
        background,
      ),
    ).toMatchObject({ skip: expect.stringContaining("unknown agent cursor") });
    const labeled = webhook("issues.labeled.selfhost.json");
    expect(githubRunRequest("issues", { ...labeled, label: { name: "bug" } }, background)).toEqual({
      skip: "not the run label",
    });
    expect(githubRunRequest("push", {}, background)).toEqual({ skip: "no issue in the payload" });
  });

  it("maps a login to a person through [review] github_logins", () => {
    expect(personForLogin("OctoCat", { "alice@example.com": "octocat" })).toBe("alice@example.com");
    expect(personForLogin("someone", { "alice@example.com": "octocat" })).toBeUndefined();
  });
});

describe("signed webhooks", () => {
  it("accepts only the body the secret signed", () => {
    const body = JSON.stringify({ task: "x", repo: "acme/web", sender: "alice@example.com" });
    const signature = signWebhook("s3cret", body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhook("s3cret", body, signature)).toBe(true);
    expect(verifyWebhook("s3cret", `${body} `, signature)).toBe(false);
    expect(verifyWebhook("other", body, signature)).toBe(false);
    expect(verifyWebhook("s3cret", body, undefined)).toBe(false);
    expect(verifyWebhook("", body, signature)).toBe(false);
  });
});

describe("schedules", () => {
  it("reads cron and finds the minutes due once", () => {
    const cron = parseCron("30 6 * * 1-5");
    if (typeof cron === "string") throw new Error(cron);
    expect(cronMatches(cron, new Date("2026-11-09T06:30:00Z"))).toBe(true); // a Monday
    expect(cronMatches(cron, new Date("2026-11-08T06:30:00Z"))).toBe(false); // a Sunday
    expect(parseCron("*/15 * * *")).toMatch(/Expected 5 fields/);
    expect(parseCron("61 * * * *")).toMatch(/minute: 61 is outside 0-59/);
    const every = parseCron("*/15 * * * *");
    if (typeof every === "string") throw new Error(every);
    expect(cronMatches(every, new Date("2026-11-09T06:45:00Z"))).toBe(true);
    expect(cronMatches(every, new Date("2026-11-09T06:46:00Z"))).toBe(false);

    const schedules = [
      { name: "nightly", cron: "0 2 * * *", repo: "acme/web", task: "Update dependencies" },
      { name: "hourly", cron: "0 * * * *", repo: "acme/web", task: "Triage flaky tests" },
    ];
    const due = dueSchedules(
      { schedules },
      new Date("2026-11-09T01:59:30Z"),
      new Date("2026-11-09T02:00:30Z"),
    );
    expect(due.map((d) => d.ref)).toEqual([
      "schedule:nightly@2026-11-09T02:00:00.000Z",
      "schedule:hourly@2026-11-09T02:00:00.000Z",
    ]);
    // A scheduler down for a day starts each missed schedule once.
    expect(
      dueSchedules(
        { schedules },
        new Date("2026-11-08T00:00:00Z"),
        new Date("2026-11-09T00:00:00Z"),
      ),
    ).toHaveLength(2);
  });

  it("checks schedules in selfhost.toml", () => {
    const parsed = parseConfig(
      'version = 1\n[background]\n[[background.schedules]]\nname = "a"\ncron = "0 2 * *"\nrepo = "acme/web"\ntask = "x"\n[[background.schedules]]\nname = "a"\ncron = "0 2 * * *"\nrepo = "acme/web"\ntask = "y"\n',
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((e) => [e.field, e.line])).toEqual([
      ["background.schedules[0].cron", 5],
      ["background.schedules[1].name", 9],
    ]);
  });
});

describe("run health", () => {
  it("reads tool calls from each agent's JSON output", () => {
    expect(
      toolCallsIn(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}',
      ),
    ).toEqual([{ id: "t1", name: "Bash", key: 'Bash {"command":"ls"}' }]);
    expect(
      toolCallsIn(
        '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"npm test"}}',
      ),
    ).toEqual([{ id: "i1", name: "shell", key: 'shell "npm test"' }]);
    expect(
      toolCallsIn(
        '{"type":"tool_use","part":{"tool":"bash","callID":"c1","state":{"input":{"command":"ls"}}}}',
      ),
    ).toEqual([{ id: "c1", name: "bash", key: 'bash {"command":"ls"}' }]);
    expect(
      toolCallsIn(
        '{"type":"message","message":{"content":[{"type":"toolRequest","id":"g1","toolCall":{"value":{"name":"shell","arguments":{"command":"ls"}}}}]}}',
      ),
    ).toEqual([{ id: "g1", name: "shell", key: 'shell {"command":"ls"}' }]);
    expect(toolCallsIn("plain text")).toEqual([]);
    expect(toolCallsIn("{not json")).toEqual([]);
  });

  it("counts a call reported when it starts and ends once, and resets on a different call", () => {
    const start = new Date("2026-11-09T10:00:00Z");
    const health = new HealthMonitor({ stallMinutes: 10, loopRepeats: 3, startedAt: start });
    const codex = (id: string, command: string, type = "item.started") =>
      `${JSON.stringify({ type, item: { id, type: "command_execution", command } })}\n`;
    health.output(codex("a", "npm test") + codex("a", "npm test", "item.completed"), start);
    health.output(codex("b", "npm test"), start);
    expect(health.check(start)).toMatchObject({ status: "ok", repeats: 2 });
    health.output(codex("c", "ls"), start);
    health.output(codex("d", "npm test") + codex("e", "npm test"), start);
    expect(health.check(start).status).toBe("ok");
    // A line split across two chunks is read once it is whole.
    const line = codex("f", "npm test");
    health.output(line.slice(0, 20), start);
    health.output(line.slice(20), start);
    expect(health.check(start)).toMatchObject({ status: "stuck", reason: "loop", repeats: 3 });
  });

  it("goes quiet, then stuck, with no output", () => {
    const start = new Date("2026-11-09T10:00:00Z");
    const health = new HealthMonitor({ stallMinutes: 5, loopRepeats: 6, startedAt: start });
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
    expect(health.check(at(1))).toMatchObject({ status: "ok", line: "starting" });
    health.output("hello\n", at(1));
    expect(health.check(at(2))).toMatchObject({ status: "ok", line: "working" });
    expect(health.check(at(4))).toMatchObject({ status: "quiet", line: "quiet for 3m" });
    expect(health.check(at(6))).toMatchObject({
      status: "stuck",
      reason: "no_output",
      stop: "no_output",
    });
  });
});
