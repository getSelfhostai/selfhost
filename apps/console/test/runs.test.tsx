// @vitest-environment jsdom
import type { BackgroundRun } from "@selfhost/schema";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ADMIN, mockServer, OWNER, renderConsole } from "./harness";

const run = (extra: Partial<BackgroundRun>): BackgroundRun => ({
  schema: "selfhost.background_run/v1",
  id: "019a6b2c-0000-7000-8000-00000000abcd",
  team: "web",
  repo: "acme/web",
  task: "Fix the empty password login",
  agent: "claude",
  runtime: "e2b",
  state: "running",
  reason: null,
  person: "ada@example.com",
  trigger: { source: "console", sender: "ada@example.com", person: "ada@example.com" },
  credential: "person_login",
  base: "main",
  branch: "claude/selfhost-fix-the-empty-password-login-0000abcd",
  sandbox_id: "sbx-1",
  attempt: 1,
  max_attempts: 2,
  timeout_minutes: 60,
  pr_url: null,
  created_at: "2026-11-08T11:50:00.000Z",
  started_at: "2026-11-08T11:50:01.000Z",
  ended_at: null,
  updated_at: "2026-11-08T11:58:00.000Z",
  cancel: null,
  cost: { runtime_usd: 0.04, model_usd: 0.31, usd: 0.35, source: "list_price" },
  health: { status: "quiet", line: "quiet for 3m", heartbeat_at: null, last_output_at: null },
  gate: null,
  ...extra,
});

const LIST = {
  runs: [
    run({}),
    run({
      id: "019a6b2c-0000-7000-8000-00000000beef",
      state: "succeeded",
      task: "Add a regression test for the rate limiter",
      pr_url: "https://github.com/acme/web/pull/7",
      health: null,
      gate: {
        mode: "enforce",
        result: "passed",
        command: "pnpm test",
        tests_changed: ["src/limit.test.ts"],
        checks: [],
        summary: "ok",
        blocked: false,
      },
    }),
  ],
  kills: [],
};

describe("runs screen", () => {
  it("lists runs with state, health, cost and pull request, and stops a running one", async () => {
    const server = mockServer({
      "GET /v1/background-runs": LIST,
      "POST /v1/background-runs/019a6b2c-0000-7000-8000-00000000abcd/cancel": run({
        state: "cancelled",
      }),
    });
    renderConsole(OWNER, "?screen=runs");
    const rows = await screen.findAllByTestId("background-run");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("quiet for 3m")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("$0.35")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("acme/web/pull/7")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Tests first: passed")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByRole("button", { name: "Stop" })).toBeNull();

    fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: "Stop" }));
    expect(await screen.findByText(/is cancelled\./)).toBeTruthy();
    expect(server.calls.some((c) => c.method === "POST" && c.path.endsWith("/cancel"))).toBe(true);
  });

  it("starts a run for the picked team from the form", async () => {
    const server = mockServer({
      "GET /v1/background-runs": { runs: [], kills: [] },
      "POST /v1/background-runs": run({ state: "queued" }),
    });
    renderConsole(OWNER, "?screen=runs");
    expect(await screen.findByText("No background runs yet")).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start run" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Fix the empty password login" },
    });
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "acme/web" } });
    fireEvent.click(start);
    await waitFor(() =>
      expect(server.calls.find((c) => c.method === "POST")?.body).toEqual({
        task: "Fix the empty password login",
        repo: "acme/web",
        agent: "claude",
        team: "web",
        source: "console",
      }),
    );
    expect(await screen.findByText(/Started run 019a6b2c/)).toBeTruthy();
  });

  it("shows a kill switch in force and no start form for the admin token", async () => {
    mockServer({
      "GET /v1/background-runs": {
        runs: [],
        kills: [
          { scope: "team", target: "web", by: "ada@example.com", at: "2026-11-08T11:00:00.000Z" },
        ],
      },
    });
    renderConsole(ADMIN, "?screen=runs");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The team kill switch for web is on",
    );
    expect(screen.queryByRole("button", { name: "Start run" })).toBeNull();
  });
});
