// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { blockedToolEvents, eventLine, runFromEvents } from "../src/components/screens/run";
import { MODULES, OBSERVED, PROVENANCE, REVIEW_PAGE, USAGE } from "./fixtures";
import { ADMIN, MEMBER, mockServer, OWNER, renderConsole } from "./harness";

const stat = (title: string) => screen.getByRole("link", { name: title });

describe("the overview", () => {
  it("sums up this week, each number linking to its screen", async () => {
    const server = mockServer({
      "GET /v1/usage": USAGE,
      "GET /v1/review-items": REVIEW_PAGE,
      "GET /v1/policy/observed": OBSERVED,
    });
    renderConsole(OWNER, "");
    await screen.findByText("12");
    expect(within(stat("Agent sessions")).getByText("12")).toBeTruthy();
    expect(within(stat("Cost")).getByText("$42.50")).toBeTruthy();
    expect(within(stat("Cost")).getByText("$8.50 per merged PR")).toBeTruthy();
    expect(within(stat("PRs merged")).getByText("6 opened")).toBeTruthy();
    expect(within(stat("Risky PRs")).getByText("1")).toBeTruthy();
    expect(within(stat("Waiting on a person")).getByText("3")).toBeTruthy();
    expect(
      within(stat("Waiting on a person")).getByText("2 agents blocked until someone answers"),
    ).toBeTruthy();
    expect(within(stat("Blocks and asks from rules")).getByText("3")).toBeTruthy();
    expect(
      within(stat("Blocks and asks from rules")).getByText(
        "4 more from rules still recording only",
      ),
    ).toBeTruthy();

    expect(stat("Waiting on a person").getAttribute("href")).toBe("?screen=review");
    expect(stat("Blocks and asks from rules").getAttribute("href")).toBe("?screen=rules");
    expect(stat("Cost").getAttribute("href")).toBe("?screen=spend");
    expect(stat("PRs merged").getAttribute("href")).toBe("?screen=code");
    expect(screen.getAllByRole("link", { name: "run" }).map((a) => a.getAttribute("href"))).toEqual(
      ["?screen=run&run=sess-1", "?screen=run&run=run-7"],
    );

    const usage = server.calls.find((c) => c.path === "/v1/usage");
    expect(usage?.url.searchParams.get("from")).toBe("2026-11-02T00:00:00.000Z");
    expect(usage?.url.searchParams.get("team")).toBe("web");
  });

  it("covers every team with the admin token, and opens a screen from a card", async () => {
    mockServer({
      "GET /v1/usage": USAGE,
      "GET /v1/review-items": REVIEW_PAGE,
      "GET /v1/orgs/default/overview": { teams: [] },
    });
    const { go } = renderConsole(ADMIN, "");
    await screen.findByText("Pick a team to see its rules");
    fireEvent.click(stat("Risky PRs"));
    expect(go).toHaveBeenCalledWith(expect.objectContaining({ screen: "review" }));
    await screen.findByRole("heading", { name: "Review list" });
  });
});

