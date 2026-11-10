// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SoloResponse } from "../src/lib/contracts";
import { parseView } from "../src/lib/view";
import { REVIEW_PAGE, USAGE } from "./fixtures";
import { ADMIN, mockServer, renderConsole } from "./harness";

const SOLO: SoloResponse = {
  schema: "selfhost.solo/v1",
  team_init: "selfhost team init",
  policy: {
    path: "/home/dev/acme/selfhost.toml",
    valid: true,
    rules: [
      { id: "no-env-files", mode: "observe", action: "block", message: "No .env files." },
      { id: "no-npm-publish", mode: "enforce", action: "block", message: "CI publishes." },
    ],
    guardrails: { mode: "enforce", disable: [] },
    integrations: { runtime: { tool: "e2b" } },
  },
};

const solo = (extra: Record<string, unknown> = {}) =>
  mockServer({
    "GET /v1/orgs/default/overview": { teams: [] },
    "GET /v1/solo": SOLO,
    "GET /v1/usage": USAGE,
    "GET /v1/review-items": REVIEW_PAGE,
    ...extra,
  });

describe("the console in solo mode", () => {
  it("shows the laptop's own rules, read-only", async () => {
    solo();
    renderConsole(ADMIN, "?screen=rules");
    await screen.findByText("no-env-files");
    expect(screen.getByText("no-npm-publish")).toBeTruthy();
    expect(screen.getByText("/home/dev/acme/selfhost.toml")).toBeTruthy();
    expect(screen.queryByText("No team on this server yet")).toBeNull();
    expect(screen.queryByRole("button", { name: /Start blocking|Turn on/ })).toBeNull();
  });

  it("shows the laptop's integrations and says how to start a team", async () => {
    solo();
    const { go } = renderConsole(ADMIN, "?screen=integrations");
    await screen.findByText("E2B");
    go(parseView("?screen=team"));
    await screen.findByText("You are solo");
    expect(screen.getByText("selfhost team init")).toBeTruthy();
  });

  it("counts the laptop's rules on the overview", async () => {
    solo();
    renderConsole(ADMIN, "");
    await screen.findByText("2 rules in this laptop's selfhost.toml, 1 recording only");
  });

  it("keeps the no-team state on a team server, which has no /v1/solo", async () => {
    mockServer({ "GET /v1/orgs/default/overview": { teams: [] } });
    renderConsole(ADMIN, "?screen=team");
    await screen.findByText("No team on this server yet");
  });
});
