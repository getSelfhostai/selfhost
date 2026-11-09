// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { exceptionParts } from "../src/components/screens/review";
import { EXCEPTION, QUESTION, REVIEW_PAGE, RISKY_PR } from "./fixtures";
import { ADMIN, MEMBER, mockServer, OWNER, renderConsole } from "./harness";

const items = async () => {
  await screen.findByText(EXCEPTION.title);
  return screen.getAllByTestId("review-item");
};

describe("the review list", () => {
  it("lists what waits on a person in the server's order, for the person's team", async () => {
    const server = mockServer({ "GET /v1/review-items": REVIEW_PAGE });
    renderConsole(MEMBER, "?screen=review");
    const cards = await items();
    expect(cards.map((card) => card.querySelector("button[aria-expanded]")?.textContent)).toEqual([
      EXCEPTION.title,
      RISKY_PR.title,
      QUESTION.title,
    ]);
    expect(screen.getByText("3 waiting, 2 with an agent blocked.")).toBeTruthy();
    const call = server.calls.find((c) => c.path === "/v1/review-items");
    expect(call?.url.searchParams.get("team")).toBe("web");
    expect(call?.url.searchParams.get("state")).toBe("open");
  });

  it("shows an exception's rule, the blocked call and the alternative", async () => {
    mockServer({ "GET /v1/review-items": REVIEW_PAGE });
    renderConsole(OWNER, "?screen=review");
    const [card] = await items();
    const scoped = within(card as HTMLElement);
    expect(scoped.getByText("no-force-push")).toBeTruthy();
    expect(scoped.getByText("git push --force origin main")).toBeTruthy();
    expect(scoped.getByText("Open a pull request instead.")).toBeTruthy();
    expect(scoped.getByText("Agent waiting")).toBeTruthy();
    expect(exceptionParts(EXCEPTION)).toMatchObject({
      rule: "no-force-push",
      call: "git push --force origin main",
      instead: "Open a pull request instead.",
    });
  });

  it("approves through the decision API and takes the item off the list", async () => {
    const server = mockServer({
      "GET /v1/review-items": REVIEW_PAGE,
      [`POST /v1/review-items/${EXCEPTION.id}/decision`]: { item: EXCEPTION, decision_event: {} },
    });
    renderConsole(OWNER, "?screen=review");
    const [card] = await items();
    const scoped = within(card as HTMLElement);
    fireEvent.change(scoped.getByLabelText("Reason"), { target: { value: "Release branch" } });
    fireEvent.click(scoped.getByRole("button", { name: "Approve" }));
    await screen.findByText(/Approved: Allow once.*Recorded in the decision log\./);
    const post = server.calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ verdict: "approve", reason: "Release branch" });
    expect(screen.queryByText(EXCEPTION.title)).toBeNull();
  });

  it("decides as admin with the admin token, and says when someone answered first", async () => {
    const server = mockServer({
      "GET /v1/review-items": REVIEW_PAGE,
      [`POST /v1/review-items/${RISKY_PR.id}/decision`]: {
        status: 409,
        message: "Already answered by bob@example.com: approve",
      },
    });
    renderConsole(ADMIN, "?screen=review");
    const cards = await items();
    fireEvent.click(within(cards[1] as HTMLElement).getByRole("button", { name: "Deny" }));
    await screen.findByText("Not recorded: Already answered by bob@example.com: approve");
    expect(server.calls.find((c) => c.method === "POST")?.body).toEqual({
      verdict: "deny",
      by: "admin",
    });
    // The admin token reads every team's items.
    expect(server.calls[0]?.url.searchParams.has("team")).toBe(false);
  });

  it("answers a question with the text typed", async () => {
    const server = mockServer({
      "GET /v1/review-items": REVIEW_PAGE,
      [`POST /v1/review-items/${QUESTION.id}/decision`]: { item: QUESTION, decision_event: {} },
    });
    renderConsole(OWNER, "?screen=review");
    const cards = await items();
    const scoped = within(cards[2] as HTMLElement);
    expect(scoped.queryByRole("button", { name: "Approve" })).toBeNull();
    const send = scoped.getByRole("button", { name: "Send answer" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(scoped.getByLabelText("Answer"), { target: { value: "eu-west-1" } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(server.calls.find((c) => c.method === "POST")?.body).toEqual({
        verdict: "answer",
        reason: "eu-west-1",
      }),
    );
  });

  it("snoozes an item until the time picked", async () => {
    const server = mockServer({
      "GET /v1/review-items": REVIEW_PAGE,
      [`POST /v1/review-items/${RISKY_PR.id}/snooze`]: RISKY_PR,
    });
    renderConsole(OWNER, "?screen=review");
    const cards = await items();
    const trigger = within(cards[1] as HTMLElement).getByRole("combobox", { name: "Snooze" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "Snooze 1 day" }));
    await screen.findByText(`Snoozed for 1 day: ${RISKY_PR.title}.`);
    expect(server.calls.find((c) => c.method === "POST")?.body).toEqual({
      until: "2026-11-09T12:00:00.000Z",
    });
  });

  it("links an item to its run", async () => {
    mockServer({ "GET /v1/review-items": REVIEW_PAGE });
    renderConsole(OWNER, "?screen=review");
    const cards = await items();
    const card = within(cards[1] as HTMLElement);
    fireEvent.click(card.getByRole("button", { name: RISKY_PR.title }));
    const link = card.getByRole("link", { name: "Open the run" });
    expect(link.getAttribute("href")).toBe("?screen=run&run=run-7");
  });

  it("links to the tracer when the item carries a trace link", async () => {
    const traced = { ...RISKY_PR, trace_url: "https://langfuse.example.com/trace/run-7" };
    mockServer({ "GET /v1/review-items": { items: [traced], next_cursor: null } });
    renderConsole(OWNER, "?screen=review");
    fireEvent.click(await screen.findByRole("button", { name: RISKY_PR.title }));
    const link = screen.getByRole("link", { name: "Open in your tracer" });
    expect(link.getAttribute("href")).toBe("https://langfuse.example.com/trace/run-7");
  });

  it("says when nothing is waiting", async () => {
    mockServer({ "GET /v1/review-items": { items: [], next_cursor: null } });
    renderConsole(OWNER, "?screen=review");
    await screen.findByText("Nothing is waiting on a person.");
  });
});

describe("routes on review items", () => {
  it("shows the route that took each item, what it matched and when it moves on", async () => {
    const routed = {
      ...RISKY_PR,
      owners: ["backup-dba@example.com", "dba@example.com"],
      route: {
        step: "route" as const,
        from: '[[review.routes]] "db-backup"',
        id: "db-backup",
        why: "kind pr, path db/schema.sql",
        github: { users: ["bob"], teams: ["dba"] },
        escalated_from: ["db"],
        escalates_at: "2099-01-01T00:00:00.000Z",
      },
    };
    mockServer({
      "GET /v1/review-items": { items: [EXCEPTION, routed, QUESTION], next_cursor: null },
    });
    renderConsole(OWNER, "?screen=review");
    const cards = await items();
    const line = within(cards[1] as HTMLElement).getByTestId("item-route").textContent ?? "";
    expect(line).toMatch(
      /^Routed by \[\[review\.routes\]\] "db-backup": kind pr, path db\/schema\.sql · escalated from db · on GitHub @bob, dba · moves on at .+ if nobody answers$/,
    );
    expect(within(cards[0] as HTMLElement).queryByTestId("item-route")).toBeNull();
  });
});