describe("spend", () => {
  it("shows the budget and cost per merged PR beside the usage view", async () => {
    mockServer({
      "GET /v1/usage": USAGE,
      "GET /v1/budget": {
        period: "month",
        from: "2026-11-01T00:00:00.000Z",
        to: "2026-12-01T00:00:00.000Z",
        spent_usd: 120,
        limit_usd: 300,
        remaining_usd: 180,
        forecast_usd: 450,
      },
      "GET /v1/teams/web/roi": {
        schema: "selfhost.roi/v1",
        team: "web",
        from: "2026-10-10T00:00:00.000Z",
        to: "2026-11-09T00:00:00.000Z",
        merged_prs: 10,
        cost_usd: 60,
        cost_per_merged_pr: 6,
        baseline: {
          from: "2026-09-10T00:00:00.000Z",
          to: "2026-10-10T00:00:00.000Z",
          merged_prs: 5,
          cost_usd: 40,
          cost_per_merged_pr: 8,
        },
        by_agent: [
          { agent: "codex", model: "gpt-5", merged_prs: 4, cost_usd: 20, cost_per_merged_pr: 5 },
        ],
      },
    });
    renderConsole(OWNER, "?screen=spend");
    await screen.findByText("On pace for $450.00 by month end, over budget.", { exact: false });
    expect(screen.getByText("of $300.00")).toBeTruthy();
    expect(await screen.findByText("$6.00")).toBeTruthy();
    expect(screen.getByText("Down 25% from $8.00 the period before.")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("shows sandbox cost, idle share, the cheaper billing model and boxes left running", async () => {
    const e2b = (billed: number, idle: number, share: number) => ({
      runtime: "e2b",
      billing: "reserved",
      sandboxes: 2,
      billed_seconds: 9000,
      idle_seconds: 6000,
      billed_usd: billed,
      idle_usd: idle,
      idle_share: share,
      suggestion:
        share > 0.5
          ? {
              text: "E2B bills the CPU and memory a sandbox holds while it runs.",
              monthly_saving_usd: 1.2,
            }
          : null,
    });
    mockServer({
      "GET /v1/usage": USAGE,
      "GET /v1/budget": { status: 404, message: "No team" },
      "GET /v1/teams/web/sandboxes": {
        team: "web",
        generated_at: "2026-11-09T12:00:00.000Z",
        leftover_minutes: 15,
        windows: [
          {
            days: 7,
            billed_usd: 0.41,
            idle_usd: 0.29,
            idle_share: 0.71,
            by_runtime: [e2b(0.41, 0.29, 0.71)],
          },
          {
            days: 30,
            billed_usd: 2,
            idle_usd: 0.8,
            idle_share: 0.4,
            by_runtime: [e2b(2, 0.8, 0.4)],
          },
        ],
        leftovers: [
          {
            sandbox_id: "e2",
            runtime: "e2b",
            run_id: "run-2",
            owner: null,
            started_at: "2026-11-09T10:20:00.000Z",
            run_ended_at: "2026-11-09T11:20:00.000Z",
            stopped_at: null,
            minutes_after_run: 40,
            cost_usd: 0.27,
            after_run_usd: 0.11,
          },
        ],
        runs: [],
      },
    });
    renderConsole(OWNER, "?screen=spend");
    await screen.findByText("7 days $0.41, 71% idle.", { exact: false });
    expect(screen.getByText(/30 days \$2\.00, 40% idle/)).toBeTruthy();
    expect(screen.getByText(/E2B bills the CPU and memory/)).toBeTruthy();
    expect(screen.getByText(/, still running/)).toBeTruthy();
    expect(screen.getByText("$0.11 after 40 min")).toBeTruthy();
  });

  it("says how far over a spent budget is, not $0.00 left", async () => {
    mockServer({
      "GET /v1/usage": USAGE,
      "GET /v1/budget": {
        period: "month",
        from: "2026-11-01T00:00:00.000Z",
        to: "2026-12-01T00:00:00.000Z",
        spent_usd: 1.09,
        limit_usd: 1,
        remaining_usd: 0,
        forecast_usd: null,
      },
      "GET /v1/teams/web/roi": { status: 404, message: "No route" },
    });
    renderConsole(OWNER, "?screen=spend");
    await screen.findByText("$0.09 over.", { exact: false });
    expect(screen.queryByText("$0.00 left.", { exact: false })).toBeNull();
  });

  it("shows the cache hit rate per row, and unknown where an agent reports no cache tokens", async () => {
    const row = (agent: string, rate: number | null) => ({
      ...USAGE.total,
      group: { agent },
      cache_hit_rate: rate,
    });
    mockServer({
      "GET /v1/usage": { ...USAGE, rows: [row("claude_code", 0.874), row("cursor", null)] },
      "GET /v1/budget": { status: 404, message: "No team" },
    });
    renderConsole(OWNER, "?screen=spend&breakdown=agent");
    expect(await screen.findByText("87%")).toBeTruthy();
    expect(screen.getByText("unknown")).toBeTruthy();
    expect(screen.getByText("500K from cache, 50% cache hits")).toBeTruthy();
  });

  it("says so when the server has no cost per merged PR yet", async () => {
    mockServer({ "GET /v1/usage": USAGE, "GET /v1/budget": { status: 404, message: "No team" } });
    renderConsole(OWNER, "?screen=spend");
    await screen.findByText(/does not report cost per merged PR yet/);
  });
});

describe("code", () => {
  it("shows agent share and revert rate per repo, and the flagged modules first", async () => {
    mockServer({
      "GET /v1/teams/web/provenance": PROVENANCE,
      "GET /v1/teams/web/provenance/modules": MODULES,
    });
    renderConsole(MEMBER, "?screen=code");
    await screen.findByText("Flagged modules");
    const repos = screen.getAllByTestId("repo");
    expect(within(repos[0] as HTMLElement).getByText("42%")).toBeTruthy();
    expect(within(repos[0] as HTMLElement).getByText("10%")).toBeTruthy();
    expect(within(repos[1] as HTMLElement).getByText("From pull requests only")).toBeTruthy();
    expect(screen.getAllByText("Flagged")).toHaveLength(2);
    expect(screen.getByText(/more than 20% of the time/)).toBeTruthy();
  });
});

describe("the run view", () => {
  const events = [
    {
      id: "01930c4e-2f1a-7b2c-9d3e-000000000001",
      schema: "selfhost.event/v1",
      ts: "2026-11-08T10:00:00.000Z",
      source: "hook",
      kind: "session.started",
      actor: { kind: "person", id: "ada@example.com" },
      agent: { vendor: "claude_code" },
      repo: "acme/api",
      session_id: "sess-1",
    },
    {
      id: "01930c4e-2f1a-7b2c-9d3e-000000000003",
      schema: "selfhost.event/v1",
      ts: "2026-11-08T10:05:00.000Z",
      source: "github",
      kind: "pr.opened",
      actor: { kind: "agent", id: "claude_code:session:sess-1" },
      session_id: "sess-1",
      links: { pr_url: "https://github.com/acme/api/pull/7" },
    },
    {
      id: "01930c4e-2f1a-7b2c-9d3e-000000000002",
      schema: "selfhost.event/v1",
      ts: "2026-11-08T10:01:00.000Z",
      source: "otel",
      kind: "cost.recorded",
      actor: { kind: "person", id: "ada@example.com" },
      model: "claude-sonnet-4-5",
      session_id: "sess-1",
      cost: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        usd: 0.25,
        estimated: true,
      },
    },
  ];

  it("falls back to the session's events when the server has no run route", async () => {
    const server = mockServer({ "GET /v1/events": { events, next_cursor: null } });
    renderConsole(OWNER, "?screen=run&run=sess-1");
    await screen.findByText("Pull request opened");
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("$0.25")).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://github.com/acme/api/pull/7" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Open in your tracer" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // A disabled button hides its title, so the hint is on the page.
    expect(screen.getByText(/No tracer link: set \[integrations.tracer\] run_url/)).toBeTruthy();
    const query = server.calls.find((c) => c.path === "/v1/events")?.url.searchParams;
    expect(query?.get("session")).toBe("sess-1");
    const titles = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(titles.findIndex((t) => t?.includes("Session started"))).toBeLessThan(
      titles.findIndex((t) => t?.includes("Model request")),
    );
  });

  it("labels a tool call a hook blocked as blocked, not as one that ran", () => {
    const call = {
      id: "01930c4e-2f1a-7b2c-9d3e-0000000000a1",
      schema: "selfhost.event/v1",
      ts: "2026-11-08T10:02:00.000Z",
      source: "hook",
      kind: "tool.called",
      actor: { kind: "agent", id: "claude_code:session:sess-1" },
      tool: { name: "Read", input_summary: ".env" },
    } as never;
    const verdict = {
      id: "01930c4e-2f1a-7b2c-9d3e-0000000000a2",
      schema: "selfhost.event/v1",
      ts: "2026-11-08T10:02:00.000Z",
      source: "hook",
      kind: "policy.evaluated",
      actor: { kind: "system", id: "selfhost-policy" },
      decision: {
        verdict: "block",
        by: "selfhost-policy",
        rule_id: "guard.secret_read",
        mode: "enforce",
      },
      data: { answer: "deny", tool_event_id: "01930c4e-2f1a-7b2c-9d3e-0000000000a1" },
    } as never;
    const blocked = blockedToolEvents([verdict, call]);
    expect(eventLine(call, blocked.has("01930c4e-2f1a-7b2c-9d3e-0000000000a1")).title).toBe(
      "Tool call blocked, did not run: Read",
    );
    expect(eventLine(call).title).toBe("Tool call: Read");
  });

  it("uses the run route and links the tracer when the server has one", async () => {
    mockServer({
      "GET /v1/runs/run-7": {
        ...runFromEvents("run-7", events as never),
        trace_url: "https://langfuse.example.com/trace/run-7",
      },
    });
    renderConsole(OWNER, "?screen=run&run=run-7");
    const link = await screen.findByRole("link", { name: /Open in your tracer/ });
    expect(link.getAttribute("href")).toBe("https://langfuse.example.com/trace/run-7");
  });

  it("shows each pull request's second opinion in the run view", async () => {
    const report = runFromEvents("run-7", events as never);
    mockServer({
      "GET /v1/runs/run-7": {
        ...report,
        prs: report.prs.map((pr) => ({
          ...pr,
          second_opinions: [
            {
              tool: "claude-code-action",
              reviewer: "github-actions[bot]",
              verdict: "approve",
              findings: 0,
              at: "2026-11-08T10:30:00.000Z",
              event_id: "0193ffff-0000-7000-8000-0000000000b1",
            },
          ],
        })),
      },
    });
    renderConsole(OWNER, "?screen=run&run=run-7");
    await screen.findByText("Claude Code Action: approved");
    expect(screen.getByText("Claude Code Action approved: 0 findings")).toBeTruthy();
  });

  it("shows the run's cache hit rate and its cost tip", async () => {
    const report = runFromEvents("run-8", events as never);
    const tip =
      "Session run-8 (claude_code, ada@example.com) cost $9.00 at 12% cache hits: usually a value that changes early in the prompt (such as a timestamp), tool lists that reorder, or a model switch.";
    mockServer({
      "GET /v1/runs/run-8": {
        ...report,
        run: { ...report.run, cache_hit_rate: 0.12, cache_tip: tip },
      },
    });
    renderConsole(OWNER, "?screen=run&run=run-8");
    expect(await screen.findByText("12%")).toBeTruthy();
    expect(screen.getByText(`Cost tip: ${tip}`)).toBeTruthy();
  });

  it("pages through a long run's events with the run route's cursor", async () => {
    const [first, second, third] = events;
    const server = mockServer({
      "GET /v1/runs/run-7": ({ url }: { url: URL }) =>
        url.searchParams.get("cursor") === "page-2"
          ? { ...runFromEvents("run-7", [third] as never), next_cursor: null }
          : {
              ...runFromEvents("run-7", [first, second] as never, "page-2"),
              run: { ...runFromEvents("run-7", events as never).run, ended_at: null },
            },
    });
    renderConsole(OWNER, "?screen=run&run=run-7");
    await screen.findByText("2+ events, oldest first.");
    expect(screen.getByText("Not ended")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    await screen.findByText("3 events, oldest first.");
    expect(screen.queryByRole("button", { name: "Load more events" })).toBeNull();
    expect(server.calls.at(-1)?.url.searchParams.get("cursor")).toBe("page-2");
  });

  it("builds a run from events: totals and pull requests", () => {
    const run = runFromEvents("sess-1", events as never);
    expect(run.run).toMatchObject({
      agent: { vendor: "claude_code" },
      model: "claude-sonnet-4-5",
      person: "ada@example.com",
      repo: "acme/api",
      cost_usd: 0.25,
      tokens: 1500,
      // The request reported no cache tokens: unknown, not 0.
      cache_hit_rate: null,
      started_at: "2026-11-08T10:00:00.000Z",
      ended_at: null,
    });
    expect(run.prs).toEqual([{ url: "https://github.com/acme/api/pull/7", state: "open" }]);
  });
});

describe("integrations", () => {
  const report = {
    schema: "selfhost.integrations/v1",
    team: "web",
    integrations: {
      router: {
        tool: "bifrost",
        status: "connected",
        detail: "Bifrost 1.2 at bifrost:8080",
        settings: {},
      },
      tracer: {
        tool: "langfuse",
        status: "error",
        detail: "LANGFUSE_KEY is not set on the server",
        settings: { endpoint: "https://langfuse.example.com/api/public/otel" },
      },
      runtime: { tool: null, status: "not_configured", detail: "", settings: {} },
      reviewer: { tool: null, status: "not_configured", detail: "", settings: {} },
    },
  };

  it("says so when the server has no integrations route yet", async () => {
    mockServer({});
    renderConsole(OWNER, "?screen=integrations");
    await screen.findByText("Integrations are not on this server yet");
  });

  it("shows each job's tool and status, and lets owners change one", async () => {
    const server = mockServer({
      "GET /v1/integrations": report,
      "PUT /v1/integrations/runtime": report,
    });
    renderConsole(OWNER, "?screen=integrations");
    const cards = await screen.findAllByTestId("integration");
    expect(within(cards[0] as HTMLElement).getByText("Bifrost")).toBeTruthy();
    expect(within(cards[0] as HTMLElement).getByText("Connected")).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText("Error")).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText(/LANGFUSE_KEY/)).toBeTruthy();
    const runtime = within(cards[2] as HTMLElement);
    expect(runtime.getByText("Not set up")).toBeTruthy();
    fireEvent.click(runtime.getByRole("button", { name: "Pick a tool" }));
    fireEvent.pointerDown(runtime.getByRole("combobox"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: "E2B" }));
    fireEvent.change(runtime.getByLabelText("API key variable"), {
      target: { value: "E2B_API_KEY" },
    });
    fireEvent.click(runtime.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.calls.find((c) => c.method === "PUT")?.body).toEqual({
        tool: "e2b",
        settings: { api_key_env: "E2B_API_KEY" },
      }),
    );
  });

  it("is read-only for members", async () => {
    mockServer({ "GET /v1/integrations": report });
    renderConsole(MEMBER, "?screen=integrations");
    await screen.findAllByTestId("integration");
    expect(screen.queryByRole("button", { name: /Change|Pick a tool/ })).toBeNull();
  });
});
