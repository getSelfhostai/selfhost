// @vitest-environment jsdom
import type { Handoff, RunHandoff } from "@selfhost/schema";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { eventLine, runFromEvents } from "../src/components/screens/run";
import { REVIEW_PAGE } from "./fixtures";
import { MEMBER, mockServer, OWNER, renderConsole } from "./harness";

const RUN = "5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87";

const handedOff = {
  id: "01930c4e-2f1a-7b2c-9d3e-000000000020",
  schema: "selfhost.event/v1",
  ts: "2026-11-08T11:00:00.000Z",
  source: "server",
  kind: "run.handed_off",
  actor: { kind: "person", id: "ada@example.com" },
  session_id: RUN,
  data: {
    v: 1,
    handoff: "01930c4e-2f1a-7b2c-9d3e-000000000021",
    owner: "mia@example.com",
    previous_owner: "ada@example.com",
    branch: "agent/rate-limits",
  },
} as const;

const events = [
  {
    id: "01930c4e-2f1a-7b2c-9d3e-000000000010",
    schema: "selfhost.event/v1",
    ts: "2026-11-08T10:00:00.000Z",
    source: "hook",
    kind: "session.started",
    actor: { kind: "person", id: "ada@example.com" },
    agent: { vendor: "claude_code" },
    repo: "acme/api",
    session_id: RUN,
  },
  handedOff,
];

const history: RunHandoff[] = [
  {
    id: "01930c4e-2f1a-7b2c-9d3e-000000000021",
    from: "ada@example.com",
    to: "mia@example.com",
    by: "ada@example.com",
    at: "2026-11-08T11:00:00.000Z",
    note: "Limits half done, key is [redacted]",
    state: "pending",
    taken_at: null,
  },
];

describe("a handed-over run in the run view", () => {
  it("shows who holds it now, the handoff history and the handoff in the timeline", async () => {
    mockServer({
      "GET /v1/runs/5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87": {
        ...runFromEvents(RUN, events as never),
        handoffs: history,
      },
    });
    renderConsole(OWNER, `?screen=run&run=${RUN}`);
    await screen.findByText("Held by");
    expect(screen.getByText("mia@example.com")).toBeTruthy();
    const section = screen.getByText("Handoffs").closest("section") as HTMLElement;
    expect(within(section).getByText("ada@example.com to mia@example.com")).toBeTruthy();
    expect(within(section).getByText("waiting for takeover")).toBeTruthy();
    expect(within(section).getByText("Limits half done, key is [redacted]")).toBeTruthy();
    expect(screen.getByText("Handed from ada@example.com to mia@example.com")).toBeTruthy();
  });

  it("reads the owner from the run's events on servers without the run route", () => {
    expect(runFromEvents(RUN, events as never).run).toMatchObject({
      person: "ada@example.com",
      owner: "mia@example.com",
    });
    expect(eventLine(handedOff as never)).toEqual({
      title: "Handed from ada@example.com to mia@example.com",
      detail: "Branch agent/rate-limits",
    });
  });

  it("shows an access error and nothing of the run to someone outside its team", async () => {
    mockServer({
      "GET /v1/runs/5f0c2b1e-7d4a-4c8e-9a51-3e2d1c0b9a87": {
        status: 403,
        message: `No run ${RUN} in a team you can read.`,
      },
    });
    renderConsole(MEMBER, `?screen=run&run=${RUN}`);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(`No run ${RUN} in a team you can read.`);
    expect(screen.queryByText("Timeline")).toBeNull();
    expect(screen.queryByText("Held by")).toBeNull();
  });
});

describe("runs handed to the signed-in person on the review list", () => {
  const handoff = {
    schema: "selfhost.handoff/v1",
    id: "01930c4e-2f1a-7b2c-9d3e-000000000021",
    run_id: RUN,
    team: "web",
    repo: "acme/api",
    agent: { vendor: "claude_code" },
    from: "ada@example.com",
    to: "mia@example.com",
    by: "ada@example.com",
    created_at: "2026-11-08T11:00:00.000Z",
    note: "Limits half done",
    branch: "agent/rate-limits",
    commit: null,
    pushed: true,
    uncommitted: [],
    files: [],
    open_items: [],
    cost_usd: 1.5,
    tokens: 100,
    turns: [],
    transcript: null,
    state: "pending",
    taken_at: null,
    event_id: "01930c4e-2f1a-7b2c-9d3e-000000000020",
    run_url: `https://selfhost.example.com/?screen=run&run=${RUN}`,
  } satisfies Handoff;

  it("lists them with the run link and the takeover command", async () => {
    const server = mockServer({
      "GET /v1/review-items": REVIEW_PAGE,
      "GET /v1/handoffs": { schema: "selfhost.handoffs/v1", handoffs: [handoff] },
    });
    renderConsole(MEMBER, "?screen=review");
    await screen.findByText("Handed to you");
    expect(screen.getByRole("link", { name: "Run 5f0c2b1e" }).getAttribute("href")).toBe(
      `?screen=run&run=${RUN}`,
    );
    expect(screen.getByText("Limits half done")).toBeTruthy();
    expect(screen.getByText("selfhost takeover 01930c4e")).toBeTruthy();
    const call = server.calls.find((c) => c.path === "/v1/handoffs");
    expect(call?.url.searchParams.get("to")).toBe("me");
    expect(call?.url.searchParams.get("state")).toBe("pending");
  });

  it("shows nothing on servers without handoffs", async () => {
    mockServer({ "GET /v1/review-items": REVIEW_PAGE });
    renderConsole(MEMBER, "?screen=review");
    await screen.findByText(/3 waiting/);
    expect(screen.queryByText("Handed to you")).toBeNull();
  });
});
