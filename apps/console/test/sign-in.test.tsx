// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import { mockServer } from "./harness";

const REFUSED = { status: 401, message: "Unknown token" };

describe("signing in", () => {
  it("shows a visitor with a link how to get access, not a token error they never made", async () => {
    // A token this browser kept from an earlier visit, which this server does not take.
    localStorage.setItem("selfhost.token", "selfhost_old");
    window.history.replaceState(null, "", "/?screen=run&run=5f0c2b1e");
    mockServer({ "GET /v1/me": REFUSED });
    render(<App />);
    await screen.findByText(/This link opens a page of a selfhost server/);
    expect(screen.getByText(/Not in the team yet\?/)).toBeTruthy();
    expect(screen.queryByText("That token is not valid on this server.")).toBeNull();
    expect(localStorage.getItem("selfhost.token")).toBeNull();
  });

  it("says a token typed into the form is not valid", async () => {
    window.history.replaceState(null, "", "/");
    mockServer({ "GET /v1/me": REFUSED });
    render(<App />);
    const input = await screen.findByLabelText("API token");
    expect(screen.queryByText(/This link opens/)).toBeNull();
    fireEvent.change(input, { target: { value: "selfhost_typo" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("That token is not valid on this server.");
  });

  it("offers GitHub and Google on a hosted server", async () => {
    window.history.replaceState(null, "", "/");
    mockServer({
      "GET /v1/me": REFUSED,
      "GET /v1/hosted": {
        schema: "selfhost.hosted/v1",
        providers: ["github", "google"],
        free_seats: 10,
        retention_days: 30,
        max_events: 1000000,
        paid_plan: { notice: "More people need the paid plan.", url: null },
      },
    });
    render(<App />);
    const github = await screen.findByRole("link", { name: "Continue with GitHub" });
    expect(github.getAttribute("href")).toBe("/v1/hosted/signin?provider=github");
    expect(screen.getByRole("link", { name: "Continue with Google" })).toBeTruthy();
    expect(screen.getByText(/free for up to 10 people/)).toBeTruthy();
  });

  it("offers only the token on a self-hosted server", async () => {
    window.history.replaceState(null, "", "/");
    mockServer({ "GET /v1/me": REFUSED });
    render(<App />);
    await screen.findByLabelText("API token");
    expect(screen.queryByText(/Continue with/)).toBeNull();
  });
});
